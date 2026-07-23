import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createRevisionStore } from "../../../server/deck-agent/revision-store.mjs";

const jobId = "job-00000000-0000-4000-8000-000000000009";
const themeCss = ":root{--deck-bg:#fff}";

async function seedWorking(store) {
  await store.createJob({
    jobId,
    title: "Revision test",
    input: { source: {}, options: {} },
    sourceBlocks: [],
  });
  await store.writeJson(jobId, "working/manifest.json", {
    title: "Revision test",
    slides: [
      { slideId: "slide-01" },
      { slideId: "slide-02" },
      { slideId: "slide-03" },
    ],
  });
  await store.writeArtifact(jobId, "working/theme.css", themeCss);
  for (const slideId of ["slide-01", "slide-02", "slide-03"]) {
    await store.writeArtifact(jobId, `working/slides/${slideId}.html`, `<h1>${slideId}</h1>`);
    await store.writeArtifact(jobId, `working/slides/${slideId}.css`, `[data-slide-id="${slideId}"]{color:#111}`);
  }
  await store.writeJson(jobId, "working/qa/report.json", { ok: true, slides: [] });
  await store.writeArtifact(jobId, "working/qa/contact-sheet.png", Buffer.from("old screenshot"));
  await store.writeArtifact(jobId, "working/dist/index.html", "<!doctype html><title>Initial</title>");
}

async function createPassingCandidate(revisions, parentRevision, instruction = "放大标题") {
  const candidate = await revisions.createCandidate(jobId, {
    parentRevision,
    instruction,
    scope: "slides",
    slideIds: ["slide-03"],
  });
  await revisions.recordQa(jobId, candidate.number, {
    ok: true,
    slides: [{ slideId: "slide-03", issues: [] }],
    consoleErrors: [],
  }, { changedFiles: ["slides/slide-03.html"] });
  return candidate;
}

describe("revision store", () => {
  let store;
  let revisions;

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-revisions-"));
    store = createArtifactStore({ rootDir });
    await seedWorking(store);
    revisions = createRevisionStore({ store, now: () => "2026-07-23T00:00:00.000Z" });
  });

  it("does not publish a candidate that failed QA", async () => {
    const parent = await revisions.createInitial(jobId, { status: "ready" });
    const candidate = await revisions.createCandidate(jobId, {
      parentRevision: parent.number,
      instruction: "放大标题",
      scope: "slides",
      slideIds: ["slide-03"],
    });
    await revisions.recordQa(jobId, candidate.number, {
      ok: false,
      slides: [{ slideId: "slide-03", issues: ["overflow"] }],
      consoleErrors: [],
    });

    await expect(revisions.publishCandidate(jobId, candidate.number, {
      expectedRevision: parent.number,
    })).rejects.toMatchObject({ status: 409 });
    expect((await revisions.readCurrent(jobId)).number).toBe(parent.number);
    expect((await store.readJob(jobId)).revision).toBe(parent.number);
    expect(await store.readArtifact(jobId, "revisions/revision-000001/qa/contact-sheet.png", { encoding: null }))
      .toEqual(Buffer.from("old screenshot"));
    expect(await store.readArtifact(jobId, `revisions/${candidate.revisionId}/qa/contact-sheet.png`, { optional: true, encoding: null }))
      .toBeUndefined();
    expect((await store.listArtifacts(jobId)).some((artifact) => artifact.id.includes("candidate"))).toBe(false);
  });

  it("rejects a stale expected revision and a candidate whose parent is no longer current", async () => {
    const parent = await revisions.createInitial(jobId, { status: "ready" });
    const winner = await createPassingCandidate(revisions, parent.number, "winner");
    const stale = await createPassingCandidate(revisions, parent.number, "stale");

    await expect(revisions.publishCandidate(jobId, winner.number, {
      expectedRevision: parent.number + 1,
    })).rejects.toMatchObject({ status: 409 });
    expect((await revisions.readCurrent(jobId)).number).toBe(parent.number);

    await revisions.publishCandidate(jobId, winner.number, { expectedRevision: parent.number });
    await expect(revisions.publishCandidate(jobId, stale.number, {
      expectedRevision: winner.number,
    })).rejects.toMatchObject({ status: 409 });
    expect((await revisions.readCurrent(jobId)).number).toBe(winner.number);
  });

  it("publishes by one atomic pointer write and undo returns to the parent", async () => {
    const parent = await revisions.createInitial(jobId, { status: "ready" });
    const candidate = await createPassingCandidate(revisions, parent.number);
    const writeJson = vi.spyOn(store, "writeJson");
    const published = await revisions.publishCandidate(jobId, candidate.number, {
      expectedRevision: parent.number,
    });

    expect(published).toMatchObject({ number: 2, revisionId: "revision-000002" });
    expect((await revisions.readCurrent(jobId)).number).toBe(candidate.number);
    expect((await store.readJob(jobId)).revision).toBe(candidate.number);
    expect(writeJson.mock.calls.filter(([, relativePath]) => relativePath === "current-revision.json"))
      .toHaveLength(1);
    await expect(revisions.undo(jobId, { expectedRevision: parent.number })).rejects
      .toMatchObject({ status: 409 });

    const undone = await revisions.undo(jobId, { expectedRevision: candidate.number });
    expect(undone).toMatchObject({ number: parent.number, revisionId: "revision-000001" });
    expect((await revisions.readCurrent(jobId)).number).toBe(parent.number);
    expect((await store.readJob(jobId)).revision).toBe(parent.number);
  });

  it("resolves only immutable source artifacts, current preview/download, and job assets", async () => {
    await store.writeArtifact(jobId, "slides-content.md", "# Immutable outline\n");
    const parent = await revisions.createInitial(jobId, { status: "ready" });

    await expect(revisions.resolveRevisionArtifact(jobId, "slides-content")).resolves.toEqual({
      id: "slides-content",
      relativePath: "slides-content.md",
    });
    await expect(revisions.resolveRevisionArtifact(jobId, "deck-preview")).resolves.toMatchObject({
      id: "deck-preview",
      relativePath: `revisions/${parent.revisionId}/dist/index.html`,
      revisionId: parent.revisionId,
      preview: true,
    });
    await expect(revisions.resolveRevisionArtifact(jobId, "not-registered")).resolves.toBeUndefined();
  });
});
