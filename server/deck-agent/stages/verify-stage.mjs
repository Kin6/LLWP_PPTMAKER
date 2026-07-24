import {
  failedSlideIds,
  mergeQaEvidence,
  mergeVerificationReports,
} from "../verifier.mjs";

function normalizeVisualReview(value, allowedSlideIds, label) {
  const failedSlides = value?.failedSlides ?? [];
  const designChanges = value?.designChanges ?? [];
  if (!Array.isArray(failedSlides)) throw new Error(`${label} must return failedSlides`);
  if (!Array.isArray(designChanges)
    || designChanges.some((change) => typeof change !== "string" || !change.trim())) {
    throw new Error(`${label} must return valid designChanges`);
  }
  const allowed = new Set(allowedSlideIds);
  const normalized = failedSlides.map((item) => {
    if (!item || typeof item.slideId !== "string" || !allowed.has(item.slideId)) {
      throw new Error(`${label} returned a slide outside the deck`);
    }
    if (!Array.isArray(item.reasons) || item.reasons.some((reason) => typeof reason !== "string" || !reason.trim())) {
      throw new Error(`${label} returned invalid failure reasons`);
    }
    return {
      slideId: item.slideId,
      reasons: [...new Set(item.reasons.map((reason) => reason.trim().slice(0, 500)))],
    };
  });
  return {
    failedSlides: normalized,
    designChanges: [...new Set(designChanges.map((change) => change.trim().slice(0, 500)))],
  };
}

async function resolveSlideIds(context) {
  let slideIds = context.allSlideIds;
  if (!Array.isArray(slideIds) || !slideIds.length) {
    const outline = context.outline || await context.readOutline?.();
    slideIds = outline?.slides?.map((slide) => slide.slideId);
  }
  if ((!Array.isArray(slideIds) || !slideIds.length) && context.store?.readJson) {
    const manifest = await context.store.readJson(context.jobId, "working/manifest.json");
    slideIds = manifest?.slides?.map((slide) => slide.slideId);
  }
  const unique = [...new Set(slideIds || [])];
  if (!unique.length || unique.length !== (slideIds || []).length
    || unique.some((slideId) => !/^slide-\d{2}$/.test(slideId))) {
    throw new Error("Verification requires valid, unique slide identities");
  }
  return unique;
}

export async function applyDeterministicRepairs(context, slideIds, report) {
  const byId = new Map((report?.slides || []).map((slide) => [slide.slideId, slide]));
  const changed = [];
  for (const slideId of [...new Set(slideIds || [])]) {
    const issues = new Set(byId.get(slideId)?.issues || []);
    let slideChanged = false;
    if (issues.has("broken-image") && typeof context.markBrokenAssetSlotsEmpty === "function") {
      slideChanged = await context.markBrokenAssetSlotsEmpty(slideId) !== false || slideChanged;
    }
    if (issues.has("font-load-failed") && typeof context.useBundledFontFallback === "function") {
      slideChanged = await context.useBundledFontFallback(slideId) !== false || slideChanged;
    }
    if (["horizontal-overflow", "vertical-overflow", "outside-canvas", "outside-safe-area"].some((issue) => issues.has(issue))
      && typeof context.setTightDensity === "function") {
      slideChanged = await context.setTightDensity(slideId) !== false || slideChanged;
    }
    if (slideChanged) changed.push(slideId);
  }
  return changed;
}

export async function runVerificationStage(context) {
  const slideIds = await resolveSlideIds(context);

  let deterministic = await context.verifier.verify({
    jobId: context.jobId,
    revisionId: context.revisionId,
    slideIds,
    captureContactSheet: true,
    signal: context.signal,
  });

  const deterministicFailures = failedSlideIds(deterministic);
  if (deterministicFailures.length) {
    const repair = context.applyDeterministicRepairs
      ? (slideIdsToRepair, report) => context.applyDeterministicRepairs(slideIdsToRepair, report)
      : (slideIdsToRepair, report) => applyDeterministicRepairs(context, slideIdsToRepair, report);
    const changed = [...new Set(await repair(deterministicFailures, deterministic) || [])]
      .filter((slideId) => slideIds.includes(slideId));
    if (changed.length) {
      const rechecked = await context.verifier.verify({
        jobId: context.jobId,
        revisionId: context.revisionId,
        slideIds: changed,
        captureContactSheet: false,
        signal: context.signal,
      });
      deterministic = mergeVerificationReports(deterministic, rechecked, changed);
      if (context.rebuildContactSheet) {
        deterministic = {
          ...deterministic,
          contactSheetArtifactId: await context.rebuildContactSheet(deterministic),
        };
      }
    }
  }

  const visual = normalizeVisualReview(await context.reviewContactSheet({
    contactSheetArtifactId: deterministic.contactSheetArtifactId,
    screenshotArtifactIds: deterministic.slides
      .map((slide) => slide.screenshotArtifactId)
      .filter(Boolean),
    slideIds,
    maxUpstreamCalls: 1,
  }), slideIds, "Whole-deck visual review");
  const initial = { ...mergeQaEvidence(deterministic, visual), designChanges: visual.designChanges };
  const failed = failedSlideIds(initial);
  if (!failed.length) return { status: "ready", report: initial };

  await context.store?.writeJson?.(
    context.jobId,
    "working/qa/initial-report.json",
    initial,
    { signal: context.signal },
  );

  await context.transition?.(context.jobId, "repairing");
  await context.repairSlides(failed, { report: initial, maxUpstreamCalls: 1 });

  const deterministicFinal = await context.verifier.verify({
    jobId: context.jobId,
    revisionId: context.revisionId,
    slideIds,
    captureContactSheet: true,
    signal: context.signal,
  });
  const visualFinal = normalizeVisualReview(await context.reviewRepairedSlides({
    slideIds: failed,
    screenshotArtifactIds: deterministicFinal.slides
      .filter((slide) => failed.includes(slide.slideId))
      .map((slide) => slide.screenshotArtifactId)
      .filter(Boolean),
    contactSheetArtifactId: deterministicFinal.contactSheetArtifactId,
    priorReport: initial,
    maxUpstreamCalls: 1,
  }), failed, "Targeted visual review");
  const report = { ...mergeQaEvidence(deterministicFinal, visualFinal), designChanges: visualFinal.designChanges };
  return { status: report.ok ? "ready" : "needs-review", report };
}
