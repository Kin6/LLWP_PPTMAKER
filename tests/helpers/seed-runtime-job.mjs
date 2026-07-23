import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifactStore } from "../../server/deck-agent/artifact-store.mjs";
import { createEventStore } from "../../server/deck-agent/event-store.mjs";
import { parseOutline } from "../../server/deck-agent/outline.mjs";
import { createRenderer } from "../../server/deck-agent/renderer.mjs";
import { createRevisionStore } from "../../server/deck-agent/revision-store.mjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const REVISION_ID = /^(?:working|revision-\d{6})$/;
const helperRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(helperRoot, "../..");
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/deck-agent/skill-outline");
const runtimeRoot = path.join(repositoryRoot, "skills/generate-html-deck/assets/runtime");
const COMPLETE_THEME_CSS = ":root{--deck-bg:#ffffff;--deck-surface:#f4f5f7;--deck-text:#111111;--deck-muted:#555555;--deck-primary:#075ccb;--deck-secondary:#243447;--deck-accent:#d9363e;--deck-positive:#14804a;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:72px;--deck-heading-size:48px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:8px;--deck-space:24px;--deck-grid-gap:32px;}";
const PIPELINE = ["outline", "design", "calibrating", "building", "generating-assets", "verifying"];
const STAGE_TITLES = {
  outline: "整理幻灯片内容大纲并写入 Markdown",
  design: "建立单一设计方向",
  calibrating: "校准代表页面",
  building: "生成 HTML 幻灯片页面",
  "generating-assets": "处理页面素材",
  verifying: "检查排版、内容溢出与视觉一致性",
};

const SECURITY_OUTLINE = `# 安全隔离验收

> **叙事主线：** 隔离边界 -> 可验证交付

## 幻灯片 1：预览边界

**核心观点：** 演示内容只能在受限预览环境中运行。

**演讲备注：** 验证父页面状态和浏览器能力保持隔离。

**材料来源：**

- 《调研报告》第 3 页 <!-- source:block-018 -->

## 幻灯片 2：离线交付

**核心观点：** 独立文件无需网络即可完成演示。

**演讲备注：** 验证导航、图表和内容均在文件内封装。

**材料来源：**

- 《调研报告》第 8 页 <!-- source:block-031 -->
`;

function assertSeedArguments(rootDir, jobId) {
  if (typeof rootDir !== "string" || !rootDir || !JOB_ID.test(jobId)) {
    throw new Error("A root directory and valid deck job id are required");
  }
}

async function sourceBlocksFixture() {
  return JSON.parse(await fs.readFile(path.join(fixtureRoot, "source-blocks.json"), "utf8"));
}

export async function loadRuntimeFixture(name) {
  const sourceBlocks = await sourceBlocksFixture();
  if (name === "dense-report") {
    return {
      name,
      markdown: await fs.readFile(path.join(fixtureRoot, "qa-under-budget.md"), "utf8"),
      sourceBlocks,
    };
  }
  if (name === "data-table") {
    return {
      name,
      markdown: await fs.readFile(path.join(fixtureRoot, "slides-content.md"), "utf8"),
      sourceBlocks,
    };
  }
  if (name === "security-fixture") {
    return { name, markdown: SECURITY_OUTLINE, sourceBlocks };
  }
  throw new Error(`Unknown deck E2E fixture: ${name}`);
}

export async function createFixtureJobRequest(name, options = {}) {
  const fixture = await loadRuntimeFixture(name);
  const parsed = parseOutline(fixture.markdown, {
    expectedSlideCount: (fixture.markdown.match(/^## 幻灯片 /gm) || []).length,
    sourceBlockIds: new Set(fixture.sourceBlocks.map((block) => block.id)),
  });
  const slideCount = Math.max(1, Math.min(parsed.slides.length, Number(options.slideCount) || parsed.slides.length));
  const scenario = String(options.scenario || "").trim();
  const imageEnabled = options.imageEnabled === true;
  return {
    source: {
      topic: [parsed.title, scenario].filter(Boolean).join(" "),
      audience: "自动化验收团队",
      slideCount,
      textInput: [fixture.markdown, scenario].filter(Boolean).join("\n\n"),
      tableInput: JSON.stringify(fixture.sourceBlocks.filter((block) => block.type === "table")),
      imageBrief: scenario,
      styleId: "product-calm",
      images: [],
      sourceBlocks: fixture.sourceBlocks,
    },
    options: {
      imageEnabled,
      imageCount: imageEnabled ? Math.min(slideCount, 3) : 0,
      imageQuality: "low",
      imageTimeoutMs: 240_000,
      imageMaxRetries: 1,
    },
  };
}

function chartFor(fixtureName, slideId) {
  if (fixtureName !== "data-table" || slideId !== "slide-02") return [];
  return [{
    chartId: "chart-operating-loss",
    type: "bar",
    labels: ["人工汇总", "质量追溯", "计划同步"],
    series: [{ name: "损失指数", values: [82, 63, 48], colorToken: "primary" }],
  }];
}

function slideHtml(slide, index, fixtureName, asset) {
  const sourceLabel = slide.sourceBlockIds.join(" / ");
  const chart = chartFor(fixtureName, slide.slideId);
  const visual = index === 0 && asset
    ? `<figure class="visual"><img src="asset://${asset.id}" alt="制造运营分析界面参考图"><figcaption>现场证据与经营判断保持对应</figcaption></figure>`
    : chart.length
      ? '<figure class="visual"><div class="chart" data-chart-id="chart-operating-loss" aria-label="三个信息断点造成的损失指数"></div><figcaption>损失指数越高，协同改造优先级越高</figcaption></figure>'
      : `<div class="evidence" role="group" aria-label="本页证据"><strong>${String(index + 1).padStart(2, "0")}</strong><p>${slide.claim}</p><small>${sourceLabel}</small></div>`;
  return `<header class="kicker"><span>DECKFORGE / EVIDENCE</span><small>${String(index + 1).padStart(2, "0")}</small></header><section class="layout"><div class="copy"><p class="section-label">关键判断</p><h1>${slide.title}</h1><p class="claim">${slide.claim}</p></div>${visual}</section><footer><span>${sourceLabel}</span><span>智能制造转型方案</span></footer>`;
}

function slideCss(slideId, index) {
  const accent = ["#075ccb", "#d9363e", "#14804a", "#7a4d00"][index % 4];
  return `[data-slide-id="${slideId}"]{width:1920px;height:1080px;padding:72px 88px;background:#f7f8fa;color:#111820;overflow:hidden;display:grid;grid-template-rows:64px 1fr 54px;gap:32px;font-family:Arial,sans-serif}[data-slide-id="${slideId}"] .kicker{display:flex;align-items:center;justify-content:space-between;border-style:solid;border-color:${accent};border-width:0 0 2px;padding-bottom:18px;color:#4b5563;font-size:20px;line-height:1.2}[data-slide-id="${slideId}"] .layout{display:grid;grid-template-columns:1.05fr .95fr;gap:72px;align-items:center;min-height:0}[data-slide-id="${slideId}"] .copy{display:flex;flex-direction:column;justify-content:center;min-width:0}[data-slide-id="${slideId}"] .section-label{margin:0 0 22px;color:${accent};font-size:24px;font-weight:700;line-height:1.2}[data-slide-id="${slideId}"] h1{margin:0 0 34px;font-size:68px;line-height:1.08;font-weight:700;color:#111820}[data-slide-id="${slideId}"] .claim{margin:0;max-width:820px;font-size:31px;line-height:1.45;color:#374151}[data-slide-id="${slideId}"] .evidence{min-height:500px;padding:64px;display:flex;flex-direction:column;justify-content:space-between;background:#ffffff;border:2px solid #d7dce2;border-radius:8px}[data-slide-id="${slideId}"] .evidence strong{font-size:112px;line-height:1;color:${accent}}[data-slide-id="${slideId}"] .evidence p{font-size:32px;line-height:1.42;color:#1f2937}[data-slide-id="${slideId}"] .evidence small{font-size:20px;line-height:1.3;color:#667078}[data-slide-id="${slideId}"] .visual{height:560px;margin:0;padding:30px;display:grid;grid-template-rows:minmax(0,1fr) 36px;gap:18px;background:#ffffff;border:2px solid #d7dce2;border-radius:8px;overflow:hidden}[data-slide-id="${slideId}"] .visual img{width:100%;height:100%;min-width:0;min-height:0;object-fit:contain}[data-slide-id="${slideId}"] .visual .chart{width:100%;height:450px;min-height:450px}[data-slide-id="${slideId}"] figcaption{font-size:20px;line-height:1.3;color:#667078;text-align:center}[data-slide-id="${slideId}"] footer{display:flex;align-items:center;justify-content:space-between;border-style:solid;border-color:#d7dce2;border-width:1px 0 0;padding-top:16px;color:#667078;font-size:18px;line-height:1.2}`;
}

function qaReport(slideIds) {
  return {
    ok: true,
    slides: slideIds.map((slideId) => ({ slideId, issues: [], screenshotArtifactId: null })),
    contactSheetArtifactId: null,
    consoleErrors: [],
  };
}

async function seedWorkingArtifacts({ store, jobId, fixtureName, appOrigin }) {
  const fixture = await loadRuntimeFixture(fixtureName);
  const sourceBlockIds = new Set(fixture.sourceBlocks.map((block) => block.id));
  const expectedSlideCount = (fixture.markdown.match(/^## 幻灯片 /gm) || []).length;
  const outline = parseOutline(fixture.markdown, { expectedSlideCount, sourceBlockIds });
  await store.createJob({
    jobId,
    title: outline.title,
    input: {
      source: {
        topic: outline.title,
        audience: "自动化验收团队",
        slideCount: outline.slides.length,
        textInput: fixture.markdown,
        tableInput: "",
        imageBrief: "",
        styleId: "product-calm",
      },
      options: {
        imageEnabled: false,
        imageCount: 0,
        imageQuality: "low",
        imageTimeoutMs: 240_000,
        imageMaxRetries: 1,
      },
    },
    sourceBlocks: fixture.sourceBlocks,
  });

  const imageBytes = await fs.readFile(path.join(repositoryRoot, "public/style-guides/product-calm.png"));
  const [asset] = await store.persistUploadedAssets(jobId, [{
    name: "fixture-reference.png",
    dataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
    summary: "Deterministic local reference image for browser QA",
  }]);
  const slides = outline.slides.map((slide) => ({
    slideId: slide.slideId,
    title: slide.title,
    speakerNotes: slide.speakerNotes,
    sourceRefs: slide.sourceBlockIds,
    density: slide.densityScore > 1_000 ? "tight" : "normal",
    status: "done",
    charts: chartFor(fixtureName, slide.slideId),
    assetSlots: [],
  }));
  const slideIds = slides.map((slide) => slide.slideId);
  await store.writeArtifact(jobId, "slides-content.md", fixture.markdown);
  await store.writeArtifact(jobId, "design-brief.md", "# Evidence-led operating review\n\nOne restrained direction with high-contrast hierarchy, explicit source cues, and semantic chart colors.\n");
  await store.writeJson(jobId, "working/manifest.json", {
    version: 1,
    title: outline.title,
    assets: [asset],
    slides,
  });
  await store.writeArtifact(jobId, "working/theme.css", COMPLETE_THEME_CSS);
  for (const [index, slide] of outline.slides.entries()) {
    await store.writeArtifact(jobId, `working/slides/${slide.slideId}.html`, slideHtml(slide, index, fixtureName, asset));
    await store.writeArtifact(jobId, `working/slides/${slide.slideId}.css`, slideCss(slide.slideId, index));
  }
  const qa = qaReport(slideIds);
  await store.writeJson(jobId, "working/qa/report.json", qa);
  const renderer = createRenderer({ store, runtimeRoot, appOrigin });
  await renderer.verifyRuntime();
  await store.writeArtifact(jobId, "working/dist/index.html", await renderer.assembleStandalone({
    jobId,
    revisionId: "working",
  }));
  return { outline, qa, renderer, slideIds };
}

async function appendPublishedEvents(events, jobId, status, revision) {
  await events.append(jobId, {
    stage: "queued", type: "job", status: "queued", title: "已创建 HTML 幻灯片任务",
  });
  for (const stage of PIPELINE) {
    await events.append(jobId, {
      stage,
      type: stage === "outline" ? "artifact" : "stage",
      status: "done",
      title: STAGE_TITLES[stage],
      ...(stage === "outline" ? { artifactId: "slides-content" } : {}),
      ...(stage === "building" ? { progress: { completed: 1, total: 1 } } : {}),
    });
  }
  await events.append(jobId, {
    stage: status,
    type: "job",
    status: "done",
    title: status === "needs-review" ? "演示文稿需要复核" : "交付 HTML 演示文稿",
    revision,
  });
}

export async function seedPublishedRuntimeJob({
  rootDir,
  jobId,
  appOrigin,
  fixtureName = "data-table",
  status = "ready",
} = {}) {
  assertSeedArguments(rootDir, jobId);
  if (typeof appOrigin !== "string" || !appOrigin) throw new Error("A valid app origin is required");
  if (!["ready", "needs-review"].includes(status)) throw new Error("Published fixture status is invalid");
  const store = createArtifactStore({ rootDir: path.resolve(rootDir) });
  const events = createEventStore({ store });
  const revisions = createRevisionStore({ store });
  const seeded = await seedWorkingArtifacts({ store, jobId, fixtureName, appOrigin });
  const published = await revisions.createInitial(jobId, { status, qa: seeded.qa });
  await store.updateJob(jobId, { status, checkpoints: PIPELINE });
  await appendPublishedEvents(events, jobId, status, published.number);
  return {
    ok: true,
    rootDir: path.resolve(rootDir),
    jobId,
    revision: published.number,
    revisionId: published.revisionId,
    status,
    slideIds: seeded.slideIds,
  };
}

export async function seedRuntimeJob(rootDir, jobId, revisionId) {
  assertSeedArguments(rootDir, jobId);
  if (!REVISION_ID.test(revisionId)) {
    throw new Error("Usage: seed-runtime-job.mjs <root> <job-id> <working|revision-NNNNNN>");
  }
  if (revisionId !== "working" && revisionId !== "revision-000001") {
    throw new Error("The production revision store can only seed revision-000001 as an initial publication");
  }
  if (revisionId === "revision-000001") {
    return seedPublishedRuntimeJob({
      rootDir,
      jobId,
      appOrigin: "http://127.0.0.1:5173",
      fixtureName: "data-table",
    });
  }
  const store = createArtifactStore({ rootDir: path.resolve(rootDir) });
  const seeded = await seedWorkingArtifacts({
    store,
    jobId,
    fixtureName: "data-table",
    appOrigin: "http://127.0.0.1:5173",
  });
  return {
    ok: true,
    rootDir: path.resolve(rootDir),
    jobId,
    revisionId,
    slideIds: seeded.slideIds,
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  seedRuntimeJob(...process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 500) })}\n`);
      process.exitCode = 1;
    },
  );
}
