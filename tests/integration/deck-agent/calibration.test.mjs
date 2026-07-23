import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { runCalibrationStage } from "../../../server/deck-agent/stages/calibration-stage.mjs";
import { mergeQaEvidence } from "../../../server/deck-agent/verifier.mjs";

it("calibrates the cover and densest slide, corrects once with evidence, then visually rechecks", async () => {
  const outline = {
    slides: [
      { slideId: "slide-01", number: 1, densityScore: 100 },
      { slideId: "slide-02", number: 2, densityScore: 200 },
      { slideId: "slide-07", number: 7, densityScore: 900 },
    ],
  };
  const verifier = {
    verify: vi.fn()
      .mockResolvedValueOnce({ ok: false, slides: [{ slideId: "slide-01", issues: ["overflow"], screenshotArtifactId: "shot-01" }, { slideId: "slide-07", issues: [], screenshotArtifactId: "shot-07" }], consoleErrors: [], contactSheetArtifactId: "contact-sheet" })
      .mockResolvedValueOnce({ ok: true, slides: [{ slideId: "slide-01", issues: [], screenshotArtifactId: "shot-01-fixed" }, { slideId: "slide-07", issues: [], screenshotArtifactId: "shot-07-final" }], consoleErrors: [], contactSheetArtifactId: "contact-sheet-fixed" }),
  };
  const reviewCalibration = vi.fn()
    .mockResolvedValueOnce({ failedSlides: [{ slideId: "slide-01", reasons: ["weak hierarchy"] }], designChanges: ["increase title contrast"] })
    .mockResolvedValueOnce({ failedSlides: [], designChanges: [] });
  const context = {
    jobId: "job-00000000-0000-4000-8000-000000000007",
    revisionId: "working",
    signal: new AbortController().signal,
    readOutline: vi.fn(async () => outline),
    store: { writeJson: vi.fn() },
    generateSlides: vi.fn(),
    verifier,
    mergeQaEvidence,
    reviewCalibration,
    reviseCalibration: vi.fn(),
    writeDefaultTheme: vi.fn(),
    lockDesignRules: vi.fn(),
  };

  await runCalibrationStage(context);

  expect(context.generateSlides).toHaveBeenNthCalledWith(1, ["slide-01", "slide-07"], { stage: "calibrating", maxUpstreamCalls: 1 });
  expect(context.reviewCalibration).toHaveBeenNthCalledWith(1, {
    slideIds: ["slide-01", "slide-07"],
    contactSheetArtifactId: "contact-sheet",
    screenshotArtifactIds: ["shot-01", "shot-07"],
    maxUpstreamCalls: 1,
  });
  expect(context.reviewCalibration).toHaveBeenNthCalledWith(2, {
    slideIds: ["slide-01"],
    contactSheetArtifactId: "contact-sheet-fixed",
    screenshotArtifactIds: ["shot-01-fixed"],
    priorReport: expect.objectContaining({ ok: false }),
    maxUpstreamCalls: 1,
  });
  expect(context.reviseCalibration).toHaveBeenCalledWith({
    slideIds: ["slide-01"],
    report: expect.objectContaining({
      designChanges: ["increase title contrast"],
      slides: expect.arrayContaining([expect.objectContaining({ slideId: "slide-01" })]),
    }),
    maxUpstreamCalls: 1,
  });
  expect(context.writeDefaultTheme).not.toHaveBeenCalled();
  expect(verifier.verify).toHaveBeenCalledTimes(2);
  expect(verifier.verify).toHaveBeenNthCalledWith(2, expect.objectContaining({ captureContactSheet: true }));
  expect(context.lockDesignRules).toHaveBeenCalledWith({ slideIds: ["slide-01", "slide-07"], report: expect.objectContaining({ ok: true }) });
  expect(context.store.writeJson).toHaveBeenNthCalledWith(
    1,
    context.jobId,
    "working/qa/calibration-initial-report.json",
    expect.objectContaining({ ok: false }),
    { signal: context.signal },
  );
  expect(context.store.writeJson).toHaveBeenNthCalledWith(
    2,
    context.jobId,
    "working/qa/calibration-final-report.json",
    expect.objectContaining({ ok: true }),
    { signal: context.signal },
  );
});

it("reuses complete persisted calibration slides instead of regenerating them", async () => {
  const slideIds = ["slide-01", "slide-06"];
  const store = {
    readJson: vi.fn(async () => ({ slides: slideIds.map((slideId) => ({ slideId, status: "done" })) })),
    readArtifact: vi.fn(async (_jobId, relativePath) => (
      relativePath.endsWith(".html") ? "<div>ready</div>" : "[data-slide-id]{display:block}"
    )),
    writeJson: vi.fn(),
  };
  const report = {
    ok: true,
    slides: slideIds.map((slideId) => ({ slideId, issues: [] })),
    consoleErrors: [],
    contactSheetArtifactId: "contact-sheet",
  };
  const context = {
    jobId: "job-00000000-0000-4000-8000-000000000007",
    revisionId: "working",
    signal: new AbortController().signal,
    store,
    readOutline: vi.fn(async () => ({
      slides: [
        { slideId: "slide-01", number: 1, densityScore: 100 },
        { slideId: "slide-06", number: 6, densityScore: 900 },
      ],
    })),
    generateSlides: vi.fn(),
    verifier: { verify: vi.fn(async () => report) },
    mergeQaEvidence,
    reviewCalibration: vi.fn(async () => ({ failedSlides: [], designChanges: [] })),
    reviseCalibration: vi.fn(),
    lockDesignRules: vi.fn(),
  };

  await runCalibrationStage(context);

  expect(context.generateSlides).not.toHaveBeenCalled();
  expect(store.readArtifact).toHaveBeenCalledTimes(4);
  expect(store.writeJson).toHaveBeenCalledWith(
    context.jobId,
    "working/qa/calibration-initial-report.json",
    expect.objectContaining({ ok: true }),
    { signal: context.signal },
  );
  expect(store.writeJson).toHaveBeenCalledWith(
    context.jobId,
    "working/qa/calibration-final-report.json",
    expect.objectContaining({ ok: true }),
    { signal: context.signal },
  );
});

it("persists the final failed report and names every remaining calibration issue", async () => {
  const initial = {
    ok: false,
    slides: [{ slideId: "slide-01", issues: ["outside-safe-area"] }, { slideId: "slide-06", issues: [] }],
    consoleErrors: [],
    contactSheetArtifactId: "contact-sheet",
  };
  const final = {
    ok: false,
    slides: [{ slideId: "slide-01", issues: ["outside-safe-area"] }, { slideId: "slide-06", issues: [] }],
    consoleErrors: [],
    contactSheetArtifactId: "contact-sheet-fixed",
  };
  const store = { writeJson: vi.fn() };
  const context = {
    jobId: "job-00000000-0000-4000-8000-000000000007",
    revisionId: "working",
    signal: new AbortController().signal,
    store,
    readOutline: vi.fn(async () => ({
      slides: [
        { slideId: "slide-01", number: 1, densityScore: 100 },
        { slideId: "slide-06", number: 6, densityScore: 900 },
      ],
    })),
    generateSlides: vi.fn(),
    verifier: { verify: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(final) },
    mergeQaEvidence,
    reviewCalibration: vi.fn()
      .mockResolvedValueOnce({ failedSlides: [], designChanges: [] })
      .mockResolvedValueOnce({ failedSlides: [{ slideId: "slide-01", reasons: ["right side is empty"] }], designChanges: [] }),
    reviseCalibration: vi.fn(),
    lockDesignRules: vi.fn(),
  };

  let failure;
  try {
    await runCalibrationStage(context);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ slideIds: ["slide-01"] });
  expect(failure.message).toContain("slide-01");
  expect(failure.message).toContain("outside-safe-area");
  expect(failure.message).toContain("visual:right side is empty");
  expect(store.writeJson).toHaveBeenLastCalledWith(
    context.jobId,
    "working/qa/calibration-final-report.json",
    expect.objectContaining({
      ok: false,
      slides: expect.arrayContaining([
        expect.objectContaining({
          slideId: "slide-01",
          issues: ["outside-safe-area", "visual:right side is empty"],
        }),
      ]),
    }),
    { signal: context.signal },
  );
});

it("rejects visual-review slide IDs outside the calibration pair", async () => {
  const context = {
    jobId: "job-00000000-0000-4000-8000-000000000007",
    revisionId: "working",
    signal: new AbortController().signal,
    readOutline: vi.fn(async () => ({ slides: [{ slideId: "slide-01", number: 1, densityScore: 1 }, { slideId: "slide-02", number: 2, densityScore: 2 }] })),
    generateSlides: vi.fn(),
    verifier: { verify: vi.fn(async () => ({ ok: true, slides: [{ slideId: "slide-01", issues: [] }, { slideId: "slide-02", issues: [] }], consoleErrors: [], contactSheetArtifactId: "sheet" })) },
    mergeQaEvidence,
    reviewCalibration: vi.fn(async () => ({ failedSlides: [{ slideId: "slide-99", reasons: ["bad"] }], designChanges: [] })),
    lockDesignRules: vi.fn(),
  };

  await expect(runCalibrationStage(context)).rejects.toThrow(/outside calibration targets/i);
});

it("defines deterministic outline, design, slide-batch, and calibration responses in the mock gateway", async () => {
  const source = await readFile(new URL("../../../scripts/mock-openai.mjs", import.meta.url), "utf8");
  expect(source).toContain('name === "deck_slide_batch"');
  expect(source).toContain('name === "agent_turn"');
  expect(source).toContain('name: "write_outline"');
  expect(source).toContain('name: "write_theme"');
  expect(source).toContain("return { slides: invalidSlideIdBatch(slides) }");
  expect(source).toContain('name === "calibration_review"');
});
