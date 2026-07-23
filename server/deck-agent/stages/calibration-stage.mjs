import { selectCalibrationSlides } from "../outline.mjs";

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

export async function runCalibrationStage(context) {
  const outline = await context.readOutline();
  const slideIds = selectCalibrationSlides(outline);
  await context.generateSlides(slideIds, { stage: "calibrating", maxUpstreamCalls: 1 });
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
    maxUpstreamCalls: 1,
  }), slideIds);
  let report = context.mergeQaEvidence(dom, visual);
  if (!report.ok) {
    await context.reviseCalibration({ slideIds, report, maxUpstreamCalls: 1 });
    report = await context.verifier.verify({
      jobId: context.jobId,
      revisionId: context.revisionId,
      slideIds,
      captureContactSheet: false,
      signal: context.signal,
    });
    if (!report.ok) {
      await context.writeDefaultTheme();
      await context.generateSlides(slideIds, {
        stage: "calibrating",
        deterministicTheme: true,
        maxUpstreamCalls: 1,
      });
      report = await context.verifier.verify({
        jobId: context.jobId,
        revisionId: context.revisionId,
        slideIds,
        captureContactSheet: false,
        signal: context.signal,
      });
      if (!report.ok) throw new Error("Verified default calibration failed");
    }
  }
  await context.lockDesignRules({ slideIds, report });
  return report;
}
