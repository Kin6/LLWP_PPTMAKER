import path from "node:path";
import { createArtifactStore } from "../../server/deck-agent/artifact-store.mjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const REVISION_ID = /^(?:working|revision-\d{6})$/;
const COMPLETE_THEME_CSS = ":root{--deck-bg:#ffffff;--deck-surface:#f4f5f7;--deck-text:#111111;--deck-muted:#555555;--deck-primary:#075ccb;--deck-secondary:#243447;--deck-accent:#d9363e;--deck-positive:#14804a;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:72px;--deck-heading-size:48px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:8px;--deck-space:24px;--deck-grid-gap:32px;}";
const OUTLINE = `# Runtime QA Fixture

> **叙事主线：** Evidence -> Decision

## 幻灯片 1：Evidence

**核心观点：** Evidence first.

**演讲备注：** Explain the evidence.

**材料来源：**

- Research page 3 <!-- source:block-018 -->

## 幻灯片 2：Decision

**核心观点：** Make the decision.

**演讲备注：** Close with the decision.

**材料来源：**

- Research page 8 <!-- source:block-031 -->
`;

export async function seedRuntimeJob(rootDir, jobId, revisionId) {
  if (typeof rootDir !== "string" || !rootDir || !JOB_ID.test(jobId) || !REVISION_ID.test(revisionId)) {
    throw new Error("Usage: seed-runtime-job.mjs <root> <job-id> <working|revision-NNNNNN>");
  }
  const store = createArtifactStore({ rootDir: path.resolve(rootDir) });
  const sourceBlocks = [{ id: "block-018" }, { id: "block-031" }];
  await store.createJob({
    jobId,
    title: "Runtime QA Fixture",
    input: {
      source: {
        topic: "Runtime QA Fixture", audience: "reviewers", slideCount: 2,
        textInput: "Evidence and decision", tableInput: "", imageBrief: "", styleId: "corporate-clean",
      },
      options: {},
    },
    sourceBlocks,
  });
  await store.writeArtifact(jobId, "slides-content.md", OUTLINE);

  const prefix = revisionId === "working" ? "working" : `revisions/${revisionId}`;
  await store.writeJson(jobId, `${prefix}/manifest.json`, {
    version: 1,
    title: "Runtime QA Fixture",
    assets: [],
    slides: [
      {
        slideId: "slide-01", title: "Evidence", speakerNotes: "Explain the evidence.",
        sourceRefs: ["block-018"], density: "normal", status: "done", charts: [], assetSlots: [],
      },
      {
        slideId: "slide-02", title: "Decision", speakerNotes: "Close with the decision.",
        sourceRefs: ["block-031"], density: "normal", status: "done", charts: [], assetSlots: [],
      },
    ],
  });
  await store.writeArtifact(jobId, `${prefix}/theme.css`, COMPLETE_THEME_CSS);
  await store.writeArtifact(jobId, `${prefix}/slides/slide-01.html`, "<h1>Evidence first</h1><p>Ground the decision in verified facts.</p>");
  await store.writeArtifact(jobId, `${prefix}/slides/slide-01.css`, '[data-slide-id="slide-01"]{box-sizing:border-box;width:1920px;height:1080px;padding:120px;background:#ffffff;color:#111111;letter-spacing:0}[data-slide-id="slide-01"] h1{font-size:72px;line-height:1.1;letter-spacing:0}');
  await store.writeArtifact(jobId, `${prefix}/slides/slide-02.html`, "<h1>Make the decision</h1><p>Act on the evidence now.</p>");
  await store.writeArtifact(jobId, `${prefix}/slides/slide-02.css`, '[data-slide-id="slide-02"]{box-sizing:border-box;width:1920px;height:1080px;padding:120px;background:#ffffff;color:#111111;letter-spacing:0}[data-slide-id="slide-02"] h1{font-size:72px;line-height:1.1;letter-spacing:0}');
  if (revisionId !== "working") {
    await store.writeJson(jobId, `${prefix}/meta.json`, { revisionId, createdAt: new Date(0).toISOString() });
  }
  return { ok: true, rootDir: path.resolve(rootDir), jobId, revisionId, slideIds: ["slide-01", "slide-02"] };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  seedRuntimeJob(...process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 500) })}\n`);
      process.exitCode = 1;
    },
  );
}
