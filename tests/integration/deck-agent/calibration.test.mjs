import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { runCalibrationStage } from "../../../server/deck-agent/stages/calibration-stage.mjs";
import { mergeQaEvidence } from "../../../server/deck-agent/verifier.mjs";

it("calibrates the cover and densest slide, corrects once, then uses the default fallback", async () => {
  const outline = {
    slides: [
      { slideId: "slide-01", number: 1, densityScore: 100 },
      { slideId: "slide-02", number: 2, densityScore: 200 },
      { slideId: "slide-07", number: 7, densityScore: 900 },
    ],
  };
  const verifier = {
    verify: vi.fn()
      .mockResolvedValueOnce({ ok: false, slides: [{ slideId: "slide-01", issues: ["overflow"] }, { slideId: "slide-07", issues: ["blank-canvas"] }], consoleErrors: [], contactSheetArtifactId: "contact-sheet" })
      .mockResolvedValueOnce({ ok: false, slides: [{ slideId: "slide-01", issues: ["overflow"] }, { slideId: "slide-07", issues: [] }], consoleErrors: [] })
      .mockResolvedValueOnce({ ok: true, slides: [{ slideId: "slide-01", issues: [] }, { slideId: "slide-07", issues: [] }], consoleErrors: [] }),
  };
  const context = {
    jobId: "job-00000000-0000-4000-8000-000000000007",
    revisionId: "working",
    signal: new AbortController().signal,
    readOutline: vi.fn(async () => outline),
    generateSlides: vi.fn(),
    verifier,
    mergeQaEvidence,
    reviewCalibration: vi.fn(async () => ({ failedSlides: [{ slideId: "slide-01", reasons: ["weak hierarchy"] }], designChanges: ["increase title contrast"] })),
    reviseCalibration: vi.fn(),
    writeDefaultTheme: vi.fn(),
    lockDesignRules: vi.fn(),
  };

  await runCalibrationStage(context);

  expect(context.generateSlides).toHaveBeenNthCalledWith(1, ["slide-01", "slide-07"], { stage: "calibrating", maxUpstreamCalls: 1 });
  expect(context.generateSlides).toHaveBeenNthCalledWith(2, ["slide-01", "slide-07"], { stage: "calibrating", deterministicTheme: true, maxUpstreamCalls: 1 });
  expect(context.reviewCalibration).toHaveBeenCalledWith({ slideIds: ["slide-01", "slide-07"], contactSheetArtifactId: "contact-sheet", maxUpstreamCalls: 1 });
  expect(context.reviseCalibration).toHaveBeenCalledTimes(1);
  expect(context.writeDefaultTheme).toHaveBeenCalledTimes(1);
  expect(verifier.verify).toHaveBeenCalledTimes(3);
  expect(context.lockDesignRules).toHaveBeenCalledWith({ slideIds: ["slide-01", "slide-07"], report: expect.objectContaining({ ok: true }) });
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
