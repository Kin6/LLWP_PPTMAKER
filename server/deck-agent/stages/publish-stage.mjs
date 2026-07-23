const SLIDE_ID = /^slide-\d{2}$/;

function revisionIdFor(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999_999) {
    throw new Error("Revision limit exceeded");
  }
  return `revision-${String(revision).padStart(6, "0")}`;
}
async function copyText(store, jobId, from, to, signal) {
  signal?.throwIfAborted();
  const value = await store.readArtifact(jobId, from);
  if (typeof value !== "string") throw new Error(`Missing publication artifact: ${from}`);
  await store.writeArtifact(jobId, to, value, { signal });
}

export async function publishDeck(context) {
  const { jobId, store, renderer, result, signal } = context;
  if (!result || !["ready", "needs-review"].includes(result.status) || !result.report) {
    throw new Error("Publication requires a verified deck result");
  }

  signal?.throwIfAborted();
  await store.writeJson(jobId, "working/qa/report.json", result.report, { signal });
  const standalone = await renderer.assembleStandalone({ jobId, revisionId: "working", signal });
  await store.writeArtifact(jobId, "working/dist/index.html", standalone, { signal });

  const job = await store.readJob(jobId);
  const revision = job.revision + 1;
  const revisionId = revisionIdFor(revision);
  const prefix = `revisions/${revisionId}`;
  const manifest = await store.readJson(jobId, "working/manifest.json");
  const slideIds = (manifest?.slides || []).map((slide) => slide?.slideId);
  if (!slideIds.length || slideIds.some((slideId) => !SLIDE_ID.test(slideId)) || new Set(slideIds).size !== slideIds.length) {
    throw new Error("Publication manifest has invalid slide identities");
  }

  await store.writeJson(jobId, `${prefix}/manifest.json`, manifest, { signal });
  await copyText(store, jobId, "working/theme.css", `${prefix}/theme.css`, signal);
  for (const slideId of slideIds) {
    await copyText(store, jobId, `working/slides/${slideId}.html`, `${prefix}/slides/${slideId}.html`, signal);
    await copyText(store, jobId, `working/slides/${slideId}.css`, `${prefix}/slides/${slideId}.css`, signal);
  }
  await store.writeJson(jobId, `${prefix}/qa/report.json`, result.report, { signal });
  await store.writeArtifact(jobId, `${prefix}/dist/index.html`, standalone, { signal });
  await store.writeJson(jobId, `${prefix}/meta.json`, {
    revision,
    revisionId,
    status: result.status,
    createdAt: (context.now || (() => new Date().toISOString()))(),
  }, { signal });

  // This pointer is the publication boundary: incomplete revision directories stay invisible.
  await store.writeJson(jobId, "current-revision.json", {
    revision,
    revisionId,
    status: result.status,
  }, { signal });
  await store.updateJob(jobId, { revision }, { signal });
  return { revision, revisionId, status: result.status };
}
