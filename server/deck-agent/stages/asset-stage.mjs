import { parseFragment, serialize } from "parse5";
import { validateStoredSlideHtml as validateStoredSlideHtmlDefault } from "../html-policy.mjs";

const COMPLETED_ASSET_STATES = new Set(["resolved", "empty"]);
const SLIDE_ID = /^slide-\d{2}$/;
const SLOT_ID = /^[a-z0-9-]+$/;

export function createGenerationBudget({ enabled, limit }) {
  if (typeof enabled !== "boolean") throw new TypeError("Image generation enabled must be boolean");
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Image generation limit must be nonnegative");
  let used = 0;
  return Object.freeze({
    take() {
      if (!enabled || used >= limit) return false;
      used += 1;
      return true;
    },
    get used() { return used; },
    get remaining() { return Math.max(0, limit - used); },
  });
}

export async function runAssetStage(context) {
  return resolveAssetSlots(context);
}

export async function resolveAssetSlots(context) {
  if (!context || typeof context !== "object") throw new TypeError("Asset context is required");
  context.signal?.throwIfAborted();
  const manifest = context.manifest
    || await context.store?.readJson?.(context.jobId, "working/manifest.json");
  if (!manifest || !Array.isArray(manifest.slides)) throw new TypeError("Asset stage requires a manifest");

  const options = context.input?.options || context.options || {};
  const generationBudget = context.generationBudget || createGenerationBudget({
    enabled: context.imageEnabled ?? options.imageEnabled ?? false,
    limit: context.imageCount ?? options.imageCount ?? 0,
  });
  if (typeof generationBudget.take !== "function") {
    throw new TypeError("Generation budget requires a take function");
  }

  const stageContext = { ...context, manifest, generationBudget };
  const results = [];
  for (const slide of manifest.slides) {
    if (!SLIDE_ID.test(slide?.slideId) || !Array.isArray(slide.assetSlots)) continue;
    for (const slot of slide.assetSlots) {
      context.signal?.throwIfAborted();
      if (isCompletedAssetSlot(context, slot)) continue;
      const result = await resolveAssetSlot(stageContext, slide, slot);
      applyResolution(slot, result);
      await checkpointAssetSlot(stageContext, slide, slot, result);
      results.push(result);
    }
  }
  return results;
}

export async function resolveAssetSlot(context, slide, slot) {
  assertAssetTarget(slide, slot);
  context.signal?.throwIfAborted();

  const uploaded = matchUploadedAssets(context.uploads || [], slot, context.sourceBlocks || []);
  for (const asset of uploaded) {
    const resolved = await tryPublish(context, asset, slide, slot, "uploaded");
    if (resolved) return resolved;
  }

  const licensed = matchLicensedAssets(context.library || [], slot);
  for (const asset of licensed) {
    const resolved = await tryPublish(context, asset, slide, slot, "licensed");
    if (resolved) return resolved;
  }

  if (context.generationBudget.take()) {
    try {
      const request = buildAssetGenerationRequest(context, slot);
      const generated = await generateAsset(context, request, slide, slot);
      return normalizeResolution(generated, slide, slot, "generated");
    } catch (error) {
      rethrowCancellation(context, error);
      await context.emitAssetFallback?.(slide.slideId, slot.slotId, error);
    }
  }

  return useEmptyAssetSlot(context, slide, slot);
}

export function matchUploadedAsset(uploads, slot, sourceBlocks = []) {
  return matchUploadedAssets(uploads, slot, sourceBlocks)[0];
}

export function matchLicensedAsset(library, slot) {
  return matchLicensedAssets(library, slot)[0];
}

export function buildAssetGenerationRequest(context, slot) {
  const sourceSummaries = relevantSourceSummaries(context.sourceBlocks || [], slot.sourceBlockIds || []);
  const safeArea = normalizeSafeArea(slot.safeArea);
  const purpose = cleanText(slot.purpose, 500);
  const aspectRatio = cleanText(slot.aspectRatio, 20);
  const summaries = sourceSummaries.length
    ? sourceSummaries.map((summary) => `- ${summary}`).join("\n")
    : "- No additional source summary supplied.";
  const prompt = [
    `Create a presentation image for this purpose: ${purpose}`,
    `Aspect ratio: ${aspectRatio}`,
    `Subject safe area (normalized x/y/w/h): ${JSON.stringify(safeArea)}`,
    "Relevant source summaries:",
    summaries,
    "Presentation text is forbidden inside the image. Do not render labels, captions, letters, numbers, logos, watermarks, or interface text.",
  ].join("\n");
  return { purpose, aspectRatio, safeArea, sourceSummaries, prompt };
}

export async function markEmptyAssetSlot(context, slide, slot) {
  assertAssetTarget(slide, slot);
  context.signal?.throwIfAborted();
  const relativePath = `working/slides/${slide.slideId}.html`;
  const rawHtml = typeof context.readSlideHtml === "function"
    ? await context.readSlideHtml(slide.slideId)
    : await context.store?.readArtifact?.(context.jobId, relativePath);
  if (typeof rawHtml !== "string") throw new Error(`Missing stored HTML for ${slide.slideId}`);

  const parseErrors = [];
  const fragment = parseFragment(rawHtml, { onParseError: (error) => parseErrors.push(error) });
  if (parseErrors.length) throw new Error(`Invalid stored HTML syntax: ${parseErrors[0].code}`);
  const matches = [];
  walk(fragment, (node) => {
    if (node.tagName && attributeValue(node, "data-asset-slot") === slot.slotId) matches.push(node);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one exact asset slot ${slot.slotId} in ${slide.slideId}`);
  }

  const target = matches[0];
  setAttribute(target, "data-asset-state", "empty");
  target.childNodes = [];

  const validateStoredSlideHtml = context.validateStoredSlideHtml || validateStoredSlideHtmlDefault;
  const sourceRefs = Array.isArray(slide.sourceBlockIds)
    ? slide.sourceBlockIds
    : Array.isArray(slide.sourceRefs) ? slide.sourceRefs : [];
  const validated = validateStoredSlideHtml({
    html: serialize(fragment),
    slideId: slide.slideId,
    sourceRefs,
    sourceBlockIds: knownSourceBlockIds(context),
    assetIds: knownAssetIds(context, slide),
  });
  context.signal?.throwIfAborted();

  if (typeof context.replaceSlideHtml === "function") {
    await context.replaceSlideHtml(slide.slideId, validated.html, { signal: context.signal });
  } else if (typeof context.store?.writeArtifact === "function") {
    await context.store.writeArtifact(context.jobId, relativePath, validated.html, { signal: context.signal });
  } else {
    throw new TypeError("Asset stage requires an atomic slide HTML writer");
  }
  return { slideId: slide.slideId, slotId: slot.slotId, state: "empty" };
}

async function tryPublish(context, asset, slide, slot, source) {
  try {
    if (typeof context.publishAsset !== "function") {
      throw new TypeError("Asset stage requires publishAsset for local assets");
    }
    const published = await context.publishAsset(asset, slide.slideId, slot.slotId, {
      source,
      signal: context.signal,
    });
    return normalizeResolution(published, slide, slot, source, asset.id);
  } catch (error) {
    rethrowCancellation(context, error);
    await context.emitAssetFallback?.(slide.slideId, slot.slotId, error);
    return undefined;
  }
}

async function generateAsset(context, request, slide, slot) {
  if (typeof context.generateAndPublishAsset === "function") {
    return context.generateAndPublishAsset(
      request,
      { slideId: slide.slideId, slotId: slot.slotId, signal: context.signal },
    );
  }

  const generate = typeof context.generateAsset === "function"
    ? context.generateAsset
    : context.imageClient?.generateAsset?.bind(context.imageClient);
  if (typeof generate !== "function") throw new TypeError("Asset stage requires an image generator");
  const options = context.input?.options || context.options || {};
  const generated = await generate({
    prompt: request.prompt,
    aspectRatio: request.aspectRatio,
    quality: context.imageQuality ?? options.imageQuality,
    timeoutMs: context.imageTimeoutMs ?? options.imageTimeoutMs,
    maxRetries: context.imageMaxRetries ?? options.imageMaxRetries,
    signal: context.signal,
  });
  const publish = typeof context.publishGeneratedAsset === "function"
    ? context.publishGeneratedAsset
    : context.publishAsset;
  if (typeof publish !== "function") throw new TypeError("Asset stage requires a generated asset publisher");
  return publish(generated, slide.slideId, slot.slotId, {
    source: "generated",
    generationRequest: request,
    signal: context.signal,
  });
}

async function useEmptyAssetSlot(context, slide, slot) {
  const result = typeof context.markEmptyAssetSlot === "function"
    ? await context.markEmptyAssetSlot(slide.slideId, slot.slotId, {
      slide,
      slot,
      signal: context.signal,
    })
    : await markEmptyAssetSlot(context, slide, slot);
  return normalizeResolution(result, slide, slot, "empty");
}

async function checkpointAssetSlot(context, slide, slot, result) {
  if (typeof context.checkpointAssetSlot === "function") {
    await context.checkpointAssetSlot(slide.slideId, slot.slotId, result);
    return;
  }
  if (typeof context.store?.writeJson !== "function") {
    throw new TypeError("Asset stage requires checkpointAssetSlot or a JSON artifact store");
  }
  await context.store.writeJson(
    context.jobId,
    "working/manifest.json",
    context.manifest,
    { signal: context.signal },
  );
}

function applyResolution(slot, result) {
  slot.state = result.state;
  slot.status = "done";
  if (result.source && result.source !== "empty") slot.source = result.source;
  else delete slot.source;
  if (result.assetId) slot.assetId = result.assetId;
  else delete slot.assetId;
  slot.resolution = {
    state: result.state,
    ...(result.source && result.source !== "empty" ? { source: result.source } : {}),
    ...(result.assetId ? { assetId: result.assetId } : {}),
  };
}

function normalizeResolution(result, slide, slot, source, fallbackAssetId) {
  const empty = source === "empty" || result?.state === "empty";
  const assetId = cleanOptionalId(result?.assetId || result?.id || fallbackAssetId);
  return {
    slideId: slide.slideId,
    slotId: slot.slotId,
    state: empty ? "empty" : "resolved",
    ...(empty ? {} : { source }),
    ...(assetId ? { assetId } : {}),
  };
}

function matchUploadedAssets(uploads, slot, sourceBlocks) {
  if (!Array.isArray(uploads) || !Array.isArray(slot?.sourceBlockIds)) return [];
  const wantedBlocks = new Set(slot.sourceBlockIds);
  const sourceAssetIds = new Set(sourceBlocks
    .filter((block) => wantedBlocks.has(block?.id))
    .map((block) => block?.assetId)
    .filter(Boolean));
  return uploads.filter((asset) => {
    if (!asset || typeof asset.id !== "string") return false;
    if (sourceAssetIds.has(asset.id)) return true;
    const refs = new Set([
      ...(Array.isArray(asset.sourceBlockIds) ? asset.sourceBlockIds : []),
      ...(Array.isArray(asset.sourceRefs) ? asset.sourceRefs : []),
      asset.sourceBlockId,
      asset.blockId,
      asset.source?.blockId,
    ].filter(Boolean));
    return [...wantedBlocks].some((blockId) => refs.has(blockId));
  });
}

function matchLicensedAssets(library, slot) {
  if (!Array.isArray(library)) return [];
  const purpose = cleanText(slot?.purpose, 500).toLocaleLowerCase();
  const explicitTags = Array.isArray(slot?.tags)
    ? slot.tags.map((tag) => cleanText(tag, 100).toLocaleLowerCase()).filter(Boolean)
    : [];
  return library.filter((asset) => {
    if (!isLicensedCatalogEntry(asset)) return false;
    return asset.tags.some((tag) => {
      const normalized = cleanText(tag, 100).toLocaleLowerCase();
      return normalized && (explicitTags.includes(normalized) || purpose.includes(normalized));
    });
  });
}

function isLicensedCatalogEntry(asset) {
  return typeof asset?.id === "string"
    && typeof asset.file === "string"
    && Array.isArray(asset.tags)
    && asset.tags.length > 0
    && typeof asset.license === "string"
    && asset.license.trim().length > 0
    && typeof asset.sourceUrl === "string"
    && asset.sourceUrl.trim().length > 0
    && typeof asset.sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(asset.sha256)
    && asset.hashVerified !== false;
}

function relevantSourceSummaries(sourceBlocks, sourceBlockIds) {
  const selected = new Set(sourceBlockIds);
  return sourceBlocks.filter((block) => selected.has(block?.id)).map((block) => {
    const summary = block.summary ?? block.text ?? "";
    return `${cleanText(block.id, 120)}: ${cleanText(summary, 500)}`;
  }).filter((summary) => !summary.endsWith(": "));
}

function isCompletedAssetSlot(context, slot) {
  if (typeof context.isAssetSlotComplete === "function") return context.isAssetSlotComplete(slot);
  return COMPLETED_ASSET_STATES.has(slot?.state)
    || COMPLETED_ASSET_STATES.has(slot?.resolution?.state)
    || (slot?.status === "done" && ["resolved", "empty"].includes(slot?.assetState));
}

function knownSourceBlockIds(context) {
  if (context.sourceBlockIds instanceof Set) return new Set(context.sourceBlockIds);
  return new Set((context.sourceBlocks || []).map((block) => block?.id).filter(Boolean));
}

function knownAssetIds(context, slide) {
  if (context.assetIds instanceof Set) return new Set(context.assetIds);
  const ids = new Set();
  for (const collection of [context.uploads, context.library, context.generatedAssets, context.manifest?.assets]) {
    for (const asset of collection || []) if (asset?.id) ids.add(asset.id);
  }
  for (const candidate of slide.assetSlots || []) {
    if (candidate?.assetId) ids.add(candidate.assetId);
    if (candidate?.resolution?.assetId) ids.add(candidate.resolution.assetId);
  }
  return ids;
}

function normalizeSafeArea(value) {
  const safeArea = value && typeof value === "object" ? value : {};
  const normalized = {};
  for (const key of ["x", "y", "w", "h"]) {
    const number = Number(safeArea[key]);
    if (!Number.isFinite(number) || number < 0 || number > 1 || (["w", "h"].includes(key) && number === 0)) {
      throw new Error(`Invalid asset safe area ${key}`);
    }
    normalized[key] = number;
  }
  return normalized;
}

function assertAssetTarget(slide, slot) {
  if (!SLIDE_ID.test(slide?.slideId)) throw new Error("Invalid asset slide identity");
  if (!SLOT_ID.test(slot?.slotId)) throw new Error("Invalid asset slot identity");
}

function rethrowCancellation(context, error) {
  if (context.signal?.aborted || ["AbortError", "JobCancelledError"].includes(error?.name)) throw error;
}

function attributeValue(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function setAttribute(node, name, value) {
  const existing = node.attrs?.find((attribute) => attribute.name === name);
  if (existing) existing.value = value;
  else node.attrs = [...(node.attrs || []), { name, value }];
}

function walk(node, visitor) {
  visitor(node);
  for (const child of node.childNodes || []) walk(child, visitor);
  if (node.content) walk(node.content, visitor);
}

function cleanOptionalId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9-]+$/.test(text) ? text : undefined;
}

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
}
