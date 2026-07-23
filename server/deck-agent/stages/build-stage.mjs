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

  const sharedPromptContext = await resolveSharedPromptContext(context, outline);
  const buildBatch = typeof context.buildBatch === "function"
    ? context.buildBatch
    : (request) => runAgentBatch(context, request);

  const makeRequest = (slideIds, retry = false) => {
    const readOnlySlideIds = slideIds.length === 1
      ? nearestCalibratedNeighbor(outline, slideIds[0], continuitySlideIds)
      : [];
    return {
      jobId: context.jobId,
      revisionId: context.revisionId || "working",
      signal: context.signal,
      slideIds: [...slideIds],
      targetSlideIds: [...slideIds],
      readOnlySlideIds,
      retry,
      outline,
      promptContext: {
        ...sharedPromptContext,
        targetSlides: projectTargetSlides(outline, slideIds),
        neighboringSlides: neighboringSlides(outline, slideIds),
        readOnlySlides: projectNeighborSlides(outline, readOnlySlideIds),
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
  let retryResult;
  if (retriedSlideIds.length > 0) {
    retryResult = await buildBatch(makeRequest(retriedSlideIds, true));
  }
  return { batches, firstPass, retriedSlideIds, retryResult };
}

export function buildBuildStageMessages(promptContext, skill = {}) {
  const instructions = typeof skill?.instructions === "string" ? skill.instructions.trim() : "";
  return [
    {
      role: "system",
      content: [
        instructions,
        "Write only the target slide IDs. Read-only slides provide continuity and must never be rewritten.",
        String(promptContext.htmlCssContract || ""),
      ].filter(Boolean).join("\n\n"),
    },
    { role: "user", content: JSON.stringify(promptContext) },
  ];
}

async function runAgentBatch(context, request) {
  if (typeof context.runner?.runStage !== "function" || typeof context.tools?.forStage !== "function") {
    throw new TypeError("Build stage requires buildBatch or runner/tool dependencies");
  }
  const skill = await context.skillLoader?.load?.("building") || {};
  try {
    const result = await context.runner.runStage({
      jobId: context.jobId,
      stage: "building",
      messages: buildBuildStageMessages(request.promptContext, skill),
      allowedTools: context.tools.forStage("building", {
        ...context,
        outline: request.outline,
        targetSlideIds: request.targetSlideIds,
        readOnlySlideIds: request.readOnlySlideIds,
      }),
      maxTurns: 1,
      maxUpstreamCalls: 1,
      timeoutMs: context.buildTimeoutMs || 120_000,
      signal: context.signal,
      emit: context.emit,
    });
    const incomplete = await incompleteSlideIds(context, request.slideIds);
    if (incomplete.length) throw new BatchError(incomplete, "Slide batch left incomplete page checkpoints");
    return result;
  } catch (error) {
    if (error instanceof BatchError) throw error;
    const incomplete = await incompleteSlideIds(context, request.slideIds).catch(() => request.slideIds);
    throw new BatchError(incomplete.length ? incomplete : request.slideIds, error?.message || "Slide batch failed", { cause: error });
  }
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
  return {
    title: outline.title,
    narrative: outline.narrative,
    lockedDesignBriefSummary,
    allowedAssets,
    htmlCssContract: context.htmlCssContract || "Rootless validated HTML and slide-scoped validated CSS only.",
  };
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
    rawMarkdown: slide.rawMarkdown,
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
