import { describe, expect, it, vi } from "vitest";
import { createDeckJobOrchestrator } from "../../../server/deck-agent/orchestrator.mjs";
import { publishDeck } from "../../../server/deck-agent/stages/publish-stage.mjs";
import {
  applyDeterministicRepairs,
  runVerificationStage,
} from "../../../server/deck-agent/stages/verify-stage.mjs";

const jobId = "job-00000000-0000-4000-8000-000000000008";

function report(slides, { contactSheetArtifactId = "contact-sheet", consoleErrors = [] } = {}) {
  return {
    ok: slides.every((slide) => slide.issues.length === 0) && consoleErrors.length === 0,
    slides,
    consoleErrors,
    contactSheetArtifactId,
  };
}

describe("whole-deck verification", () => {
  it("uses bounded non-model repairs for broken assets, fonts, and overflow", async () => {
    const context = {
      markBrokenAssetSlotsEmpty: vi.fn(async () => true),
      useBundledFontFallback: vi.fn(async () => true),
      setTightDensity: vi.fn(async () => true),
    };
    const qa = report([
      { slideId: "slide-01", issues: ["broken-image", "vertical-overflow"] },
      { slideId: "slide-02", issues: ["font-load-failed"] },
      { slideId: "slide-03", issues: ["visual:weak-hierarchy"] },
    ]);

    const changed = await applyDeterministicRepairs(
      context,
      ["slide-01", "slide-02", "slide-03"],
      qa,
    );

    expect(context.markBrokenAssetSlotsEmpty).toHaveBeenCalledOnce();
    expect(context.setTightDensity).toHaveBeenCalledOnce();
    expect(context.useBundledFontFallback).toHaveBeenCalledOnce();
    expect(changed).toEqual(["slide-01", "slide-02"]);
  });

  it("reviews the whole deck once, repairs only failed slides once, and rechecks only those slides", async () => {
    const initial = report([
      { slideId: "slide-01", issues: [], screenshotArtifactId: "shot-01" },
      { slideId: "slide-02", issues: ["vertical-overflow"], screenshotArtifactId: "shot-02" },
      { slideId: "slide-03", issues: [], screenshotArtifactId: "shot-03" },
    ]);
    const repaired = report([
      { slideId: "slide-01", issues: [], screenshotArtifactId: "shot-01-final" },
      { slideId: "slide-02", issues: [], screenshotArtifactId: "shot-02-fixed" },
      { slideId: "slide-03", issues: [], screenshotArtifactId: "shot-03-fixed" },
    ], { contactSheetArtifactId: "contact-sheet-fixed" });
    const verifier = { verify: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(repaired) };
    const context = {
      jobId,
      revisionId: "working",
      allSlideIds: ["slide-01", "slide-02", "slide-03"],
      signal: new AbortController().signal,
      verifier,
      applyDeterministicRepairs: vi.fn(async () => []),
      reviewContactSheet: vi.fn(async () => ({
        failedSlides: [{ slideId: "slide-03", reasons: ["weak hierarchy"] }],
      })),
      transition: vi.fn(),
      repairSlides: vi.fn(),
      reviewRepairedSlides: vi.fn(async () => ({
        failedSlides: [{ slideId: "slide-03", reasons: ["weak hierarchy"] }],
      })),
    };

    const result = await runVerificationStage(context);

    expect(context.reviewContactSheet).toHaveBeenCalledTimes(1);
    expect(context.reviewContactSheet).toHaveBeenCalledWith({
      slideIds: ["slide-01", "slide-02", "slide-03"],
      screenshotArtifactIds: ["shot-01", "shot-02", "shot-03"],
      contactSheetArtifactId: "contact-sheet",
      maxUpstreamCalls: 1,
    });
    expect(context.repairSlides).toHaveBeenCalledTimes(1);
    expect(context.repairSlides).toHaveBeenCalledWith(
      ["slide-02", "slide-03"],
      expect.objectContaining({ report: expect.any(Object), maxUpstreamCalls: 1 }),
    );
    expect(verifier.verify).toHaveBeenNthCalledWith(2, expect.objectContaining({
      slideIds: ["slide-01", "slide-02", "slide-03"],
      captureContactSheet: true,
    }));
    expect(context.reviewRepairedSlides).toHaveBeenCalledWith({
      slideIds: ["slide-02", "slide-03"],
      screenshotArtifactIds: ["shot-02-fixed", "shot-03-fixed"],
      contactSheetArtifactId: "contact-sheet-fixed",
      priorReport: expect.objectContaining({ ok: false }),
      maxUpstreamCalls: 1,
    });
    expect(result.status).toBe("needs-review");
  });

  it("rejects visual-review failures for slides outside the deck", async () => {
    const context = {
      jobId,
      revisionId: "working",
      allSlideIds: ["slide-01"],
      signal: new AbortController().signal,
      verifier: { verify: vi.fn(async () => report([{ slideId: "slide-01", issues: [] }])) },
      applyDeterministicRepairs: vi.fn(async () => []),
      reviewContactSheet: vi.fn(async () => ({ failedSlides: [{ slideId: "slide-99", reasons: ["bad"] }] })),
    };

    await expect(runVerificationStage(context)).rejects.toThrow(/outside.*deck/i);
  });

  it("restores the full slide order from the working manifest", async () => {
    const verifier = {
      verify: vi.fn(async (_request) => report([
        { slideId: "slide-01", issues: [], screenshotArtifactId: "shot-01" },
        { slideId: "slide-02", issues: [], screenshotArtifactId: "shot-02" },
      ])),
    };
    const context = {
      jobId,
      revisionId: "working",
      signal: new AbortController().signal,
      store: {
        readJson: vi.fn(async () => ({ slides: [{ slideId: "slide-01" }, { slideId: "slide-02" }] })),
      },
      verifier,
      reviewContactSheet: vi.fn(async () => ({ failedSlides: [] })),
    };

    await expect(runVerificationStage(context)).resolves.toMatchObject({ status: "ready" });
    expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({
      slideIds: ["slide-01", "slide-02"],
      captureContactSheet: true,
    }));
  });
});

describe("publication", () => {
  it("writes the offline deck and revision files before switching the current pointer", async () => {
    const files = new Map([
      ["working/manifest.json", {
        slides: [
          { slideId: "slide-01" },
          { slideId: "slide-02" },
        ],
      }],
      ["working/theme.css", ":root{--deck-bg:#fff}"],
      ["working/slides/slide-01.html", "<h1>One</h1>"],
      ["working/slides/slide-01.css", "[data-slide-root]{}"],
      ["working/slides/slide-02.html", "<h1>Two</h1>"],
      ["working/slides/slide-02.css", "[data-slide-root]{}"],
    ]);
    const writes = [];
    const store = {
      readJob: vi.fn(async () => ({ revision: 0 })),
      readArtifact: vi.fn(async (_jobId, name) => files.get(name)),
      readJson: vi.fn(async (_jobId, name) => structuredClone(files.get(name))),
      writeArtifact: vi.fn(async (_jobId, name, value) => { writes.push(name); files.set(name, value); }),
      writeJson: vi.fn(async (_jobId, name, value) => { writes.push(name); files.set(name, structuredClone(value)); }),
      updateJob: vi.fn(async () => {}),
    };
    const renderer = { assembleStandalone: vi.fn(async () => "<!doctype html><title>Deck</title>") };

    const result = await publishDeck({
      jobId,
      store,
      renderer,
      signal: new AbortController().signal,
      result: { status: "ready", report: report([{ slideId: "slide-01", issues: [] }, { slideId: "slide-02", issues: [] }]) },
    });

    expect(result).toMatchObject({ revision: 1, revisionId: "revision-000001" });
    expect(files.get("working/dist/index.html")).toContain("<!doctype html>");
    expect(files.get("revisions/revision-000001/dist/index.html")).toContain("<!doctype html>");
    expect(files.get("current-revision.json")).toEqual({ revision: 1, revisionId: "revision-000001", status: "ready" });
    expect(writes.indexOf("current-revision.json")).toBeGreaterThan(writes.indexOf("revisions/revision-000001/dist/index.html"));
  });
});

describe("job orchestration", () => {
  it("advances through persisted checkpoints and publishes without a user gate", async () => {
    let job = {
      id: jobId,
      status: "queued",
      checkpoints: [],
      revision: 0,
    };
    const calls = [];
    const handlers = Object.fromEntries(
      ["outline", "design", "calibrating", "building", "generating-assets"].map((stage) => [
        stage,
        vi.fn(async () => { calls.push(stage); return { stage }; }),
      ]),
    );
    handlers.verifying = vi.fn(async () => {
      calls.push("verifying");
      return { status: "ready", report: report([]) };
    });
    const deps = {
      store: { readJob: vi.fn(async () => structuredClone(job)) },
      handlers,
      transition: vi.fn(async (_jobId, status) => { job = { ...job, status }; }),
      checkpoint: vi.fn(async (_jobId, stage) => { job = { ...job, checkpoints: [...job.checkpoints, stage] }; }),
      publishDeck: vi.fn(async () => ({ revision: 1 })),
      fail: vi.fn(),
      waitForUser: vi.fn(),
    };
    deps.transition.mockImplementation(async (_jobId, status) => { job = { ...job, status }; });

    const result = await createDeckJobOrchestrator(deps).run(jobId, { signal: new AbortController().signal });

    expect(calls).toEqual(["outline", "design", "calibrating", "building", "generating-assets", "verifying"]);
    expect(deps.publishDeck).toHaveBeenCalledTimes(1);
    expect(deps.waitForUser).not.toHaveBeenCalled();
    expect(result.status).toBe("ready");
  });
});
