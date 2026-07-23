import { createRevisionStore } from "../revision-store.mjs";

export async function publishDeck(context) {
  const { jobId, store, renderer, result, signal } = context;
  if (!result || !["ready", "needs-review"].includes(result.status) || !result.report) {
    throw new Error("Publication requires a verified deck result");
  }

  signal?.throwIfAborted();
  await store.writeJson(jobId, "working/qa/report.json", result.report, { signal });
  const standalone = await renderer.assembleStandalone({ jobId, revisionId: "working", signal });
  await store.writeArtifact(jobId, "working/dist/index.html", standalone, { signal });

  const revisions = context.revisions || createRevisionStore({
    store,
    now: context.now || (() => new Date().toISOString()),
  });
  const published = await revisions.createInitial(jobId, {
    status: result.status,
    qa: result.report,
    signal,
  });
  return { revision: published.number, revisionId: published.revisionId, status: result.status };
}
