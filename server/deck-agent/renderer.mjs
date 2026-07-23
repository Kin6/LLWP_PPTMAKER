import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateSlideCss, validateThemeCss } from "./css-policy.mjs";
import { validateStoredSlideHtml } from "./html-policy.mjs";
import { buildRuntimeDocument, escapeHtml } from "./runtime-template.mjs";

const REVISION_ID = /^revision-\d{6}$/;
const CANDIDATE_ID = /^\.candidate-[0-9a-f-]+$/;
const QA_FILENAME = /^(?=.{1,160}$)[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.(?:json|png|html)$/;
const ASSET_FILENAME = /^[a-z0-9-]+\.(?:png|jpe?g|webp)$/;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const COLOR_TOKENS = Object.freeze({
  primary: "#075ccb",
  secondary: "#243447",
  accent: "#d9363e",
  positive: "#14804a",
  negative: "#b42318",
});

const STANDALONE_THIRD_PARTY_NOTICE = `Reveal.js 6.0.1
Copyright (C) 2011-2026 Hakim El Hattab and reveal.js contributors
MIT License
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to inclusion of the copyright and permission notices. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

Apache ECharts 6.1.0
Copyright 2017-2026 The Apache Software Foundation
Apache License 2.0
This product includes software developed at The Apache Software Foundation. The complete Apache License 2.0 and applicable subcomponent terms are retained with the project distribution in THIRD_PARTY_NOTICES.md and the package license files.`;

const runtimeRecordSchema = z.object({
  package: z.string().min(1).max(100),
  version: z.string().min(1).max(40),
  relativePath: z.string().min(1).max(500),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const runtimeManifestSchema = z.object({
  version: z.literal(1),
  files: z.array(runtimeRecordSchema).length(5),
}).strict();

const assetSchema = z.object({
  id: z.string().regex(/^asset-[a-z0-9-]+$/),
  filename: z.string().regex(ASSET_FILENAME),
  mimeType: z.string().refine((value) => MIME_TYPES.has(value), "Unsupported asset MIME type"),
}).passthrough();
const chartSeriesSchema = z.object({
  name: z.string().max(120),
  values: z.array(z.number().finite()).max(40),
  colorToken: z.enum(["primary", "secondary", "accent", "positive", "negative"]),
}).strict();
const chartSchema = z.object({
  chartId: z.string().regex(/^chart-[a-z0-9-]+$/),
  type: z.enum(["bar", "line", "pie", "scatter"]),
  labels: z.array(z.string().max(120)).max(40),
  series: z.array(chartSeriesSchema).min(1).max(8),
}).strict();
const slideSchema = z.object({
  slideId: z.string().regex(/^slide-\d{2}$/),
  title: z.string().max(500).default(""),
  speakerNotes: z.string().min(1).max(10_000),
  sourceRefs: z.array(z.string().min(1).max(160)).max(100).optional(),
  sourceBlockIds: z.array(z.string().min(1).max(160)).max(100).optional(),
  density: z.enum(["normal", "tight"]).optional(),
  status: z.string().max(40).optional(),
  charts: z.array(chartSchema).max(6).default([]),
  assetSlots: z.array(z.unknown()).max(6).default([]),
}).passthrough().transform((slide, context) => {
  const sourceRefs = slide.sourceRefs || slide.sourceBlockIds;
  if (!sourceRefs) {
    context.addIssue({ code: "custom", message: "Slide sourceRefs are required" });
    return z.NEVER;
  }
  return { ...slide, sourceRefs };
});
const deckManifestSchema = z.object({
  version: z.number().int().positive().optional(),
  title: z.string().max(500).optional(),
  assets: z.array(assetSchema).max(100).default([]),
  slides: z.array(slideSchema).min(1).max(50),
}).passthrough();

const SERVICE_RUNTIME = `/* deck-runtime:start */
(() => {
  const template = document.getElementById("deck-chart-data");
  const chartEntries = JSON.parse(template.content.textContent || "[]");
  const renderCharts = () => {
    for (const entry of chartEntries) {
      const target = document.querySelector(\`[data-chart-id="\${CSS.escape(entry.chartId)}"]\`);
      if (!target || target.dataset.chartReady === "true") continue;
      echarts.init(target, null, { renderer: "canvas" }).setOption(entry.option, { notMerge: true, lazyUpdate: false });
      target.dataset.chartReady = "true";
    }
  };
  const speakerPanel = document.getElementById("deck-speaker-panel");
  const updateSpeakerNotes = (slide) => {
    const notes = slide?.querySelector("aside.notes");
    speakerPanel.textContent = notes?.textContent || "";
  };
  Reveal.on("slidechanged", (event) => updateSpeakerNotes(event.currentSlide));
  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "s" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    speakerPanel.dataset.open = speakerPanel.dataset.open === "true" ? "false" : "true";
  }, true);
  Reveal.initialize({
    width: 1920,
    height: 1080,
    margin: 0,
    minScale: 0.1,
    maxScale: 2,
    controls: true,
    progress: true,
    hash: true,
    center: false,
    transition: "none",
    backgroundTransition: "none"
  }).then(() => {
    renderCharts();
    updateSpeakerNotes(Reveal.getCurrentSlide());
  });
})();
/* deck-runtime:end */`;

function revisionPrefix(revisionId) {
  if (revisionId === "working") return "working";
  if (!REVISION_ID.test(revisionId) && !CANDIDATE_ID.test(revisionId)) throw new Error("Invalid deck revision");
  return `revisions/${revisionId}`;
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) throw new Error("Invalid application origin");
  return url.origin;
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function runtimeRole(record) {
  const normalized = record.relativePath.replaceAll("\\", "/");
  if (record.package === "reveal.js" && normalized.endsWith("/dist/reveal.js")) return "revealJs";
  if (record.package === "reveal.js" && normalized.endsWith("/dist/reveal.css")) return "revealCss";
  if (record.package === "echarts" && normalized.endsWith("/dist/echarts.min.js")) return "echartsJs";
  if (record.package === "deckforge-runtime" && normalized === "base.css") return "baseCss";
  if (record.package === "deckforge-runtime" && normalized === "bridge.js") return "bridgeJs";
  return undefined;
}

async function loadVerifiedRuntime(runtimeRoot) {
  const rootStat = await fs.lstat(runtimeRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Runtime root must be a real directory");
  const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Runtime manifest must be a real file");
  const manifest = runtimeManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  const unique = new Set(manifest.files.map((record) => `${record.package}:${record.relativePath}`));
  if (unique.size !== manifest.files.length) throw new Error("Runtime manifest contains duplicate files");

  const files = {};
  for (const record of manifest.files) {
    if (path.isAbsolute(record.relativePath) || record.relativePath.includes("\0") || record.relativePath.includes("\\")) {
      throw new Error("Invalid runtime manifest path");
    }
    const target = path.resolve(runtimeRoot, record.relativePath);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Runtime files must be regular files");
    const bytes = await fs.readFile(target);
    if (digest(bytes) !== record.sha256) throw new Error(`Runtime hash mismatch: ${record.relativePath}`);
    const role = runtimeRole(record);
    if (role) files[role] = bytes.toString("utf8");
  }
  const missing = ["revealJs", "revealCss", "echartsJs", "baseCss", "bridgeJs"].filter((role) => !files[role]);
  if (missing.length) throw new Error(`Runtime manifest is missing pinned files: ${missing.join(", ")}`);
  return files;
}

function sanitizeRuntimeUrls(source) {
  return source.replaceAll("https://", "https:\\u002f\\u002f").replaceAll("http://", "http:\\u002f\\u002f");
}

function resolveBridge(source, { jobId, revisionId, appOrigin }) {
  if (!REVISION_ID.test(revisionId)) throw new Error("Preview bridge requires a published revision");
  const revision = Number(revisionId.slice("revision-".length));
  return source
    .replaceAll('"__JOB_ID__"', JSON.stringify(jobId))
    .replaceAll("__REVISION__", JSON.stringify(revision))
    .replaceAll('"__PARENT_ORIGIN__"', JSON.stringify(appOrigin));
}

function buildChartOption(chart) {
  const palette = chart.series.map((series) => COLOR_TOKENS[series.colorToken]);
  if (chart.type === "pie") {
    return {
      animation: false,
      color: palette,
      tooltip: { show: false },
      series: chart.series.map((series) => ({
        name: series.name,
        type: "pie",
        radius: ["36%", "68%"],
        data: chart.labels.map((label, index) => ({ name: label, value: series.values[index] ?? 0 })),
      })),
    };
  }
  const scatter = chart.type === "scatter";
  return {
    animation: false,
    color: palette,
    tooltip: { show: false },
    xAxis: { type: scatter ? "value" : "category", data: scatter ? undefined : chart.labels },
    yAxis: { type: "value" },
    series: chart.series.map((series) => ({
      name: series.name,
      type: chart.type,
      data: scatter ? series.values.map((value, index) => [index, value]) : series.values,
    })),
  };
}

function ensureUniqueManifest(manifest) {
  const slideIds = manifest.slides.map((slide) => slide.slideId);
  if (new Set(slideIds).size !== slideIds.length) throw new Error("Duplicate slide identity in manifest");
  const chartIds = manifest.slides.flatMap((slide) => slide.charts.map((chart) => chart.chartId));
  if (new Set(chartIds).size !== chartIds.length) throw new Error("Duplicate chart identity in manifest");
  const assetIds = manifest.assets.map((asset) => asset.id);
  if (new Set(assetIds).size !== assetIds.length) throw new Error("Duplicate asset identity in manifest");
  return manifest;
}

function artifactIdFor(relativePath) {
  const extension = path.extname(relativePath);
  return relativePath.slice(0, -extension.length).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function createRenderer({ store, runtimeRoot, appOrigin }) {
  if (!store || typeof store.readArtifact !== "function" || typeof store.readJson !== "function") {
    throw new TypeError("Renderer requires an artifact store");
  }
  if (typeof runtimeRoot !== "string" || !runtimeRoot) throw new TypeError("Renderer requires runtimeRoot");
  const origin = normalizeOrigin(appOrigin);
  let runtimePromise;

  function verifyRuntime() {
    runtimePromise ||= loadVerifiedRuntime(path.resolve(runtimeRoot));
    return runtimePromise;
  }

  async function readManifest({ jobId, revisionId }) {
    const prefix = revisionPrefix(revisionId);
    const parsed = deckManifestSchema.parse(await store.readJson(jobId, `${prefix}/manifest.json`));
    return ensureUniqueManifest(parsed);
  }

  async function readAssets(jobId, manifest) {
    const jobInput = await store.readJson(jobId, "job-input.json", { optional: true }) || {};
    const combined = [...(Array.isArray(jobInput.uploadedAssets) ? jobInput.uploadedAssets : []), ...manifest.assets];
    const assets = new Map();
    for (const raw of combined) {
      const asset = assetSchema.parse(raw);
      const previous = assets.get(asset.id);
      if (previous && (previous.filename !== asset.filename || previous.mimeType !== asset.mimeType)) {
        throw new Error(`Conflicting asset metadata: ${asset.id}`);
      }
      assets.set(asset.id, asset);
    }
    return assets;
  }

  async function assemble({ jobId, revisionId, mode }) {
    const [runtime, manifest, sourceBlocks] = await Promise.all([
      verifyRuntime(),
      readManifest({ jobId, revisionId }),
      store.readJson(jobId, "source-blocks.json"),
    ]);
    const prefix = revisionPrefix(revisionId);
    const assets = await readAssets(jobId, manifest);
    const sourceBlockIds = new Set((Array.isArray(sourceBlocks) ? sourceBlocks : [])
      .map((block) => block?.id || block?.source?.blockId)
      .filter((id) => typeof id === "string" && id));
    const activeSlides = manifest.slides.filter((slide) => slide.status !== "pending");
    if (!activeSlides.length) throw new Error("Manifest has no assembled slides");

    const slideMarkup = [];
    const slideCss = [];
    const chartData = [];
    for (const slide of activeSlides) {
      const [storedHtml, storedCss] = await Promise.all([
        store.readArtifact(jobId, `${prefix}/slides/${slide.slideId}.html`),
        store.readArtifact(jobId, `${prefix}/slides/${slide.slideId}.css`),
      ]);
      const html = validateStoredSlideHtml({
        html: storedHtml,
        slideId: slide.slideId,
        sourceRefs: slide.sourceRefs,
        sourceBlockIds,
        assetIds: new Set(assets.keys()),
      }).html;
      const css = validateSlideCss({ css: storedCss, slideId: slide.slideId }).css;
      const usedAssets = [...html.matchAll(/asset:\/\/([a-z0-9-]+)/g)].map((match) => match[1]);
      const resolved = new Map();
      for (const assetId of usedAssets) {
        const asset = assets.get(assetId);
        if (!asset) throw new Error(`Unknown manifest asset: ${assetId}`);
        if (mode === "preview") {
          resolved.set(assetId, `${origin}/api/html-deck/jobs/${jobId}/artifacts/${assetId}`);
        } else {
          const bytes = await store.readArtifact(jobId, `assets/${asset.filename}`, { encoding: null });
          resolved.set(assetId, `data:${asset.mimeType};base64,${bytes.toString("base64")}`);
        }
      }
      const resolvedHtml = html.replace(/asset:\/\/([a-z0-9-]+)/g, (_match, assetId) => resolved.get(assetId));
      const sourceRefs = [...new Set(slide.sourceRefs)].join(" ");
      const density = slide.density === "tight" ? ' data-density="tight"' : "";
      slideMarkup.push(`<section aria-label="${escapeHtml(slide.title)}"><article class="deck-slide" data-slide-root data-slide-id="${slide.slideId}" data-source-refs="${escapeHtml(sourceRefs)}"${density}>${resolvedHtml}<aside class="notes">${escapeHtml(slide.speakerNotes)}</aside></article></section>`);
      slideCss.push(css);
      for (const chart of slide.charts) chartData.push({ chartId: chart.chartId, option: buildChartOption(chart) });
    }

    const themeCss = validateThemeCss(await store.readArtifact(jobId, `${prefix}/theme.css`));
    const styles = [runtime.revealCss, runtime.baseCss, themeCss, ...slideCss].join("\n");
    const fixedScripts = [runtime.revealJs, runtime.echartsJs, SERVICE_RUNTIME].map(sanitizeRuntimeUrls);
    if (mode === "preview") fixedScripts.push(resolveBridge(runtime.bridgeJs, {
      jobId,
      revisionId,
      appOrigin: origin,
    }));
    const script = fixedScripts.join(";\n");
    return buildRuntimeDocument({
      title: manifest.title || "Deck",
      styles,
      script,
      slidesHtml: slideMarkup.join(""),
      chartData,
      assetOrigin: mode === "preview" ? origin : undefined,
      notice: mode === "standalone" ? STANDALONE_THIRD_PARTY_NOTICE : undefined,
    });
  }

  async function writeQaArtifact({ jobId, revisionId, filename, data, signal }) {
    if (typeof filename !== "string" || !QA_FILENAME.test(filename)) throw new Error("Invalid QA artifact filename");
    const relativePath = `${revisionPrefix(revisionId)}/qa/${filename}`;
    await store.writeArtifact(jobId, relativePath, data, { signal });
    return { artifactId: artifactIdFor(relativePath), relativePath };
  }

  return {
    verifyRuntime,
    readManifest,
    writeQaArtifact,
    assemblePreview: (options) => assemble({ ...options, mode: "preview" }),
    assembleStandalone: (options) => assemble({ ...options, mode: "standalone" }),
  };
}
