import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createDeckJobOrchestrator } from "../../../server/deck-agent/orchestrator.mjs";
import { createRenderer } from "../../../server/deck-agent/renderer.mjs";
import { createRevisionStore } from "../../../server/deck-agent/revision-store.mjs";
import { resolveEditScope } from "../../../server/deck-agent/stages/revision-stage.mjs";
import { mergeQaEvidence } from "../../../server/deck-agent/verifier.mjs";
import {
  createProductionRevisionDependencies,
  runWorkerCommand,
} from "../../../server/deck-agent/worker-entry.mjs";

const jobId = "job-00000000-0000-4000-8000-000000000019";
const allSlideIds = ["slide-01", "slide-02", "slide-03", "slide-04", "slide-05"];
const manifest = { slides: allSlideIds.map((slideId) => ({ slideId })) };

function revisionHarness({ classification = { scope: "slides", slideIds: [] }, qaOk = true } = {}) {
  const classifier = vi.fn(async () => classification);
  const patchCandidate = vi.fn(async (_candidate, { classification: effective, slideIds }) => ({
    changedFiles: effective.scope === "theme" ? ["theme.css"] : [`slides/${slideIds[0]}.html`],
  }));
  const verifier = {
    verify: vi.fn(async ({ slideIds }) => ({
      ok: qaOk,
      slides: slideIds.map((slideId) => ({ slideId, issues: qaOk ? [] : ["overflow"] })),
      consoleErrors: [],
      contactSheetArtifactId: "candidate-contact-sheet",
    })),
  };
  let current = { number: 1, revisionId: "revision-000001" };
  const revisions = {
    readCurrent: vi.fn(async () => current),
    createCandidate: vi.fn(async () => ({ number: 2, revisionId: ".candidate-00000000-0000-4000-8000-000000000019" })),
    recordQa: vi.fn(async () => {}),
    publishCandidate: vi.fn(async () => {
      current = { number: 2, revisionId: "revision-000002" };
      return current;
    }),
    discardCandidate: vi.fn(async () => {}),
  };
  const deps = {
    store: { readJob: vi.fn(async () => ({ status: "ready" })) },
    revisions,
    readRevisionManifest: vi.fn(async () => manifest),
    classifyInstruction: classifier,
    patchCandidate,
    verifier,
    reviewCandidate: vi.fn(async () => ({ failedSlides: [], designChanges: [] })),
    mergeQaEvidence: vi.fn((dom) => dom),
    renderCandidate: vi.fn(async () => {}),
  };
  return {
    orchestrator: createDeckJobOrchestrator(deps),
    classifier,
    patchCandidate,
    verifier,
    revisions,
  };
}

describe("revision stage", () => {
  it("defaults an unnumbered instruction to the current preview slide", async () => {
    const { orchestrator, patchCandidate, verifier } = revisionHarness();
    await orchestrator.applyMessage(jobId, {
      instruction: "把结论写得更直接",
      currentSlideId: "slide-05",
      expectedRevision: 1,
    }, { signal: new AbortController().signal });

    expect(patchCandidate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      slideIds: ["slide-05"],
    }));
    expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({ slideIds: ["slide-05"] }));
  });

  it("keeps explicit page targets even when the classifier suggests a theme edit", async () => {
    const { orchestrator, patchCandidate, verifier } = revisionHarness({
      classification: { scope: "theme", slideIds: [] },
    });
    await orchestrator.applyMessage(jobId, {
      instruction: "把这些页改成深色",
      slideIds: ["slide-03"],
      currentSlideId: "slide-02",
      expectedRevision: 1,
    }, { signal: new AbortController().signal });

    expect(patchCandidate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      slideIds: ["slide-03"],
      classification: expect.objectContaining({ scope: "slides", slideIds: ["slide-03"] }),
    }));
    expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({ slideIds: ["slide-03"] }));
  });

  it("rechecks every slide for a whole-theme edit and rejects narrative rewrites", async () => {
    const theme = revisionHarness({ classification: { scope: "theme", slideIds: [] } });
    await theme.orchestrator.applyMessage(jobId, {
      instruction: "整套改成深色发布会风格",
      currentSlideId: "slide-02",
      expectedRevision: 1,
    }, { signal: new AbortController().signal });
    expect(theme.verifier.verify).toHaveBeenCalledWith(expect.objectContaining({ slideIds: allSlideIds }));

    const rewrite = revisionHarness({ classification: { scope: "new-job-required", slideIds: [] } });
    await expect(rewrite.orchestrator.applyMessage(jobId, {
      instruction: "完全重写叙事",
      currentSlideId: "slide-02",
      expectedRevision: 1,
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ status: 409 });
    expect(rewrite.revisions.createCandidate).not.toHaveBeenCalled();
  });

  it("leaves the published pointer unchanged when candidate QA fails", async () => {
    const { orchestrator, revisions } = revisionHarness({ qaOk: false });
    await expect(orchestrator.applyMessage(jobId, {
      instruction: "放大标题",
      currentSlideId: "slide-03",
      expectedRevision: 1,
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ status: 409 });
    expect(revisions.publishCandidate).not.toHaveBeenCalled();
    expect(revisions.discardCandidate).toHaveBeenCalledTimes(1);
    expect((await revisions.readCurrent(jobId)).number).toBe(1);
  });

  it("rejects unknown slide targets and stale revisions before creating a candidate", async () => {
    expect(() => resolveEditScope({ slideIds: ["slide-99"] }, { scope: "slides", slideIds: [] }, manifest))
      .toThrow(/unknown slide/i);
    const { orchestrator, revisions } = revisionHarness();
    await expect(orchestrator.applyMessage(jobId, {
      instruction: "修改标题",
      currentSlideId: "slide-02",
      expectedRevision: 9,
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ status: 409 });
    expect(revisions.createCandidate).not.toHaveBeenCalled();
  });
});

describe("revision worker wiring", () => {
  it("dispatches a revision command to a real orchestrator applyMessage entry point", async () => {
    const applyMessage = vi.fn(async () => ({ number: 2, revisionId: "revision-000002" }));
    const orchestrator = { applyMessage };
    const signal = new AbortController().signal;
    const request = { instruction: "修改标题", currentSlideId: "slide-01", expectedRevision: 1 };

    await expect(runWorkerCommand({ type: "revision", jobId, request }, {
      signal,
      runtimeFactory: async () => ({ orchestrator, store: {} }),
    })).resolves.toMatchObject({ number: 2 });
    expect(applyMessage).toHaveBeenCalledWith(jobId, request, { signal });
  });

  it("publishes, undoes, and fences failed QA through the production revision dependencies", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-revision-worker-"));
    const store = createArtifactStore({ rootDir });
    const revisions = createRevisionStore({ store, now: () => "2026-07-23T00:00:00.000Z" });
    const outline = "# Immutable revision outline\n";
    await store.createJob({
      jobId,
      title: "Worker revision",
      input: { source: { slideCount: 1 }, options: {} },
      sourceBlocks: [{ id: "block-001" }],
    });
    await store.writeArtifact(jobId, "slides-content.md", outline);
    await store.writeJson(jobId, "working/manifest.json", {
      title: "Worker revision",
      assets: [],
      slides: [{
        slideId: "slide-01",
        title: "Before",
        speakerNotes: "Explain the decision.",
        sourceRefs: ["block-001"],
        charts: [],
        assetSlots: [],
        status: "done",
      }],
    });
    const themeCss = ":root{--deck-bg:#ffffff;--deck-surface:#f4f5f7;--deck-text:#111111;--deck-muted:#555555;--deck-primary:#075ccb;--deck-secondary:#243447;--deck-accent:#d9363e;--deck-positive:#14804a;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:72px;--deck-heading-size:48px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:8px;--deck-space:24px;--deck-grid-gap:32px;}";
    await store.writeArtifact(jobId, "working/theme.css", themeCss);
    await store.writeArtifact(jobId, "working/slides/slide-01.html", "<h1>Before</h1>");
    await store.writeArtifact(jobId, "working/slides/slide-01.css", '[data-slide-id="slide-01"] h1{color:#111111;letter-spacing:0}');
    await store.writeJson(jobId, "working/qa/report.json", { ok: true, slides: [], consoleErrors: [] });
    await store.writeArtifact(jobId, "working/dist/index.html", "<!doctype html><title>Before</title>");
    await revisions.createInitial(jobId, { status: "ready" });
    await store.updateJob(jobId, { status: "ready" });

    let qaOk = true;
    const verifier = {
      verify: vi.fn(async ({ revisionId, slideIds }) => {
        await store.writeArtifact(jobId, `revisions/${revisionId}/qa/contact-sheet.png`, Buffer.from("contact"));
        await Promise.all(slideIds.map((slideId) => store.writeArtifact(
          jobId,
          `revisions/${revisionId}/qa/slides/${slideId}.png`,
          Buffer.from(`full-resolution-${slideId}`),
        )));
        return {
          ok: qaOk,
          slides: slideIds.map((slideId) => ({
            slideId,
            issues: qaOk ? [] : ["overflow"],
            screenshotArtifactId: `candidate-${slideId}`,
          })),
          consoleErrors: [],
          contactSheetArtifactId: "candidate-contact-sheet",
        };
      }),
    };
    const renderer = createRenderer({
      store,
      runtimeRoot: path.resolve("skills/generate-html-deck/assets/runtime"),
      appOrigin: "http://127.0.0.1:5173",
    });
    const modelClient = { completeStructured: vi.fn() };
    const skillLoader = { load: vi.fn(async () => ({ instructions: "Review the candidate." })) };
    const sourceBlocks = [{ id: "block-001" }];
    const signal = new AbortController().signal;

    function queueModelPass(text) {
      modelClient.completeStructured
        .mockResolvedValueOnce({ apiCalls: 3, value: { scope: "slides", slideIds: ["slide-01"] } })
        .mockResolvedValueOnce({
          apiCalls: 1,
          value: {
            slides: [{
              slideId: "slide-01",
              html: `<h1>${text}</h1>`,
              css: '[data-slide-id="slide-01"] h1{color:#111111;letter-spacing:0}',
            }],
          },
        })
        .mockResolvedValueOnce({ apiCalls: 1, value: { failedSlides: [], designChanges: [] } });
    }

    const production = createProductionRevisionDependencies({
      jobId,
      store,
      revisions,
      renderer,
      verifier,
      modelClient,
      skillLoader,
      sourceBlocks,
      readVisibleOutline: vi.fn(async (slideIds) => ({
        title: "Visible outline",
        narrative: "Evidence to action",
        slides: slideIds.map((slideId) => ({ slideId, title: "Before", markdown: "Visible content" })),
      })),
      signal,
    });
    const orchestrator = createDeckJobOrchestrator({
      store,
      revisions,
      verifier,
      ...production,
      mergeQaEvidence,
    });
    const runtimeFactory = async () => ({ store, orchestrator });

    queueModelPass("After");
    await runWorkerCommand({
      type: "revision",
      jobId,
      request: { instruction: "Make the title direct", currentSlideId: "slide-01", expectedRevision: 1 },
    }, { signal, runtimeFactory });
    expect((await revisions.readCurrent(jobId)).number).toBe(2);
    expect((await store.readJob(jobId)).revision).toBe(2);
    expect(await store.readArtifact(jobId, "revisions/revision-000002/slides/slide-01.html")).toContain("After");
    expect(await store.readArtifact(jobId, "slides-content.md")).toBe(outline);
    const patchRequest = JSON.parse(modelClient.completeStructured.mock.calls[1][0].messages.at(-1).content);
    expect(patchRequest).toMatchObject({ instruction: "Make the title direct", priorFindings: [] });
    const reviewCall = modelClient.completeStructured.mock.calls[2][0];
    expect(reviewCall.images).toEqual([expect.objectContaining({
      name: "slide-01.png",
      summary: expect.stringMatching(/1920x1080.*slide-01/i),
    })]);
    const reviewRequest = JSON.parse(reviewCall.messages.at(-1).content);
    expect(reviewRequest).toMatchObject({
      instruction: "Make the title direct",
      priorFindings: [],
      visibleOutline: { title: "Visible outline" },
    });
    expect(reviewRequest.reviewInstruction).toMatch(/full-resolution 1920x1080/i);

    await revisions.undo(jobId, { expectedRevision: 2 });
    expect((await revisions.readCurrent(jobId)).number).toBe(1);

    qaOk = false;
    queueModelPass("Rejected");
    await expect(runWorkerCommand({
      type: "revision",
      jobId,
      request: { instruction: "Make it overflow", currentSlideId: "slide-01", expectedRevision: 1 },
    }, { signal, runtimeFactory })).rejects.toMatchObject({ status: 409 });
    expect((await revisions.readCurrent(jobId)).number).toBe(1);
    expect((await store.readJob(jobId)).revision).toBe(1);
    expect(await store.readArtifact(jobId, "slides-content.md")).toBe(outline);
  });
});
