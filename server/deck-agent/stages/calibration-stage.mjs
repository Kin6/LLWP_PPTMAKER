import { selectCalibrationSlides } from "../outline.mjs";
import { failedSlideIds } from "../verifier.mjs";

const INITIAL_REPORT_PATH = "working/qa/calibration-initial-report.json";
const FINAL_REPORT_PATH = "working/qa/calibration-final-report.json";

function validateVisualReview(visual, slideIds) {
  const allowed = new Set(slideIds);
  const failedSlides = Array.isArray(visual?.failedSlides) ? visual.failedSlides : [];
  const designChanges = Array.isArray(visual?.designChanges) ? visual.designChanges : [];
  for (const item of failedSlides) {
    if (!allowed.has(item?.slideId)) throw new Error(`Visual review referenced ${item?.slideId || "an unknown slide"} outside calibration targets`);
    if (!Array.isArray(item.reasons) || item.reasons.some((reason) => typeof reason !== "string")) {
      throw new Error("Visual review reasons must be strings");
    }
  }
  if (designChanges.some((change) => typeof change !== "string")) throw new Error("Visual design changes must be strings");
  return { failedSlides, designChanges };
}

async function hasCompletedCalibrationSlides(context, slideIds) {
  if (typeof context.store?.readJson !== "function" || typeof context.store?.readArtifact !== "function") {
    return false;
  }
  const manifest = await context.store.readJson(
    context.jobId,
    "working/manifest.json",
    { optional: true },
  );
  const entries = new Map((Array.isArray(manifest?.slides) ? manifest.slides : [])
    .map((slide) => [slide?.slideId, slide]));
  if (slideIds.some((slideId) => entries.get(slideId)?.status !== "done")) return false;

  const artifacts = await Promise.all(slideIds.flatMap((slideId) => [
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
  ]));
  return artifacts.every((artifact) => typeof artifact === "string");
}

async function persistCalibrationReport(context, relativePath, report) {
  await context.store?.writeJson?.(
    context.jobId,
    relativePath,
    report,
    { signal: context.signal },
  );
}

function calibrationFailure(report) {
  const slideIds = failedSlideIds(report);
  const details = slideIds.map((slideId) => {
    const issues = [
      ...((report.slides || []).find((slide) => slide.slideId === slideId)?.issues || []),
      ...(report.consoleErrors || [])
        .filter((error) => error?.slideId === slideId)
        .map((error) => `console:${String(error.message || "Unknown console error")}`),
    ];
    return `${slideId} [${[...new Set(issues)].join("; ") || "unknown QA failure"}]`;
  });
  const error = new Error(`Calibration remains invalid after one targeted correction: ${details.join(", ") || "unknown QA failure"}`);
  error.slideIds = slideIds;
  return error;
}

export async function runCalibrationStage(context) {
  const outline = await context.readOutline();
  const slideIds = selectCalibrationSlides(outline);
  if (!await hasCompletedCalibrationSlides(context, slideIds)) {
    await context.generateSlides(slideIds, { stage: "calibrating", maxUpstreamCalls: 1 });
  }
  let dom = await context.verifier.verify({
    jobId: context.jobId,
    revisionId: context.revisionId,
    slideIds,
    captureContactSheet: true,
    signal: context.signal,
  });
  const visual = validateVisualReview(await context.reviewCalibration({
    slideIds,
    contactSheetArtifactId: dom.contactSheetArtifactId,
    screenshotArtifactIds: dom.slides.map((slide) => slide.screenshotArtifactId).filter(Boolean),
    maxUpstreamCalls: 1,
  }), slideIds);
  let report = { ...context.mergeQaEvidence(dom, visual), designChanges: visual.designChanges };
  await persistCalibrationReport(context, INITIAL_REPORT_PATH, report);
  if (!report.ok) {
    const failed = failedSlideIds(report);
    await context.reviseCalibration({ slideIds: failed, report, maxUpstreamCalls: 1 });
    dom = await context.verifier.verify({
      jobId: context.jobId,
      revisionId: context.revisionId,
      slideIds,
      captureContactSheet: true,
      signal: context.signal,
    });
    const revisedVisual = validateVisualReview(await context.reviewCalibration({
      slideIds: failed,
      contactSheetArtifactId: dom.contactSheetArtifactId,
      screenshotArtifactIds: dom.slides
        .filter((slide) => failed.includes(slide.slideId))
        .map((slide) => slide.screenshotArtifactId)
        .filter(Boolean),
      priorReport: report,
      maxUpstreamCalls: 1,
    }), failed);
    report = { ...context.mergeQaEvidence(dom, revisedVisual), designChanges: revisedVisual.designChanges };
    await persistCalibrationReport(context, FINAL_REPORT_PATH, report);
    if (!report.ok) throw calibrationFailure(report);
  } else {
    await persistCalibrationReport(context, FINAL_REPORT_PATH, report);
  }
  await context.lockDesignRules({ slideIds, report });
  return report;
}
