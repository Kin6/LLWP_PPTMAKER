import { z } from "zod";
import { MODEL_CSS_CONTRACT } from "../css-contract.mjs";
import { MODEL_HTML_CONTRACT } from "../html-contract.mjs";
import { createImagePlan } from "../image-plan.mjs";
import { removeSpeakerNotes } from "../outline.mjs";
import { writeSlideInputSchema } from "../tool-registry.mjs";
import { upstreamCallBudget } from "../upstream-budget.mjs";

const BUILD_PROGRESS_STAGES = new Set(["calibrating", "building", "repairing"]);
const BUILD_STAGE_TITLES = Object.freeze({
  calibrating: "校准代表页面",
  building: "生成 HTML 幻灯片页面",
  repairing: "修复未通过检查的页面",
});
const { $schema: _writeSlideSchemaVersion, ...WRITE_SLIDE_JSON_SCHEMA } = z.toJSONSchema(writeSlideInputSchema);

export function partitionSlideBatches(slideIds) {
  if (!Array.isArray(slideIds)) throw new TypeError("Slide IDs must be an array");
  const batches = [];
  for (let index = 0; index < slideIds.length;) {
    const remaining = slideIds.length - index;
    const size = remaining === 4 ? 2 : Math.min(3, remaining);
    batches.push(slideIds.slice(index, index + size));
    index += size;
  }
  return batches;
}

export async function mapConcurrent(items, limit, worker) {
  if (!Array.isArray(items)) throw new TypeError("Concurrent items must be an array");
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Concurrency limit must be a positive integer");
  }
  if (typeof worker !== "function") throw new TypeError("Concurrent worker must be a function");

  const results = new Array(items.length);
  let cursor = 0;

  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => consume(),
  ));
  return results;
}

export class BatchError extends Error {
  constructor(slideIds, message = "Slide batch failed", options) {
    super(message, options);
    this.name = "BatchError";
    this.slideIds = normalizeSlideIds(slideIds, "Failed slide IDs");
    if (options?.failedSlideId !== undefined) {
      const [failedSlideId] = normalizeSlideIds([options.failedSlideId], "Failed slide ID");
      if (!this.slideIds.includes(failedSlideId)) {
        throw new Error("Failed slide ID must be included in failed slide IDs");
      }
      this.failedSlideId = failedSlideId;
    }
    if (Array.isArray(options?.failures)) {
      this.failures = options.failures.map((failure) => {
        const [slideId] = normalizeSlideIds([failure?.slideId], "Failed slide ID");
        if (!this.slideIds.includes(slideId)) {
          throw new Error("Failed slide ID must be included in failed slide IDs");
        }
        return {
          slideId,
          message: String(failure?.message || "Slide validation failed").replace(/\s+/g, " ").slice(0, 1_000),
        };
      });
    }
  }
}

export function collectFailedSlideIds(results, batches) {
  if (!Array.isArray(results) || !Array.isArray(batches) || results.length !== batches.length) {
    throw new TypeError("Settled results must align with slide batches");
  }
  const failed = new Set();
  results.forEach((result, index) => {
    if (result?.status !== "rejected") return;
    const batch = batches[index];
    const reported = Array.isArray(result.reason?.slideIds)
      ? new Set(result.reason.slideIds)
      : undefined;
    const selected = reported?.size && batch.some((slideId) => reported.has(slideId))
      ? batch.filter((slideId) => reported.has(slideId))
      : batch;
    selected.forEach((slideId) => failed.add(slideId));
  });
  return [...failed];
}

export async function runBuildStage(context) {
  if (!context || typeof context !== "object") throw new TypeError("Build context is required");
  context.signal?.throwIfAborted();

  const outline = context.outline || await context.readOutline?.();
  if (!outline || !Array.isArray(outline.slides)) throw new TypeError("Build stage requires an outline");
  const remainingSlideIds = await resolveRemainingSlideIds(context, outline);
  const continuitySlideIds = await resolveContinuitySlideIds(context, outline);
  const batches = partitionSlideBatches(remainingSlideIds);
  if (batches.length === 0) return { batches, firstPass: [], retriedSlideIds: [] };

  const [sharedPromptContext, repairContext, visualReferenceSlides] = await Promise.all([
    resolveSharedPromptContext(context, outline),
    resolveRepairContext(context, remainingSlideIds),
    resolveVisualReferenceSlides(context, continuitySlideIds),
  ]);
  const buildBatch = typeof context.buildBatch === "function"
    ? context.buildBatch
    : (request) => runAgentBatch(context, request);

  const makeRequest = (slideIds, retry = false, retryErrors = []) => {
    const anchorSlideId = slideIds[Math.floor((slideIds.length - 1) / 2)];
    const readOnlySlideIds = nearestCalibratedNeighbor(outline, anchorSlideId, continuitySlideIds);
    return {
      jobId: context.jobId,
      revisionId: context.revisionId || "working",
      signal: context.signal,
      slideIds: [...slideIds],
      targetSlideIds: [...slideIds],
      readOnlySlideIds,
      retry,
      retryErrors,
      outline,
      promptContext: {
        ...sharedPromptContext,
        targetSlides: projectTargetSlides(outline, slideIds),
        neighboringSlides: neighboringSlides(outline, slideIds),
        readOnlySlides: projectNeighborSlides(outline, readOnlySlideIds),
        visualReferenceSlides: visualReferenceSlides
          .filter((slide) => readOnlySlideIds.includes(slide.slideId)),
        repairDesignChanges: repairContext.designChanges,
        repairSlides: repairContext.slides.filter((slide) => slideIds.includes(slide.slideId)),
      },
    };
  };

  const firstPass = await mapConcurrent(
    batches,
    2,
    (slideIds) => buildBatch(makeRequest(slideIds)),
  );
  context.signal?.throwIfAborted();

  const retriedSlideIds = collectFailedSlideIds(firstPass, batches);
  const retryBatches = partitionSlideBatches(retriedSlideIds);
  let retryPass = [];
  let retryResult;
  if (retryBatches.length > 0) {
    const retryErrors = collectBatchRetryErrors(firstPass, batches);
    retryPass = await mapConcurrent(
      retryBatches,
      2,
      (slideIds) => buildBatch(makeRequest(
        slideIds,
        true,
        retryErrors.filter((error) => error.slideIds.some((slideId) => slideIds.includes(slideId))),
      )),
    );
    context.signal?.throwIfAborted();
    const failedRetry = retryPass.find((result) => result.status === "rejected");
    if (failedRetry) throw failedRetry.reason;
    if (retryPass.length === 1) retryResult = retryPass[0].value;
  }
  return { batches, firstPass, retriedSlideIds, retryBatches, retryPass, retryResult };
}

export function createSlideBatchSchema(slideIds) {
  const targetSlideIds = normalizeSlideIds(slideIds, "Slide batch target IDs");
  if (targetSlideIds.length === 0) throw new Error("Slide batch target IDs must not be empty");
  return {
    type: "object",
    additionalProperties: false,
    required: ["slides"],
    properties: {
      slides: {
        type: "array",
        minItems: targetSlideIds.length,
        maxItems: targetSlideIds.length,
        items: {
          ...WRITE_SLIDE_JSON_SCHEMA,
          properties: {
            ...WRITE_SLIDE_JSON_SCHEMA.properties,
            slideId: { type: "string", enum: targetSlideIds },
          },
        },
      },
    },
  };
}

export function buildBuildStageMessages(promptContext, skill = {}, options = {}) {
  const instructions = typeof skill?.instructions === "string" ? skill.instructions.trim() : "";
  const targetSlideIds = options.targetSlideIds
    || promptContext.targetSlides?.map((slide) => slide.slideId)
    || [];
  const schema = options.schema || createSlideBatchSchema(targetSlideIds);
  return [
    {
      role: "system",
      content: [
        instructions,
        "Return one JSON object matching the supplied outputSchema. Do not return an agent or tool-call envelope, Markdown fences, or explanatory text.",
        "The slides array must contain every requiredSlideId exactly once and in the listed order. Generate complete html, css, assetSlots, and charts fields for every slide; assetSlots and charts must be [] when unused.",
        "Generate only the required slide IDs. Read-only slides provide continuity and must never be returned or rewritten.",
        "Use only htmlContract.allowedTags in HTML; every unlisted tag is invalid. htmlContract.reservedTags belong to the server and must never appear in model HTML or CSS selectors. CSS selectors must also never reference htmlContract.reservedCssClasses.",
        "Each css field is per-slide CSS, not theme CSS. Every comma-separated selector branch must start exactly with :slide. Never emit :root, bare selector branches, or custom properties; the server-owned theme is already locked.",
        "Follow imagePlan exactly. Return at most imagePlan.maxAssetSlotsPerSlide asset slots on allowed pages, and return assetSlots: [] for every page outside imagePlan.assetSlotsAllowedSlideIds.",
        "Speaker notes and 讲稿提示 are server-owned metadata and are intentionally absent from targetSlides. Never invent, render, paraphrase, hide, or copy presenter cues into any generated field.",
        "Never emit a section element or a section type selector. Reveal owns section for slide navigation; use div or article containers instead.",
        "When repairSlides is non-empty, repair each supplied previousHtml and previousCss against every listed issue and the shared repairDesignChanges. Preserve correct content and the locked design direction, change only what is needed, and return a complete replacement for every required slide. Never ignore an issue or blindly reproduce the previous layout. Do not fix clipping or overflow by deleting the dominant visual anchor or collapsing the composition into the upper half; resize, reposition, or rebuild that anchor inside the safe canvas.",
        "Treat every slide as a designed 1920x1080 composition, not a document page. Use the locked slide composition map and visual motifs. Give each slide one dominant visual anchor, distribute content across the safe canvas, and reserve clear separation above the source footer; never leave the lower half accidentally empty or let content touch or cross the safe boundary.",
        "The server-owned :slide root is an unpadded 1920x1080 canvas. Apply the 72px safe inset exactly once in the generated composition, either on the outermost composition wrapper or through explicit positions. Never add another four-sided safe inset inside an already inset full-canvas wrapper.",
        "Avoid repeated header bars, bordered text boxes, and uniform card grids as the main visual system. When imagePlan generation and approved assets are both unavailable, create meaningful topic-linked visuals with allowed HTML elements and CSS geometry; do not imitate an image with a blank placeholder.",
        "visualReferenceSlides contains read-only calibrated HTML/CSS visual DNA. Match its typography, spacing, motif treatment, and component language without returning or rewriting those reference IDs. Stored CSS selectors may already contain server slide IDs; emit only fresh :slide-scoped CSS for target slides.",
        "Use the locked design brief consistently. Theme values may be referenced only as var(--deck-*) tokens named by that brief; never invent custom properties.",
        String(promptContext.htmlCssContract || ""),
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Generate a complete HTML/CSS slide batch",
        ...promptContext,
        requiredSlideIds: targetSlideIds,
        ...(options.retry ? {
          retryInstruction: "The previous batch failed protocol or page validation. Regenerate the complete current target batch and obey outputSchema exactly.",
          validationErrors: Array.isArray(options.retryErrors) ? options.retryErrors : [],
          validationRemediation: buildValidationRemediation(options.retryErrors),
        } : {}),
        htmlContract: MODEL_HTML_CONTRACT,
        cssContract: MODEL_CSS_CONTRACT,
        outputTemplate: {
          slides: targetSlideIds.map((slideId) => ({
            slideId,
            html: "<div class=\"slide-content\"><!-- complete rootless slide markup --></div>",
            css: ":slide .slide-content{display:grid}",
            assetSlots: [],
            charts: [],
          })),
        },
        outputSchema: schema,
      }),
    },
  ];
}

async function runAgentBatch(context, request) {
  if (typeof context.runner?.completeStructuredStage !== "function" || typeof context.tools?.forStage !== "function") {
    throw new TypeError("Build stage requires buildBatch or runner/tool dependencies");
  }
  const progressStage = resolveProgressStage(context.progressStage);
  const skillStage = progressStage === "repairing" ? "repairing" : "building";
  const skill = await context.skillLoader?.load?.(skillStage) || {};
  try {
    const schema = createSlideBatchSchema(request.targetSlideIds);
    const stageTools = context.tools.forStage("building", {
      ...context,
      outline: request.outline,
      targetSlideIds: request.targetSlideIds,
      readOnlySlideIds: request.readOnlySlideIds,
    });
    if (!stageTools.write_slide?.schema?.parse || typeof stageTools.write_slide.execute !== "function") {
      throw new TypeError("Build stage requires the write_slide tool");
    }
    const result = await context.runner.completeStructuredStage({
      stage: progressStage,
      messages: buildBuildStageMessages(request.promptContext, skill, {
        targetSlideIds: request.targetSlideIds,
        retry: request.retry,
        retryErrors: request.retryErrors,
        schema,
      }),
      schema,
      schemaName: "deck_slide_batch",
      maxUpstreamCalls: upstreamCallBudget(1),
      timeoutMs: context.buildTimeoutMs || 120_000,
      signal: context.signal,
      emit: context.emit,
    });
    const slides = validateSlideBatch(result.value, request.targetSlideIds, stageTools.write_slide.schema);
    const failures = [];
    let completed = 0;
    for (let index = 0; index < slides.length; index += 1) {
      const slide = slides[index];
      context.signal?.throwIfAborted();
      try {
        await stageTools.write_slide.execute(slide, {
          jobId: context.jobId,
          stage: progressStage,
          signal: context.signal,
          emit: context.emit,
        });
      } catch (error) {
        failures.push({
          slideId: slide.slideId,
          message: error?.message || `Slide ${slide.slideId} failed validation`,
        });
        continue;
      }
      completed += 1;
      await emitSlideWriteProgress(context.emit, progressStage, slide.slideId, completed, slides.length);
    }
    if (failures.length > 0) {
      const failedSlideIds = failures.map((failure) => failure.slideId);
      throw new BatchError(
        failedSlideIds,
        failures.map((failure) => `${failure.slideId}: ${failure.message}`).join("; "),
        {
          failures,
          ...(failures.length === 1 ? { failedSlideId: failures[0].slideId } : {}),
        },
      );
    }
    const incomplete = await incompleteSlideIds(context, request.slideIds);
    if (incomplete.length) throw new BatchError(incomplete, "Slide batch left incomplete page checkpoints");
    return { ...result, slideIds: slides.map((slide) => slide.slideId) };
  } catch (error) {
    if (error instanceof BatchError) throw error;
    const incomplete = await incompleteSlideIds(context, request.slideIds).catch(() => request.slideIds);
    throw new BatchError(incomplete.length ? incomplete : request.slideIds, error?.message || "Slide batch failed", { cause: error });
  }
}

function collectBatchRetryErrors(results, batches) {
  return results.flatMap((result, index) => {
    if (result?.status !== "rejected") return [];
    const granular = Array.isArray(result.reason?.failures)
      ? result.reason.failures.filter((failure) => batches[index].includes(failure?.slideId))
      : [];
    if (granular.length > 0) {
      return granular.map((failure) => ({
        slideIds: [failure.slideId],
        failedSlideId: failure.slideId,
        message: String(failure.message || "Slide validation failed").replace(/\s+/g, " ").slice(0, 1_000),
      }));
    }
    const message = String(result.reason?.message || result.reason || "Slide batch failed")
      .replace(/\s+/g, " ")
      .slice(0, 1_000);
    const reported = Array.isArray(result.reason?.slideIds)
      ? result.reason.slideIds.filter((slideId) => batches[index].includes(slideId))
      : [];
    const failedSlideId = result.reason?.failedSlideId;
    return [{
      slideIds: reported.length ? reported : [...batches[index]],
      ...(typeof failedSlideId === "string" ? { failedSlideId } : {}),
      message,
    }];
  });
}

function buildValidationRemediation(retryErrors) {
  const messages = Array.isArray(retryErrors)
    ? retryErrors.map((item) => String(item?.message || ""))
    : [];
  const forbiddenTags = [...new Set(messages.flatMap((message) => (
    [...message.matchAll(/Forbidden HTML tag:\s*([a-z0-9-]+)/gi)].map((match) => match[1].toLowerCase())
  )))];
  const remediation = [];
  if (forbiddenTags.length > 0) {
    remediation.push(
      `Remove every forbidden tag: ${forbiddenTags.join(", ")}.`,
      "Delete speaker-note or notes-container content instead of moving it into another visible element.",
      `For legitimate visible side content, replace only the wrapper with ${MODEL_HTML_CONTRACT.fallbackContainerTags.join(" or ")} and update matching CSS selectors.`,
    );
  }
  if (messages.some((message) => /selector branch must start with :slide|first selector compound must be exactly :slide/i.test(message))) {
    remediation.push(
      "Delete every :root rule from each per-slide css field; theme tokens are already provided by the server-owned theme.",
      "Rewrite every comma-separated selector branch so it starts exactly with :slide; repeat :slide after every comma.",
      "Use forms such as :slide .title{...} and :slide header, :slide footer{...}; never use a bare .class, element, or :root branch.",
    );
  }
  if (remediation.length === 0) remediation.push("Fix every reported validation error.");
  remediation.push("Validate every returned HTML and CSS field against htmlContract and cssContract before responding.");
  return remediation;
}

function validateSlideBatch(value, targetSlideIds, writeSlideSchema) {
  if (!value || !Array.isArray(value.slides)) throw new Error("Slide batch response must contain a slides array");
  let slides;
  try {
    slides = value.slides.map((slide) => writeSlideSchema.parse(slide));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Slide batch contains invalid page data: ${detail}`);
  }
  const received = slides.map((slide) => slide.slideId);
  const ordered = received.length === targetSlideIds.length
    && received.every((slideId, index) => slideId === targetSlideIds[index]);
  if (!ordered) {
    throw new Error(`Slide batch IDs must match requested order; expected ${targetSlideIds.join(", ")}; received ${received.join(", ") || "none"}`);
  }
  return slides;
}

function resolveProgressStage(value) {
  const stage = value || "building";
  if (!BUILD_PROGRESS_STAGES.has(stage)) throw new Error(`Unsupported slide generation progress stage: ${stage}`);
  return stage;
}

async function emitSlideWriteProgress(emit, stage, slideId, completed, total) {
  if (typeof emit !== "function") return;
  await emit({
    stage,
    type: "progress",
    status: "running",
    title: BUILD_STAGE_TITLES[stage],
    message: `已写入 ${slideId}`,
    progress: { completed, total },
  });
}

async function resolveRemainingSlideIds(context, outline) {
  const explicit = typeof context.getRemainingSlideIds === "function"
    ? await context.getRemainingSlideIds({ outline, signal: context.signal })
    : context.remainingSlideIds;
  if (explicit !== undefined) return validateOutlineSlideIds(explicit, outline);

  const manifest = context.manifest
    || await context.store?.readJson?.(context.jobId, "working/manifest.json", { optional: true })
    || {};
  const completed = new Set([
    ...(Array.isArray(context.completedSlideIds) ? context.completedSlideIds : []),
    ...(Array.isArray(context.calibrationSlideIds) ? context.calibrationSlideIds : []),
    ...(Array.isArray(manifest.slides)
      ? manifest.slides.filter(isCompletedSlide).map((slide) => slide.slideId)
      : []),
  ]);
  return outline.slides.map((slide) => slide.slideId).filter((slideId) => !completed.has(slideId));
}

async function resolveContinuitySlideIds(context, outline) {
  if (Array.isArray(context.calibrationSlideIds)) {
    return validateSubset(context.calibrationSlideIds, outline.slides.map((slide) => slide.slideId), "Calibration slide IDs");
  }
  const manifest = context.manifest
    || await context.store?.readJson?.(context.jobId, "working/manifest.json", { optional: true })
    || {};
  const completed = [
    ...(Array.isArray(context.completedSlideIds) ? context.completedSlideIds : []),
    ...(Array.isArray(manifest.slides)
      ? manifest.slides.filter(isCompletedSlide).map((slide) => slide.slideId)
      : []),
  ];
  return validateSubset(
    [...new Set(completed)],
    outline.slides.map((slide) => slide.slideId),
    "Completed slide IDs",
  );
}

async function resolveSharedPromptContext(context, outline) {
  const lockedDesignBriefSummary = context.lockedDesignBriefSummary
    ?? context.designBriefSummary
    ?? await context.readLockedDesignBriefSummary?.()
    ?? "";
  const allowedAssets = context.allowedAssets
    ?? await context.listAllowedAssets?.()
    ?? [];
  const options = context.input?.options || context.options || {};
  return {
    title: outline.title,
    narrative: outline.narrative,
    topic: context.input?.source?.topic || outline.title,
    audience: context.input?.source?.audience || "",
    lockedDesignBriefSummary,
    allowedAssets,
    imagePlan: createImagePlan(outline, options, allowedAssets),
    htmlCssContract: context.htmlCssContract || "Rootless validated HTML and slide-scoped validated CSS only.",
  };
}

async function resolveRepairContext(context, slideIds) {
  if (!context.repairReport) return { designChanges: [], slides: [] };
  const report = context.repairReport;
  const reportSlides = new Map((Array.isArray(report.slides) ? report.slides : [])
    .map((slide) => [slide?.slideId, slide]));
  const consoleErrors = Array.isArray(report.consoleErrors) ? report.consoleErrors : [];

  const designChanges = (Array.isArray(report.designChanges) ? report.designChanges : [])
    .map((change) => String(change).replace(/\s+/g, " ").slice(0, 1_000));
  const slides = await Promise.all(slideIds.map(async (slideId) => {
    const issues = [
      ...(Array.isArray(reportSlides.get(slideId)?.issues) ? reportSlides.get(slideId).issues : []),
      ...consoleErrors
        .filter((error) => error?.slideId === slideId)
        .map((error) => `console:${String(error.message || "Unknown console error")}`),
    ].map((issue) => String(issue).replace(/\s+/g, " ").slice(0, 1_000));
    const [previousHtml, previousCss] = await Promise.all([
      context.store?.readArtifact?.(
        context.jobId,
        `working/slides/${slideId}.html`,
        { optional: true },
      ),
      context.store?.readArtifact?.(
        context.jobId,
        `working/slides/${slideId}.css`,
        { optional: true },
      ),
    ]);
    return {
      slideId,
      issues: [...new Set(issues)],
      previousHtml: typeof previousHtml === "string" ? previousHtml.slice(0, 200_000) : "",
      previousCss: typeof previousCss === "string" ? previousCss.slice(0, 120_000) : "",
    };
  }));
  return { designChanges: [...new Set(designChanges)], slides };
}

async function resolveVisualReferenceSlides(context, slideIds) {
  if (!slideIds.length || typeof context.store?.readArtifact !== "function") return [];
  const references = await Promise.all(slideIds.map(async (slideId) => {
    const [html, css] = await Promise.all([
      context.store.readArtifact(
        context.jobId,
        `working/slides/${slideId}.html`,
        { optional: true },
      ),
      context.store.readArtifact(
        context.jobId,
        `working/slides/${slideId}.css`,
        { optional: true },
      ),
    ]);
    if (typeof html !== "string" || typeof css !== "string") return undefined;
    return {
      slideId,
      html: html.slice(0, 200_000),
      css: css.slice(0, 120_000),
    };
  }));
  return references.filter(Boolean);
}

async function incompleteSlideIds(context, slideIds) {
  if (typeof context.getIncompleteSlideIds === "function") {
    return validateSubset(
      await context.getIncompleteSlideIds(slideIds),
      slideIds,
      "Incomplete slide IDs",
    );
  }
  if (typeof context.store?.readArtifact !== "function") return [];
  const checks = await Promise.all(slideIds.map(async (slideId) => {
    const html = await context.store.readArtifact(
      context.jobId,
      `working/slides/${slideId}.html`,
      { optional: true },
    );
    return html === undefined ? slideId : undefined;
  }));
  return checks.filter(Boolean);
}

function isCompletedSlide(slide) {
  return ["done", "built", "resolved"].includes(slide?.status)
    || slide?.checkpoint === "done";
}

function projectTargetSlides(outline, slideIds) {
  const selected = new Set(slideIds);
  return outline.slides.filter((slide) => selected.has(slide.slideId)).map((slide) => ({
    slideId: slide.slideId,
    title: slide.title,
    claim: slide.claim,
    rawMarkdown: removeSpeakerNotes(
      typeof slide.visibleMarkdown === "string"
        ? slide.visibleMarkdown
        : typeof slide.rawMarkdown === "string" ? slide.rawMarkdown : "",
    ),
  }));
}

function neighboringSlides(outline, slideIds) {
  const target = new Set(slideIds);
  const neighbors = new Set();
  for (const slideId of slideIds) {
    const index = outline.slides.findIndex((slide) => slide.slideId === slideId);
    for (const neighbor of [outline.slides[index - 1], outline.slides[index + 1]]) {
      if (neighbor && !target.has(neighbor.slideId)) neighbors.add(neighbor.slideId);
    }
  }
  return projectNeighborSlides(outline, [...neighbors]);
}

function nearestCalibratedNeighbor(outline, slideId, calibrationSlideIds) {
  if (!Array.isArray(calibrationSlideIds) || calibrationSlideIds.length === 0) return [];
  const targetIndex = outline.slides.findIndex((slide) => slide.slideId === slideId);
  const ordered = calibrationSlideIds
    .map((candidate) => ({
      slideId: candidate,
      index: outline.slides.findIndex((slide) => slide.slideId === candidate),
    }))
    .filter((candidate) => candidate.index >= 0 && candidate.slideId !== slideId)
    .sort((left, right) => (
      Math.abs(left.index - targetIndex) - Math.abs(right.index - targetIndex)
      || left.index - right.index
    ));
  return ordered.length ? [ordered[0].slideId] : [];
}

function projectNeighborSlides(outline, slideIds) {
  const selected = new Set(slideIds);
  return outline.slides.filter((slide) => selected.has(slide.slideId)).map((slide) => ({
    slideId: slide.slideId,
    title: slide.title,
    claim: slide.claim,
  }));
}

function validateOutlineSlideIds(value, outline) {
  const slideIds = normalizeSlideIds(value, "Remaining slide IDs");
  const known = new Set(outline.slides.map((slide) => slide.slideId));
  const unknown = slideIds.find((slideId) => !known.has(slideId));
  if (unknown) throw new Error(`Unknown outline slide ID: ${unknown}`);
  return slideIds;
}

function validateSubset(value, allowed, name) {
  const slideIds = normalizeSlideIds(value, name);
  const allowedSet = new Set(allowed);
  const unknown = slideIds.find((slideId) => !allowedSet.has(slideId));
  if (unknown) throw new Error(`${name} contains an unexpected target: ${unknown}`);
  return slideIds;
}

function normalizeSlideIds(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const slideIds = value.map((slideId) => String(slideId));
  if (slideIds.some((slideId) => !/^slide-\d{2}$/.test(slideId))) {
    throw new Error(`${name} contains an invalid slide ID`);
  }
  if (new Set(slideIds).size !== slideIds.length) throw new Error(`${name} must be unique`);
  return slideIds;
}
