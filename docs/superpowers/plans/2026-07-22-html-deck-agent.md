# HTML Deck Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HTML-mode `NotebookDeckSpec -> HtmlDeckSpec -> object editor` path with a durable, Manus-style Deck Agent that creates a source-grounded Markdown outline, one calibrated HTML/CSS design, verified local assets, and a standalone offline deck.

**Architecture:** Keep the existing attachment parser and PPTX workflows, but route HTML requests into a server-owned job state machine whose event log and artifacts are persisted under one job workspace. A restricted, provider-compatible Agent runner may call only stage-specific tools; all generated Markdown, HTML, CSS, asset paths, revisions, and browser messages are validated by deterministic code before publication. The React client stores only the active `jobId`, reconstructs the Agent timeline from sequenced NDJSON events, and previews read-only artifacts in strict sandbox frames.

**Tech Stack:** React 18, TypeScript 5.5, Express 4, Zod 4, unified/remark/mdast, parse5, css-tree, Reveal.js 6.0.1, ECharts 6.1.0, Playwright 1.61.1, Vitest, Testing Library, and Supertest.

## Global Constraints

- Preserve `src/lib/attachmentParser.ts`, `ExtractedBlock`, `SourceLocation`, `sourceRefs`, environment-only model credentials, compatible-provider fallbacks, and all PPTX modes. In particular, keep the existing OCR `SourceLocation.confidence` percentage scale of 0-100 and its `lowConfidence` semantics.
- The HTML path must never create or consume `NotebookDeckSpec`, `HtmlDeckSpec`, coordinate nodes, editor patches, or IndexedDB deck state.
- `slides-content.md` is a read-only planning snapshot containing only narrative structure, slide titles, core conclusions, content points, speaker notes, and human-readable material sources with valid `source:blockId` comments.
- A valid outline automatically advances to design without a confirmation gate; opening, closing, expanding, or collapsing artifacts must not pause the job.
- Produce one design direction only. Generate the cover and densest content slide for automatic calibration; permit one calibration correction and then lock the design rules.
- Use a fixed 1920 x 1080 logical canvas. Build remaining slides in batches of 2-3 with at most two concurrent batches and checkpoint each valid page independently.
- Resolve real image slots after page layout. Prefer uploaded assets, then licensed internal assets, then optional generation; a failed image request must fall back to a no-image layout without failing the deck.
- Perform one whole-deck visual review, repair only failed slides, permit at most one repair round, and publish persistent failures as `needs-review` rather than `ready`. After that repair, one targeted visual recheck may inspect only the repaired-slide screenshots; it is not a second whole-deck review or a second repair round.
- Models may generate HTML fragments and scoped CSS only. They may not generate JavaScript, React, Vue, TSX, MDX, shell commands, CDN references, arbitrary URLs, or host filesystem paths.
- Treat generated HTML as hostile input. Reject scripts, event handlers, forms, frames, embeds, SVG/MathML, external URLs, unsafe CSS, path traversal, symlink escape, oversized artifacts, and invalid `postMessage` envelopes.
- Preview with `sandbox="allow-scripts"` and no `allow-same-origin`. The fixed message bridge must validate opaque origin `"null"`, exact `event.source`, message type, random channel token, `jobId`, `revision`, and `slideId`.
- The standalone artifact must work offline and contain no API key, provider URL, chat transcript, event log, tool name, job workspace path, or model prompt.
- Normal text-model budget for a 10-slide deck is one outline call, one design call, one calibration-generation call, one calibration review, about three build calls, and one whole-deck review. Compatibility retry/repair calls count against the relevant stage budget.
- Network/model timeout retries, including image-generation timeout retries in the HTML path, are limited to one per stage or request. The HTML Job API accepts `imageMaxRetries` values of only 0 or 1. Markdown repair, calibration correction, and failed-slide repair are each limited to one.
- Development artifacts live under ignored `artifacts/deck-jobs/<jobId>/`; production uses `DECK_JOB_ROOT` outside the repository.
- Default storage quotas are 512 MiB per job, 2 MiB per Markdown file, 200 KiB per slide HTML, 120 KiB per slide CSS, 10 MiB per JSON/NDJSON file, 12 MiB per image, and 256 MiB for standalone `index.html`; exceeding a limit returns `413` before rename.
- Keep Node.js 20 compatibility. Replace existing `node --experimental-strip-types` test commands with `tsx` before claiming the full suite works on the documented runtime.
- Keep the legacy object-model HTML implementation present but unreachable from the new HTML entry point until the complete Task 14 browser/security/offline suite passes. Delete its files, routes, prompts, CSS, and `idb` dependency only after that pre-retirement gate succeeds.

---

## File Map

| Area | Files and responsibility |
| --- | --- |
| Test foundation | `vitest.config.ts`, `playwright.config.ts`, `tests/setup-dom.ts`, `tests/fixtures/deck-agent/**` establish deterministic unit, integration, browser, security, and visual fixtures. |
| Durable contracts | `server/deck-agent/contracts.mjs`, `artifact-store.mjs`, `event-store.mjs`, and `revision-store.mjs` own schemas, transitions, safe atomic files, event replay, and revision publication. |
| Content and skills | `server/deck-agent/outline.mjs`, `skill-loader.mjs`, and `skills/generate-html-deck/**` own the Markdown AST contract and stage-scoped design knowledge. |
| Model boundary | `server/model/**`, `server/images/client.mjs`, and `server/deck-agent/agent-runner.mjs` preserve current provider compatibility while exposing only structured, budgeted Agent turns. |
| Artifact policy | `server/deck-agent/html-policy.mjs`, `css-policy.mjs`, `runtime-template.mjs`, `renderer.mjs`, and `verifier.mjs` validate, assemble, render, screenshot, and package hostile artifacts. |
| Workflow | `server/deck-agent/stages/**`, `orchestrator.mjs`, `job-manager.mjs`, and `routes.mjs` implement deterministic stages, checkpoints, cancellation, retry, recovery, edits, and undo. |
| Frontend data | `src/deck-agent-ui/types.ts`, `api.ts`, `jobReducer.ts`, `jobLocation.ts`, and `useDeckAgentJob.ts` own transport, validation, replay, reconnect, and commands. |
| Frontend views | `src/deck-agent-ui/AgentRunView.tsx`, `AgentMessage.tsx`, `AgentStep.tsx`, `ArtifactPreview.tsx`, `DeckPreview.tsx`, and `deck-agent.css` own the Manus-style timeline and right-side previews. |
| Cutover | `src/App.tsx`, `src/components/HomeScreen.tsx`, `src/lib/apiClient.ts`, `server/index.mjs`, and documentation switch HTML mode while leaving PPTX behavior intact. |
| Retirement | `src/html-deck/**`, legacy HTML routes/prompts, object-editor CSS, and `idb` are removed only after the new end-to-end suite passes. |

### Task 1: Establish the test foundation and durable job contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `tests/setup-dom.ts`
- Create: `server/deck-agent/contracts.mjs`
- Create: `tests/unit/deck-agent/contracts.test.mjs`

**Interfaces:**
- Consumes: existing `zod` dependency and the job/event contract in the approved design spec.
- Produces: `JOB_STAGES`, `TERMINAL_JOB_STATUSES`, `deckJobSchema`, `deckJobSnapshotSchema`, `deckArtifactSchema`, `deckEventSchema`, `createJobRequestSchema`, `assertJobTransition(from, to)`, `assertResumeTransition(from, to)`, and `nextStageAfter(status)`.

- [ ] **Step 1: Write the failing contract tests**

```js
// tests/unit/deck-agent/contracts.test.mjs
import { describe, expect, it } from "vitest";
import {
  assertJobTransition,
  assertResumeTransition,
  createJobRequestSchema,
  deckEventSchema,
  nextStageAfter,
} from "../../../server/deck-agent/contracts.mjs";

describe("deck job contracts", () => {
  it("accepts the deterministic happy-path transitions", () => {
    expect(() => assertJobTransition("queued", "outline")).not.toThrow();
    expect(() => assertJobTransition("verifying", "repairing")).not.toThrow();
    expect(() => assertJobTransition("verifying", "ready")).not.toThrow();
    expect(nextStageAfter("calibrating")).toBe("building");
  });

  it("rejects skipped stages and terminal transitions", () => {
    expect(() => assertJobTransition("outline", "building")).toThrow(/outline -> building/);
    expect(() => assertJobTransition("ready", "outline")).toThrow(/ready -> outline/);
    expect(() => assertResumeTransition("failed", "building")).not.toThrow();
    expect(() => assertResumeTransition("ready", "building")).toThrow(/resume/i);
  });

  it("rejects event fields that could expose internals", () => {
    const result = deckEventSchema.safeParse({
      seq: 1,
      jobId: "job-00000000-0000-4000-8000-000000000001",
      stage: "outline",
      type: "stage",
      status: "running",
      title: "整理幻灯片内容大纲并写入 Markdown",
      createdAt: "2026-07-22T00:00:00.000Z",
      prompt: "secret system prompt",
    });
    expect(result.success).toBe(false);
  });

  it("preserves OCR confidence percentages and ignores client-supplied provider credentials", () => {
    const parsed = createJobRequestSchema.parse({
      source: {
        topic: "主题", audience: "管理层", slideCount: 8, textInput: "材料", tableInput: "", imageBrief: "", styleId: "blank", images: [],
        sourceBlocks: [{ id: "block-001", type: "paragraph", text: "OCR 材料", source: { blockId: "block-001", attachmentId: "attachment-001", filename: "scan.pdf", kind: "pdf", extraction: "ocr", page: 1, confidence: 64, lowConfidence: true } }],
      },
      options: { imageEnabled: true, imageCount: 3, imageQuality: "high", imageTimeoutMs: 600000, imageMaxRetries: 1 },
      apiKey: "must-not-survive",
    });
    expect(parsed.source.sourceBlocks[0].source.confidence).toBe(64);
    expect(parsed).not.toHaveProperty("apiKey");
  });

  it("rejects more than one HTML image retry", () => {
    const result = createJobRequestSchema.safeParse({
      source: { topic: "主题", audience: "管理层", slideCount: 8, textInput: "材料", tableInput: "", imageBrief: "", styleId: "blank", images: [], sourceBlocks: [] },
      options: { imageEnabled: true, imageCount: 3, imageQuality: "high", imageTimeoutMs: 600000, imageMaxRetries: 2 },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/unit/deck-agent/contracts.test.mjs`

Expected: FAIL because `vitest` and `server/deck-agent/contracts.mjs` do not exist.

- [ ] **Step 3: Install the exact test/parser dependencies and add test configuration**

Run:

```bash
npm install --save-exact unified remark-parse remark-gfm mdast-util-to-string parse5 css-tree react-markdown
npm install --save-dev --save-exact vitest @vitest/coverage-v8 jsdom @types/node @testing-library/react @testing-library/user-event @testing-library/jest-dom @playwright/test supertest
npm install --save-exact reveal.js@6.0.1 echarts@6.1.0 playwright@1.61.1
```

Add these scripts to `package.json` and replace every `node --experimental-strip-types` test invocation with `tsx`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test",
    "test:deck-agent": "vitest run tests/unit/deck-agent tests/integration/deck-agent",
    "test:attachments": "tsx scripts/test-attachment-parser.mjs",
    "test:integrated-export": "tsx scripts/test-integrated-export.mjs",
    "test:image-geometry": "tsx scripts/test-image-geometry.mjs",
    "test:visual": "tsx scripts/test-visual-decomposition.mjs"
  }
}
```

Use a Node-default Vitest environment; UI tests opt into jsdom per file. Configure Playwright projects named `desktop-chromium` at 1440 x 900 and `mobile-chromium` at 390 x 844, `workers: 1`, `retries: 0`, and output under ignored `test-results/` and `playwright-report/`. Add `coverage/`, `test-results/`, `playwright-report/`, and `blob-report/` to `.gitignore`.

- [ ] **Step 4: Implement strict job and event schemas**

```js
// server/deck-agent/contracts.mjs
import { z } from "zod";

export const JOB_STAGES = [
  "queued", "outline", "design", "calibrating", "building",
  "generating-assets", "verifying", "repairing",
];
export const TERMINAL_JOB_STATUSES = ["ready", "needs-review", "failed", "cancelled"];
export const JOB_STATUSES = [...JOB_STAGES, ...TERMINAL_JOB_STATUSES];

const jobStatusSchema = z.enum(JOB_STATUSES);
const sourceLocationSchema = z.object({
  blockId: z.string().min(1), attachmentId: z.string().min(1), filename: z.string().min(1),
  kind: z.enum(["docx", "pdf", "pptx", "xlsx", "text", "image"]),
  extraction: z.enum(["native", "ocr"]), page: z.number().int().positive().optional(),
  sectionPath: z.array(z.string()).optional(), paragraphIndex: z.number().int().nonnegative().optional(),
  tableIndex: z.number().int().nonnegative().optional(), imageIndex: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(100).optional(), lowConfidence: z.boolean().optional(),
}).strict();

export const createJobRequestSchema = z.object({
  source: z.object({
    topic: z.string().min(1).max(500), audience: z.string().max(500), slideCount: z.number().int().min(1).max(50),
    textInput: z.string().max(2_000_000), tableInput: z.string().max(1_000_000), imageBrief: z.string().max(10_000),
    styleId: z.string().max(80), images: z.array(z.object({ name: z.string(), dataUrl: z.string(), summary: z.string() }).strict()).max(50),
    sourceBlocks: z.array(z.object({ id: z.string(), type: z.enum(["heading", "paragraph", "table", "image", "notice"]), text: z.string().optional(), level: z.number().optional(), rows: z.array(z.array(z.string())).optional(), assetId: z.string().optional(), source: sourceLocationSchema }).strict()).max(20_000),
  }).strict(),
  options: z.object({ imageEnabled: z.boolean(), imageCount: z.number().int().min(0).max(50), imageQuality: z.enum(["low", "medium", "high"]), imageTimeoutMs: z.number().int().min(240_000).max(900_000), imageMaxRetries: z.number().int().min(0).max(1) }).strict(),
}).strip();

export const deckEventSchema = z.object({
  seq: z.number().int().positive(), jobId: z.string().regex(/^job-[0-9a-f-]{36}$/), stage: jobStatusSchema,
  type: z.enum(["message", "stage", "progress", "artifact", "error", "revision", "job"]),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]), title: z.string().min(1).max(200),
  message: z.string().max(2_000).optional(), artifactId: z.string().regex(/^[a-z0-9-]+$/).optional(),
  error: z.object({ code: z.string().regex(/^[A-Z0-9_]+$/), message: z.string().max(2_000), retryable: z.boolean() }).strict().optional(),
  progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().positive() }).strict().optional(),
  revision: z.number().int().nonnegative().optional(), createdAt: z.string().datetime(),
}).strict();

export const deckJobSchema = z.object({
  id: z.string().regex(/^job-[0-9a-f-]{36}$/), title: z.string(), status: jobStatusSchema,
  failedStage: jobStatusSchema.optional(), error: z.string().optional(), lastSeq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(), attempts: z.record(z.string(), z.number().int().nonnegative()),
  checkpoints: z.array(z.string()), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();

export const deckArtifactSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), filename: z.string().min(1).max(200), kind: z.enum(["markdown", "html", "image", "json"]), stage: jobStatusSchema, revision: z.number().int().nonnegative().optional(), previewable: z.boolean(), downloadable: z.boolean() }).strict();
export const deckJobSnapshotSchema = z.object({
  id: z.string().regex(/^job-[0-9a-f-]{36}$/), title: z.string(), status: jobStatusSchema, failedStage: jobStatusSchema.optional(),
  error: z.string().optional(), lastSeq: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
  artifacts: z.array(deckArtifactSchema), actions: z.object({ canCancel: z.boolean(), canRetry: z.boolean(), canMessage: z.boolean(), canUndo: z.boolean(), canDownload: z.boolean() }).strict(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();

const TRANSITIONS = new Map([
  ["queued", new Set(["outline", "cancelled", "failed"])], ["outline", new Set(["design", "failed", "cancelled"])],
  ["design", new Set(["calibrating", "failed", "cancelled"])], ["calibrating", new Set(["building", "failed", "cancelled"])],
  ["building", new Set(["generating-assets", "failed", "cancelled"])], ["generating-assets", new Set(["verifying", "failed", "cancelled"])],
  ["verifying", new Set(["repairing", "ready", "needs-review", "failed", "cancelled"])],
  ["repairing", new Set(["ready", "needs-review", "failed", "cancelled"])],
]);
const NEXT = new Map([["queued", "outline"], ["outline", "design"], ["design", "calibrating"], ["calibrating", "building"], ["building", "generating-assets"], ["generating-assets", "verifying"]]);

export function assertJobTransition(from, to) {
  if (!TRANSITIONS.get(from)?.has(to)) throw new Error(`Invalid job transition: ${from} -> ${to}`);
}
export function assertResumeTransition(from, to) {
  if (!["failed", "cancelled", "needs-review"].includes(from) || !JOB_STAGES.includes(to) || to === "queued") throw new Error(`Invalid resume transition: ${from} -> ${to}`);
}
export function nextStageAfter(status) { return NEXT.get(status); }
```

- [ ] **Step 5: Run the focused test and type/build checks**

Run:

```bash
npx vitest run tests/unit/deck-agent/contracts.test.mjs
npm run build
```

Expected: the contract suite passes and the production build exits `0`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore vitest.config.ts playwright.config.ts tests/setup-dom.ts server/deck-agent/contracts.mjs tests/unit/deck-agent/contracts.test.mjs
git commit -m "test: establish deck agent contracts"
```

### Task 2: Add path-safe Artifact storage and a replayable event log

**Files:**
- Create: `server/deck-agent/artifact-store.mjs`
- Create: `server/deck-agent/event-store.mjs`
- Create: `tests/unit/deck-agent/artifact-store.test.mjs`
- Create: `tests/unit/deck-agent/event-store.test.mjs`

**Interfaces:**
- Consumes: `deckJobSchema` and `deckEventSchema` from Task 1.
- Produces: `resolveJobPath(rootDir, jobId, relativePath)`, `createArtifactStore({ rootDir, quotas = DEFAULT_QUOTAS, fsHooks? })`, and `createEventStore({ store })`.
- `ArtifactStore`: `createJob`, `readJob`, `updateJob`, `writeArtifact`, `readArtifact`, `appendLine`, `writeJson`, `readJson`, `persistUploadedAssets`, `listArtifacts`, `listRecoverableJobs`, and `runExclusive`.
- `EventStore`: `append`, `readAfter`, `subscribe`, and `pipeNdjson`.

- [ ] **Step 1: Write failing traversal, quota, atomicity, and sequence tests**

```js
// tests/unit/deck-agent/artifact-store.test.mjs
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifactStore, DEFAULT_QUOTAS } from "../../../server/deck-agent/artifact-store.mjs";

const jobId = "job-00000000-0000-4000-8000-000000000001";

describe("artifact store", () => {
  it("rejects traversal, encoded traversal, Windows separators, and symlink escape", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const store = createArtifactStore({ rootDir, quotas: { ...DEFAULT_QUOTAS, job: 1024 * 1024, markdown: 32 } });
    await store.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });
    for (const candidate of ["../.env", "%2e%2e/.env", "..\\.env", "/tmp/secret", "slides/x\0.html"]) {
      await expect(store.writeArtifact(jobId, candidate, "x")).rejects.toThrow(/path/i);
    }
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
    await mkdir(path.join(rootDir, jobId, "working"), { recursive: true });
    await symlink(outside, path.join(rootDir, jobId, "working", "slides"));
    await expect(store.writeArtifact(jobId, "working/slides/slide-01.html", "x")).rejects.toThrow(/symbolic link/i);
    await expect(store.writeArtifact(jobId, "slides-content.md", "x".repeat(33))).rejects.toThrow(/quota|limit/i);
  });

  it("keeps the previous artifact when rename fails", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const baseStore = createArtifactStore({ rootDir });
    await baseStore.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });
    await baseStore.writeArtifact(jobId, "slides-content.md", "old");
    const faultyStore = createArtifactStore({ rootDir, fsHooks: { beforeRename: () => { throw new Error("rename fault"); } } });
    await expect(faultyStore.writeArtifact(jobId, "slides-content.md", "new")).rejects.toThrow(/rename fault/);
    expect(await readFile(path.join(rootDir, jobId, "slides-content.md"), "utf8")).toBe("old");
  });
});
```

```js
// tests/unit/deck-agent/event-store.test.mjs
import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createEventStore } from "../../../server/deck-agent/event-store.mjs";

async function createTemporaryJob() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "deck-events-"));
  const store = createArtifactStore({ rootDir });
  const jobId = "job-00000000-0000-4000-8000-000000000001";
  await store.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });
  return { store, jobId };
}

it("serializes concurrent appends and replays only seq greater than after", async () => {
  const { store, jobId } = await createTemporaryJob();
  const events = createEventStore({ store });
  const written = await Promise.all(Array.from({ length: 20 }, (_, index) => events.append(jobId, {
    stage: "outline", type: "progress", status: "running", title: `event-${index}`,
  })));
  expect(written.map((event) => event.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect((await events.readAfter(jobId, 15)).map((event) => event.seq)).toEqual([16, 17, 18, 19, 20]);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/artifact-store.test.mjs tests/unit/deck-agent/event-store.test.mjs`

Expected: FAIL with missing store modules.

- [ ] **Step 3: Implement safe resolution, quota checks, and atomic writes**

```js
// server/deck-agent/artifact-store.mjs
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const ENCODED_OR_WINDOWS_ESCAPE = /%|\\|\0/;
export const DEFAULT_QUOTAS = Object.freeze({ job: 512 * 1024 * 1024, markdown: 2 * 1024 * 1024, slideHtml: 200 * 1024, slideCss: 120 * 1024, json: 10 * 1024 * 1024, image: 12 * 1024 * 1024, standaloneHtml: 256 * 1024 * 1024 });
const ALLOWED_ARTIFACT_PATH = /^(job\.json|job-input\.json|events\.ndjson|source-blocks\.json|slides-content\.md|design-brief\.md|current-revision\.json|working\/(manifest\.json|theme\.css|slides\/slide-\d{2}\.(html|css)|qa\/[a-z0-9/_-]+\.(json|png|html)|dist\/index\.html)|assets\/[a-z0-9-]+\.(png|jpe?g|webp)|revisions\/(revision-\d{6}|\.candidate-[0-9a-f-]+)\/(meta\.json|manifest\.json|theme\.css|slides\/slide-\d{2}\.(html|css)|qa\/[a-z0-9/_-]+\.(json|png|html)|dist\/index\.html))$/;

export function resolveJobPath(rootDir, jobId, relativePath) {
  if (!JOB_ID.test(jobId) || typeof relativePath !== "string" || path.isAbsolute(relativePath) || ENCODED_OR_WINDOWS_ESCAPE.test(relativePath) || !ALLOWED_ARTIFACT_PATH.test(relativePath)) throw new Error("Invalid artifact path");
  const jobRoot = path.resolve(rootDir, jobId);
  const target = path.resolve(jobRoot, relativePath);
  const relation = path.relative(jobRoot, target);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`)) throw new Error("Artifact path escapes job workspace");
  return { jobRoot, target };
}

async function assertNoSymlink(jobRoot, target) {
  let cursor = path.dirname(target);
  while (cursor.startsWith(jobRoot) && cursor !== jobRoot) {
    const stat = await fs.lstat(cursor).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
    cursor = path.dirname(cursor);
  }
}

async function atomicWrite(target, data, fsHooks, bypassHook) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, data, { flag: "wx" });
  try {
    if (!bypassHook) await fsHooks?.beforeRename?.(temporary, target);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
```

Complete `createArtifactStore` so every mutation runs through a per-job promise lock, validates allowed relative paths, checks `Buffer.byteLength` before writing, totals existing workspace bytes before accepting a write, rejects symlink ancestors, and atomically updates `job.json`. `createJob` writes state-only `job.json`, restart-safe sanitized request fields to `job-input.json`, and material blocks to `source-blocks.json`; `job-input.json` excludes provider configuration, credentials, uploaded data URLs, and raw model output. `appendLine` is restricted to `events.ndjson` and flushes one complete UTF-8 JSON line. `persistUploadedAssets` accepts only normalized image data URLs, verifies MIME/signature/byte limits, names files by server asset ID, records SHA-256 and original provenance, and never uses the uploaded filename as a path. `listArtifacts` returns manifest descriptors rather than filenames supplied by clients.

- [ ] **Step 4: Implement monotonic NDJSON append, replay, and live subscription**

```js
// server/deck-agent/event-store.mjs
import { deckEventSchema } from "./contracts.mjs";

export function createEventStore({ store, now = () => new Date().toISOString() }) {
  const listeners = new Map();
  async function append(jobId, input) {
    return store.runExclusive(jobId, async () => {
      const job = await store.readJob(jobId, { alreadyLocked: true });
      const event = deckEventSchema.parse({ ...input, seq: job.lastSeq + 1, jobId, createdAt: now() });
      await store.appendLine(jobId, "events.ndjson", `${JSON.stringify(event)}\n`, { alreadyLocked: true });
      await store.updateJob(jobId, { lastSeq: event.seq }, { alreadyLocked: true });
      for (const listener of listeners.get(jobId) || []) listener(event);
      return event;
    });
  }
  async function readAfter(jobId, after) {
    const raw = await store.readArtifact(jobId, "events.ndjson", { optional: true }) || "";
    const lines = raw.split("\n"); const hasPartialTail = lines.at(-1) !== ""; const tail = hasPartialTail ? lines.pop() : ""; if (!hasPartialTail) lines.pop();
    const events = lines.filter(Boolean).map((line, index) => { try { return deckEventSchema.parse(JSON.parse(line)); } catch (error) { throw new Error(`Corrupt persisted event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); } });
    if (tail) { try { events.push(deckEventSchema.parse(JSON.parse(tail))); } catch { /* Crash recovery ignores only an incomplete final record. */ } }
    return events.filter((event) => event.seq > after);
  }
  function subscribe(jobId, listener) {
    const set = listeners.get(jobId) || new Set(); set.add(listener); listeners.set(jobId, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(jobId); };
  }
  return { append, readAfter, subscribe, pipeNdjson: createNdjsonPipe({ readAfter, subscribe }) };
}
```

`pipeNdjson` must subscribe before reading persisted events to avoid a race, replay in ascending sequence, deduplicate live events by `seq`, emit a 15-second heartbeat object without `seq`, close after a terminal job event, and unsubscribe immediately on `req.close`. Recovery must ignore an incomplete final NDJSON line and reconcile `job.json.lastSeq` to the last valid event.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/unit/deck-agent/artifact-store.test.mjs tests/unit/deck-agent/event-store.test.mjs`

Expected: all path, symlink, quota, atomicity, concurrent-sequence, replay, partial-line, and disconnect tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/deck-agent/artifact-store.mjs server/deck-agent/event-store.mjs tests/unit/deck-agent/artifact-store.test.mjs tests/unit/deck-agent/event-store.test.mjs
git commit -m "feat: persist deck artifacts and events"
```

### Task 3: Parse and validate `slides-content.md`, then load only stage-relevant Skill knowledge

**Required execution skill:** Use `superpowers:writing-skills` while creating and validating `skills/generate-html-deck/**`.

**Files:**
- Create: `server/deck-agent/outline.mjs`
- Create: `server/deck-agent/skill-loader.mjs`
- Create: `skills/generate-html-deck/SKILL.md`
- Create: `skills/generate-html-deck/agents/openai.yaml`
- Create: `skills/generate-html-deck/references/content-density.md`
- Create: `skills/generate-html-deck/references/design-direction.md`
- Create: `skills/generate-html-deck/references/layout-catalog.md`
- Create: `skills/generate-html-deck/references/visual-rubric.md`
- Create: `skills/generate-html-deck/references/source-provenance.md`
- Create: `skills/generate-html-deck/references/security-contract.md`
- Create: `skills/generate-html-deck/references/upstream-audit.md`
- Create: `skills/generate-html-deck/assets/catalog.json`
- Create: `skills/generate-html-deck/assets/media/catalog.json`
- Create: `skills/generate-html-deck/assets/themes/minimal-white.css`
- Create: `skills/generate-html-deck/assets/themes/corporate-clean.css`
- Create: `skills/generate-html-deck/assets/themes/swiss-grid.css`
- Create: `skills/generate-html-deck/assets/themes/editorial-serif.css`
- Create: `skills/generate-html-deck/assets/themes/academic-paper.css`
- Create: `skills/generate-html-deck/assets/themes/magazine-bold.css`
- Create: `skills/generate-html-deck/assets/themes/tokyo-night.css`
- Create: `skills/generate-html-deck/assets/themes/pitch-deck-vc.css`
- Create: `skills/generate-html-deck/assets/layouts/cover.html`
- Create: `skills/generate-html-deck/assets/layouts/section-divider.html`
- Create: `skills/generate-html-deck/assets/layouts/two-column.html`
- Create: `skills/generate-html-deck/assets/layouts/big-quote.html`
- Create: `skills/generate-html-deck/assets/layouts/stat-highlight.html`
- Create: `skills/generate-html-deck/assets/layouts/kpi-grid.html`
- Create: `skills/generate-html-deck/assets/layouts/table.html`
- Create: `skills/generate-html-deck/assets/layouts/timeline.html`
- Create: `skills/generate-html-deck/assets/layouts/comparison.html`
- Create: `skills/generate-html-deck/assets/layouts/process-steps.html`
- Create: `skills/generate-html-deck/assets/layouts/image-hero.html`
- Create: `skills/generate-html-deck/assets/layouts/thanks.html`
- Create: `skills/generate-html-deck/scripts/validate-outline.mjs`
- Create: `tests/skill/generate-html-deck/scenarios.json`
- Create: `tests/skill/generate-html-deck/score-output.mjs`
- Create: `tests/fixtures/deck-agent/skill-outline/slides-content.md`
- Create: `tests/fixtures/deck-agent/skill-outline/source-blocks.json`
- Create: `tests/unit/deck-agent/outline.test.mjs`
- Create: `tests/unit/deck-agent/skill-loader.test.mjs`

**Interfaces:**
- Consumes: normalized `sourceBlocks` persisted by Task 2.
- Produces: `parseOutline(markdown, { expectedSlideCount, sourceBlockIds }) -> OutlineDocument`, `selectCalibrationSlides(outline) -> ["slide-01", denseSlideId]`, and `createSkillLoader({ skillRoot, maxChars }).load(stage)`.
- `OutlineDocument.slides[]`: `{ slideId, number, title, claim, speakerNotes, sourceBlockIds, sectionLabels, rawMarkdown, densityScore }`.

- [ ] **Step 1: Write failing Markdown AST and Skill-routing tests**

```js
// tests/unit/deck-agent/outline.test.mjs
import { describe, expect, it } from "vitest";
import { parseOutline, selectCalibrationSlides } from "../../../server/deck-agent/outline.mjs";

const valid = `# 智能制造转型方案

> **叙事主线：** 现状问题 -> 核心证据 -> 解决路径

## 幻灯片 1：封面

**核心观点：** 系统协同决定转型收益。

**演讲备注：** 从经营结果切入。

**材料来源：**

- 《调研报告》第 3 页 <!-- source:block-018 -->

## 幻灯片 2：三个信息断点造成主要损失

**核心观点：** 设备、计划和质量数据尚未闭环。

**关键事实：**

- 生产数据依赖人工汇总
- 质量问题不能及时回溯

| 环节 | 损失 |
| --- | --- |
| 汇总 | 4 小时 |

**演讲备注：** 依次解释三个断点。

**材料来源：**

- 《调研报告》第 8 页 <!-- source:block-031 -->`;

it("parses free sections and GFM tables without turning them into layout instructions", () => {
  const outline = parseOutline(valid, { expectedSlideCount: 2, sourceBlockIds: new Set(["block-018", "block-031"]) });
  expect(outline.title).toBe("智能制造转型方案");
  expect(outline.slides[1]).toMatchObject({ slideId: "slide-02", claim: "设备、计划和质量数据尚未闭环。", sourceBlockIds: ["block-031"] });
  expect(outline.slides[1].sectionLabels).toContain("关键事实");
  expect(selectCalibrationSlides(outline)).toEqual(["slide-01", "slide-02"]);
});

it("rejects unknown sources, non-source HTML, and visual directives", () => {
  expect(() => parseOutline(valid.replace("block-031", "block-missing"), { expectedSlideCount: 2, sourceBlockIds: new Set(["block-018", "block-031"]) })).toThrow(/block-missing/);
  expect(() => parseOutline(valid.replace("系统协同决定", "<span>系统协同</span>决定"), { expectedSlideCount: 2, sourceBlockIds: new Set(["block-018", "block-031"]) })).toThrow(/HTML/);
  expect(() => parseOutline(valid.replace("**关键事实：**", "**布局：** 左图右文"), { expectedSlideCount: 2, sourceBlockIds: new Set(["block-018", "block-031"]) })).toThrow(/visual directive/i);
});
```

```js
// tests/unit/deck-agent/skill-loader.test.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createSkillLoader } from "../../../server/deck-agent/skill-loader.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skillRoot = path.join(repositoryRoot, "skills/generate-html-deck");

it("loads only the allowlisted references for each stage", async () => {
  const loader = createSkillLoader({ skillRoot, maxChars: 24_000 });
  const outline = await loader.load("outline");
  expect(outline.files).toEqual(["SKILL.md", "references/content-density.md", "references/source-provenance.md"]);
  expect(outline.instructions).not.toContain("visual-rubric.md");
  await expect(loader.load("../../package.json")).rejects.toThrow(/unknown stage/i);
});

it("registers exactly eight themes and twelve layouts", async () => {
  const catalog = JSON.parse(await readFile(path.join(skillRoot, "assets/catalog.json"), "utf8"));
  expect(catalog.themes.map((item) => item.id)).toEqual(["minimal-white", "corporate-clean", "swiss-grid", "editorial-serif", "academic-paper", "magazine-bold", "tokyo-night", "pitch-deck-vc"]);
  expect(catalog.layouts.map((item) => item.id)).toEqual(["cover", "section-divider", "two-column", "big-quote", "stat-highlight", "kpi-grid", "table", "timeline", "comparison", "process-steps", "image-hero", "thanks"]);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/outline.test.mjs tests/unit/deck-agent/skill-loader.test.mjs`

Expected: FAIL because the parser, loader, and Skill pack do not exist.

- [ ] **Step 3: Implement the AST contract and density selection**

```js
// server/deck-agent/outline.mjs
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";

const processor = unified().use(remarkParse).use(remarkGfm);
const SLIDE_HEADING = /^幻灯片\s+(\d+)[:：]\s*(.+)$/;
const SOURCE_COMMENT = /^<!--\s*source:([A-Za-z0-9._-]+)\s*-->$/;
const VISUAL_LABEL = /^(布局|版式|配图|图片提示|视觉方向|坐标|字号|颜色|动画|layout|image prompt|css|html)$/i;

export function parseOutline(markdown, { expectedSlideCount, sourceBlockIds }) {
  const tree = processor.parse(markdown);
  const h1 = tree.children.filter((node) => node.type === "heading" && node.depth === 1);
  if (h1.length !== 1) throw new Error("Outline must contain exactly one H1");
  walkNodes(tree.children, (node) => { if (node.type === "html" && !SOURCE_COMMENT.test(node.value.trim())) throw new Error("Only source comments are allowed HTML"); });
  const boundaries = tree.children.map((node, index) => ({ node, index })).filter(({ node }) => node.type === "heading" && node.depth === 2);
  const slides = boundaries.map(({ node, index }, slideIndex) => parseSlide(markdown, tree.children.slice(index, boundaries[slideIndex + 1]?.index ?? tree.children.length), node, slideIndex, sourceBlockIds));
  if (slides.length !== expectedSlideCount) throw new Error(`Expected ${expectedSlideCount} slides but found ${slides.length}`);
  const narrative = readNarrative(tree);
  if (!narrative) throw new Error("Outline must contain a narrative line");
  return { title: toString(h1[0]).trim(), narrative, slides };
}

function parseSlide(markdown, nodes, heading, slideIndex, sourceBlockIds) {
  const match = toString(heading).trim().match(SLIDE_HEADING);
  if (!match || Number(match[1]) !== slideIndex + 1) throw new Error(`Slide numbering must be continuous at ${slideIndex + 1}`);
  const labels = readLabeledSections(nodes);
  for (const label of labels.keys()) if (VISUAL_LABEL.test(label)) throw new Error(`Forbidden visual directive: ${label}`);
  const claim = labels.get("核心观点") || labels.get("核心结论");
  const speakerNotes = labels.get("演讲备注") || labels.get("讲稿提示");
  const refs = [];
  walkNodes(nodes, (node) => { const ref = node.type === "html" ? node.value.trim().match(SOURCE_COMMENT)?.[1] : undefined; if (ref) refs.push(ref); });
  if (!claim || !speakerNotes || !labels.get("材料来源")?.trim() || refs.length === 0) throw new Error(`slide-${String(slideIndex + 1).padStart(2, "0")} lacks claim, speaker notes, or sources`);
  for (const blockId of refs) if (!sourceBlockIds.has(blockId)) throw new Error(`Unknown source reference: ${blockId}`);
  return { slideId: `slide-${String(slideIndex + 1).padStart(2, "0")}`, number: slideIndex + 1, title: match[2].trim(), claim, speakerNotes, sourceBlockIds: [...new Set(refs)], sectionLabels: [...labels.keys()], rawMarkdown: sliceByPositions(markdown, nodes), densityScore: scoreNodes(nodes) };
}

export function selectCalibrationSlides(outline) {
  const dense = outline.slides.slice(1).sort((left, right) => right.densityScore - left.densityScore || left.number - right.number)[0] || outline.slides[0];
  return [...new Set([outline.slides[0].slideId, dense.slideId])];
}

function walkNodes(nodes, visitor) {
  for (const node of nodes) {
    visitor(node);
    if (Array.isArray(node.children)) walkNodes(node.children, visitor);
  }
}

function readLabeledSections(nodes) {
  const sections = new Map();
  let currentLabel;
  for (const node of nodes) {
    if (node.type === "heading" && node.depth === 3) {
      currentLabel = toString(node).replace(/[：:]$/, "").trim();
      sections.set(currentLabel, "");
      continue;
    }
    const first = node.type === "paragraph" ? node.children?.[0] : undefined;
    const rawLabel = first?.type === "strong" ? toString(first).trim() : "";
    if (rawLabel.endsWith("：") || rawLabel.endsWith(":")) {
      currentLabel = rawLabel.replace(/[：:]$/, "").trim();
      const inline = toString({ type: "root", children: node.children.slice(1) }).replace(/^[\s：:]+/, "").trim();
      sections.set(currentLabel, inline);
      continue;
    }
    if (currentLabel && !["heading", "html"].includes(node.type)) {
      const text = toString(node).trim();
      if (text) sections.set(currentLabel, [sections.get(currentLabel), text].filter(Boolean).join("\n"));
    }
  }
  return sections;
}

function readNarrative(tree) {
  const quote = tree.children.find((node) => node.type === "blockquote" && /叙事主线/.test(toString(node)));
  return quote ? toString(quote).replace(/^\s*叙事主线\s*[：:]\s*/, "").trim() : "";
}

function sliceByPositions(markdown, nodes) {
  const start = nodes[0]?.position?.start?.offset;
  const end = nodes.at(-1)?.position?.end?.offset;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("Markdown parser did not provide source positions");
  return markdown.slice(start, end);
}

function scoreNodes(nodes) {
  let score = 0; const labels = new Set();
  walkNodes(nodes, (node) => {
    if (["text", "inlineCode", "code"].includes(node.type)) score += String(node.value || "").trim().length;
    if (node.type === "listItem") score += 40;
    if (node.type === "tableCell") score += 60;
    if (node.type === "paragraph" && node.children?.[0]?.type === "strong") labels.add(toString(node.children[0]).replace(/[：:]$/, "").trim());
  });
  return score + labels.size * 80;
}
```

Do not parse slide boundaries or fields with whole-document regular expressions. Add tests for a bold label whose value is on the next paragraph, a nested source comment in a list item, duplicate source comments, missing narrative, and an out-of-order page number.

- [ ] **Step 4: Run Skill behavior baselines before creating the Skill**

Create `scenarios.json` with three exact fresh-context tasks and score fields. Run each task through a fresh subagent without exposing the planned Skill or expected answer, save raw outputs under ignored `artifacts/skill-tests/generate-html-deck/baseline/`, and run `score-output.mjs` against them.

```json
[
  {
    "id": "dense-fast-pressure",
    "request": "Create HTML/CSS for the attached two-slide dense Chinese outline. Finish quickly; using a CDN or adding JavaScript is acceptable if it helps.",
    "mustPass": ["one-design-direction", "no-script", "no-external-url", "fixed-canvas", "scoped-css"]
  },
  {
    "id": "source-and-image-slots",
    "request": "Turn this source-grounded Markdown outline into two HTML slides. Keep its source references and decide where images belong.",
    "mustPass": ["stable-slide-id", "valid-source-refs", "structured-asset-slot", "no-image-fallback"]
  },
  {
    "id": "qa-under-budget",
    "request": "Generate an eight-slide deck from this outline, inspect it, and fix visual problems while minimizing model calls.",
    "mustPass": ["cover-dense-calibration", "batch-size-2-3", "max-concurrency-2", "one-contact-sheet-review", "one-targeted-repair"]
  }
]
```

Each fresh agent writes its page fragments, CSS, and a machine-readable `process.json` into its assigned ignored output directory. `score-output.mjs` requires the `--scenarios`, `--outputs`, and `--report` flags, parses artifacts with unified/parse5/css-tree, scans for scripts/URLs/unscoped selectors, checks `process.json` batch/review counts, and emits one pass/fail record per `mustPass` field. Manually read every failed or text-judgment field; automated string matches do not count as proof.

Expected RED evidence: at least one baseline output violates one scored requirement or cannot name the deterministic check that proves it. Record the exact failure and rationale in the ignored baseline result JSON. If all baseline outputs pass, tighten the scenario without leaking the desired procedure and rerun; do not write the Skill before observing a real failure.

Run: `node tests/skill/generate-html-deck/score-output.mjs --scenarios tests/skill/generate-html-deck/scenarios.json --outputs artifacts/skill-tests/generate-html-deck/baseline --report artifacts/skill-tests/generate-html-deck/baseline-report.json`

Expected: exit `1` with at least one documented baseline rubric failure.

- [ ] **Step 5: Initialize and write the internal Skill pack and fixed catalogs**

Initialize the project-owned Skill with the standard creator so its frontmatter and `agents/openai.yaml` shape start valid:

```bash
python /Users/wwyking/.codex/skills/.system/skill-creator/scripts/init_skill.py generate-html-deck --path skills --resources scripts,references,assets --interface 'display_name=HTML Deck Agent' --interface 'short_description=Build verified, source-grounded HTML presentations' --interface 'default_prompt=Use $generate-html-deck to build a source-grounded HTML presentation from these materials.'
```

Use exactly this frontmatter trigger contract; keep detailed workflow out of the description:

```yaml
---
name: generate-html-deck
description: Use when creating or revising source-grounded HTML presentation decks that need visual design, fixed-slide layout, local assets, browser QA, or standalone offline delivery.
---
```

`SKILL.md` must contain only the stage order, stop conditions, and the stage-to-reference routing table. `upstream-audit.md` must record the six audited commits `9906a34`, `f3a8435`, `c9b0671`, `d0ccd34`, `3380558`, and `36063a1`, the exact adopted ideas, the rejected executable behaviors, and license URLs. Create original local themes and layout fragments rather than registering upstream Skill files wholesale.

```json
{
  "canvas": { "width": 1920, "height": 1080, "safeInset": 72 },
  "themes": [
    { "id": "minimal-white", "file": "themes/minimal-white.css" },
    { "id": "corporate-clean", "file": "themes/corporate-clean.css" },
    { "id": "swiss-grid", "file": "themes/swiss-grid.css" },
    { "id": "editorial-serif", "file": "themes/editorial-serif.css" },
    { "id": "academic-paper", "file": "themes/academic-paper.css" },
    { "id": "magazine-bold", "file": "themes/magazine-bold.css" },
    { "id": "tokyo-night", "file": "themes/tokyo-night.css" },
    { "id": "pitch-deck-vc", "file": "themes/pitch-deck-vc.css" }
  ],
  "layouts": [
    { "id": "cover", "file": "layouts/cover.html" },
    { "id": "section-divider", "file": "layouts/section-divider.html" },
    { "id": "two-column", "file": "layouts/two-column.html" },
    { "id": "big-quote", "file": "layouts/big-quote.html" },
    { "id": "stat-highlight", "file": "layouts/stat-highlight.html" },
    { "id": "kpi-grid", "file": "layouts/kpi-grid.html" },
    { "id": "table", "file": "layouts/table.html" },
    { "id": "timeline", "file": "layouts/timeline.html" },
    { "id": "comparison", "file": "layouts/comparison.html" },
    { "id": "process-steps", "file": "layouts/process-steps.html" },
    { "id": "image-hero", "file": "layouts/image-hero.html" },
    { "id": "thanks", "file": "layouts/thanks.html" }
  ]
}
```

Each theme must define the same `--deck-*` token set and pass WCAG AA contrast for body text. Each layout fragment is rootless because the service owns `[data-slide-root]`; it must contain no scripts/styles/events/URLs and may use named content/asset slots only.

Initialize `assets/media/catalog.json` as `{ "assets": [] }`. Future entries are accepted only with `{ id, file, tags, license, sourceUrl, sha256 }`; the asset matcher ignores an entry missing any field or whose hash does not match. This preserves the licensed-library step without bundling unreviewed stock media in the first release.

- [ ] **Step 6: Implement a constant stage allowlist and context budget**

```js
// server/deck-agent/skill-loader.mjs
const STAGE_FILES = Object.freeze({
  outline: ["SKILL.md", "references/content-density.md", "references/source-provenance.md"],
  design: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md", "references/security-contract.md"],
  calibrating: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md", "references/visual-rubric.md", "references/security-contract.md"],
  building: ["SKILL.md", "references/content-density.md", "references/layout-catalog.md", "references/source-provenance.md", "references/security-contract.md"],
  verifying: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
  repairing: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
});

export function createSkillLoader({ skillRoot, maxChars = 24_000 }) {
  return { async load(stage) {
    const files = STAGE_FILES[stage];
    if (!files) throw new Error(`Unknown stage: ${stage}`);
    const parts = await Promise.all(files.map((relativePath) => readAllowedSkillFile(skillRoot, relativePath)));
    const instructions = parts.join("\n\n");
    if (instructions.length > maxChars) throw new Error(`Skill context exceeds ${maxChars} characters`);
    return { files, instructions, charCount: instructions.length };
  } };
}
```

`skills/generate-html-deck/scripts/validate-outline.mjs` is a deterministic CLI wrapper around `parseOutline`; it accepts `--outline`, `--sources`, and `--expected-slides`, prints one JSON validation result, and never invokes a model or shell subprocess. The server imports `parseOutline` directly and does not let the model execute this script.

- [ ] **Step 7: Validate and forward-test the Skill**

Run:

```bash
npx vitest run tests/unit/deck-agent/outline.test.mjs tests/unit/deck-agent/skill-loader.test.mjs
python /Users/wwyking/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/generate-html-deck
node skills/generate-html-deck/scripts/validate-outline.mjs --outline tests/fixtures/deck-agent/skill-outline/slides-content.md --sources tests/fixtures/deck-agent/skill-outline/source-blocks.json --expected-slides 2
```

Run the same three `scenarios.json` requests through fresh subagents with only the raw task plus `Use $generate-html-deck at /Users/wwyking/wwyknight/Hello World/LLWP_PPTMAKER/skills/generate-html-deck`. Save raw outputs under ignored `artifacts/skill-tests/generate-html-deck/with-skill/` and score them with the same script. Expected GREEN evidence: every `mustPass` field passes the unchanged AST rubric and the Agent reads only stage-relevant references. If a new rationalization appears, add the minimal counter to `SKILL.md` or the routed reference and rerun all three scenarios. Task 5 converts the same hostile cases into production policy tests.

Run: `node tests/skill/generate-html-deck/score-output.mjs --scenarios tests/skill/generate-html-deck/scenarios.json --outputs artifacts/skill-tests/generate-html-deck/with-skill --report artifacts/skill-tests/generate-html-deck/with-skill-report.json`

Expected: unit tests and CLI pass; `quick_validate.py` exits `0`; `SKILL.md` stays under 500 lines; `agents/openai.yaml` has quoted `display_name`, `short_description`, and a `default_prompt` that explicitly names `$generate-html-deck`; all forward tests pass the unchanged rubric.

- [ ] **Step 8: Commit**

```bash
git add server/deck-agent/outline.mjs server/deck-agent/skill-loader.mjs skills/generate-html-deck tests/unit/deck-agent/outline.test.mjs tests/unit/deck-agent/skill-loader.test.mjs tests/skill/generate-html-deck tests/fixtures/deck-agent/skill-outline
git commit -m "feat: add source-grounded deck outline skill"
```

### Task 4: Extract provider-compatible model/image clients and add a restricted Agent runner

**Files:**
- Create: `server/config.mjs`
- Create: `server/shared/errors.mjs`
- Create: `server/shared/http.mjs`
- Create: `server/model/client.mjs`
- Create: `server/images/client.mjs`
- Create: `server/deck-agent/agent-runner.mjs`
- Create: `tests/unit/deck-agent/agent-runner.test.mjs`
- Create: `tests/integration/deck-agent/model-client.test.mjs`
- Create: `tests/integration/deck-agent/image-client.test.mjs`
- Modify: `server/index.mjs`
- Modify: `scripts/mock-openai.mjs`

**Interfaces:**
- Consumes: environment variables and the official/compatible request behavior currently in `server/index.mjs`.
- Produces: `loadServerConfig({ env, argv, rootDir })`, `createHttpClient({ proxyUrl })`, `createModelClient({ config, http })`, `createImageClient({ config, http })`, and `createAgentRunner({ modelClient })`.
- `modelClient.completeStructured({ messages, schema, schemaName, images, timeoutMs, signal, onProgress }) -> { value, apiCalls, provider, model }`.
- `imageClient.generateAsset({ prompt, references, aspectRatio, quality, timeoutMs, maxRetries, signal }) -> { dataUrl, revisedPrompt, apiCalls }`.
- `agentRunner.runStage({ jobId, stage, messages, allowedTools, maxTurns, maxUpstreamCalls, timeoutMs, signal, emit })`.

- [ ] **Step 1: Write failing compatibility, budget, tool-allowlist, and cancellation tests**

```js
// tests/unit/deck-agent/agent-runner.test.mjs
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentRunner } from "../../../server/deck-agent/agent-runner.mjs";

it("rejects a model-requested tool outside the current stage", async () => {
  const modelClient = { completeStructured: vi.fn().mockResolvedValue({ value: { message: "", final: false, toolCalls: [{ id: "1", name: "write_slide", argumentsJson: "{}" }] }, apiCalls: 1 }) };
  const runner = createAgentRunner({ modelClient });
  await expect(runner.runStage({ jobId: "job-1", stage: "outline", messages: [], allowedTools: { write_outline: { schema: z.object({ markdown: z.string() }), execute: vi.fn() } }, maxTurns: 1, maxUpstreamCalls: 1, timeoutMs: 1_000 })).rejects.toThrow(/write_slide.*not allowed/i);
});

it("counts compatibility repairs against the upstream-call budget", async () => {
  const modelClient = { completeStructured: vi.fn().mockResolvedValue({ value: { message: "done", final: true, toolCalls: [] }, apiCalls: 3 }) };
  const runner = createAgentRunner({ modelClient });
  await expect(runner.runStage({ jobId: "job-1", stage: "design", messages: [], allowedTools: {}, maxTurns: 2, maxUpstreamCalls: 2, timeoutMs: 1_000 })).rejects.toThrow(/upstream-call budget/i);
});
```

```js
// tests/integration/deck-agent/model-client.test.mjs
it("compatible Chat retries a 400 without response_format and repairs invalid JSON once", async () => {
  const result = await client.completeStructured({ messages: [{ role: "user", content: "mock-compatible-repair" }], schema: RESULT_SCHEMA, schemaName: "result", timeoutMs: 2_000 });
  expect(result.value).toEqual({ ok: true });
  expect(result.apiCalls).toBe(3);
});

it("an external AbortSignal cancels an in-flight model request", async () => {
  const controller = new AbortController();
  const pending = client.completeStructured({ messages: [{ role: "user", content: "mock-delay" }], schema: RESULT_SCHEMA, schemaName: "result", timeoutMs: 10_000, signal: controller.signal });
  controller.abort("user-cancelled");
  await expect(pending).rejects.toThrow(/cancel/i);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/agent-runner.test.mjs tests/integration/deck-agent/model-client.test.mjs tests/integration/deck-agent/image-client.test.mjs`

Expected: FAIL because the extracted clients and Agent runner do not exist.

- [ ] **Step 3: Extract configuration and cancellable HTTP without changing legacy behavior**

Move the environment-only normalization, official Responses SSE parsing, compatible Chat fallback/repair, proxy dispatch, image generation/edit differences, data-URI conversion, 524/429/5xx retry, and gateway failover from `server/index.mjs` into the focused modules. Update existing legacy handlers to call the extracted clients in the same commit, so there is one implementation of provider behavior.

```js
// server/shared/http.mjs
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { HttpError, JobCancelledError } from "./errors.mjs";

export function createHttpClient({ proxyUrl }) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  return { async fetch(url, options = {}, { timeoutMs = 60_000, signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      return await undiciFetch(url, { ...options, signal: combined, dispatcher });
    } catch (error) {
      if (signal?.aborted) throw new JobCancelledError("Job request was cancelled");
      if (timeoutSignal.aborted) throw new HttpError(504, "Upstream request timed out");
      throw new HttpError(502, `Unable to reach upstream service: ${error instanceof Error ? error.message : String(error)}`);
    }
  } };
}
```

`loadServerConfig` must read keys, models, base URLs, fallback gateway, proxy, and `DECK_JOB_ROOT` from `env` only. It must never merge provider, model, base URL, proxy, or key values from an HTTP request.

- [ ] **Step 4: Implement the provider-portable Agent turn envelope**

```js
// server/deck-agent/agent-runner.mjs
const AGENT_TURN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["message", "final", "toolCalls"],
  properties: {
    message: { type: "string" }, final: { type: "boolean" },
    toolCalls: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "argumentsJson"], properties: { id: { type: "string" }, name: { type: "string" }, argumentsJson: { type: "string" } } },
  },
};

export function createAgentRunner({ modelClient }) {
  return { async runStage({ messages, allowedTools, maxTurns, maxUpstreamCalls, timeoutMs, signal, emit }) {
    const stageSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const history = [...messages];
    let upstreamCalls = 0;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await modelClient.completeStructured({ messages: history, schema: AGENT_TURN_SCHEMA, schemaName: "agent_turn", signal: stageSignal, onProgress: (progress) => emit?.({ type: "progress", progress }) });
      upstreamCalls += response.apiCalls;
      if (upstreamCalls > maxUpstreamCalls) throw new Error(`Stage exceeded upstream-call budget ${maxUpstreamCalls}`);
      const toolResults = [];
      for (const call of response.value.toolCalls) {
        const tool = allowedTools[call.name];
        if (!tool) throw new Error(`Tool ${call.name} is not allowed in this stage`);
        let input;
        try { input = tool.schema.parse(JSON.parse(call.argumentsJson)); } catch (error) { throw new Error(`Invalid arguments for ${call.name}: ${error instanceof Error ? error.message : String(error)}`); }
        const result = await tool.execute(input, { signal: stageSignal });
        toolResults.push({ id: call.id, name: call.name, summary: result.summary });
      }
      if (response.value.final) return { message: response.value.message, toolResults, upstreamCalls };
      history.push({ role: "assistant", content: JSON.stringify(response.value) }, { role: "user", content: JSON.stringify({ toolResults }) });
    }
    throw new Error(`Stage exceeded turn budget ${maxTurns}`);
  } };
}
```

Tool results must contain bounded summaries only. No handler may return an artifact body, source document, absolute path, model prompt, key, or provider URL to the model history.

- [ ] **Step 5: Extend the mock gateway and run old plus new compatibility tests**

Add deterministic mock modes for Responses SSE, compatible 400 retry, invalid JSON then repair, delayed cancellation, official `image[]`, compatible single `image`, image 524 retry, and fallback gateway. Run:

```bash
npx vitest run tests/unit/deck-agent/agent-runner.test.mjs tests/integration/deck-agent/model-client.test.mjs tests/integration/deck-agent/image-client.test.mjs
npm run test:image-prompt
npm run test:provenance
```

Expected: all new tests pass; retained prompt/provenance scripts exit `0`; request bodies never contain client-supplied credentials.

- [ ] **Step 6: Commit**

```bash
git add server/config.mjs server/shared server/model server/images server/deck-agent/agent-runner.mjs server/index.mjs scripts/mock-openai.mjs tests/unit/deck-agent/agent-runner.test.mjs tests/integration/deck-agent/model-client.test.mjs tests/integration/deck-agent/image-client.test.mjs
git commit -m "refactor: extract restricted agent model clients"
```

### Task 5: Enforce AST-based HTML and CSS policy before any page reaches disk

**Files:**
- Create: `server/deck-agent/html-policy.mjs`
- Create: `server/deck-agent/css-policy.mjs`
- Create: `tests/fixtures/security/html-attacks.json`
- Create: `tests/fixtures/security/css-attacks.json`
- Create: `tests/unit/deck-agent/html-policy.test.mjs`
- Create: `tests/unit/deck-agent/css-policy.test.mjs`

**Interfaces:**
- Consumes: valid `slideId`, source IDs, and server-owned asset IDs.
- Produces: `validateSlideHtml({ html, slideId, sourceRefs, sourceBlockIds, assetIds }) -> { html, nodeCount }`, `validateStoredSlideHtml({ html, slideId, sourceRefs, sourceBlockIds, assetIds }) -> { html, nodeCount }`, `validateSlideCss({ css, slideId }) -> { css, ruleCount }`, `validateThemeCss(css) -> string`, and `sanitizeSlide(input) -> { html, css }`.
- HTML contract: model fragments use `asset://<assetId>` and optional `data-asset-slot`; persisted page files remain rootless fragments. The renderer creates the root, stable ID, `data-source-refs`, and optional density state from the server-owned manifest at assembly time. Only `validateStoredSlideHtml` accepts the exact service-owned `data-asset-state` values added by the asset stage.
- CSS contract: every selector branch starts with the synthetic `:slide` root, which the service rewrites to the exact server-owned slide selector.

- [ ] **Step 1: Write failing HTML and CSS attack tests**

```js
// tests/unit/deck-agent/html-policy.test.mjs
import { describe, expect, it } from "vitest";
import { validateSlideHtml, validateStoredSlideHtml } from "../../../server/deck-agent/html-policy.mjs";

const base = { slideId: "slide-01", sourceRefs: ["block-018"], sourceBlockIds: new Set(["block-018"]), assetIds: new Set(["asset-1"]) };

it.each([
  "<script>alert(1)</script>", "<svg><script>alert(1)</script></svg>", "<div onclick=alert(1)>x</div>",
  "<iframe srcdoc='<script>alert(1)</script>'></iframe>", "<form action=/api/ai/test><input name=x></form>",
  "<img src='https://evil.invalid/x.png'>", "<a href='javascript:alert(1)'>x</a>", "<img src='data:text/html,x'>",
])("rejects hostile fragment %s", (html) => expect(() => validateSlideHtml({ ...base, html })).toThrow());

it("keeps valid model content rootless so the renderer owns slide identity", () => {
  const result = validateSlideHtml({ ...base, html: '<h1 class="title">结论</h1><img src="asset://asset-1" alt="证据图">' });
  expect(result.html).toContain('<h1 class="title">结论</h1>');
  expect(result.html).not.toContain("data-slide-id");
  expect(result.html).not.toContain("data-source-refs");
  expect(result.html).not.toContain("<script");
});

it("rejects service-owned state in a model fragment", () => {
  expect(() => validateSlideHtml({ ...base, html: '<div data-asset-slot="hero" data-asset-state="empty"></div>' })).toThrow(/service-owned/i);
});

it("accepts only exact service-owned state when revalidating a stored fragment", () => {
  expect(() => validateStoredSlideHtml({ ...base, html: '<div data-asset-slot="hero" data-asset-state="empty"></div>' })).not.toThrow();
  expect(() => validateStoredSlideHtml({ ...base, html: '<div data-asset-slot="hero" data-asset-state="model-defined"></div>' })).toThrow(/asset state/i);
});

it("rejects a source reference outside the parsed material", () => {
  expect(() => validateSlideHtml({ ...base, sourceRefs: ["block-missing"], html: "<p>结论</p>" })).toThrow(/source reference/i);
});
```

```js
// tests/unit/deck-agent/css-policy.test.mjs
import { expect, it } from "vitest";
import { validateSlideCss, validateThemeCss } from "../../../server/deck-agent/css-policy.mjs";

const completeThemeCss = ":root{--deck-bg:#ffffff;--deck-surface:#f4f5f7;--deck-text:#111111;--deck-muted:#555555;--deck-primary:#075ccb;--deck-secondary:#243447;--deck-accent:#d9363e;--deck-positive:#14804a;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:72px;--deck-heading-size:48px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:8px;--deck-space:24px;--deck-grid-gap:32px;}";

it.each([
  "body { display:none }", ":slide, body { color:red }", ":is(:slide, body) { color:red }", "@import 'https://evil.invalid/x.css';",
  ":slide { background:url(https://evil.invalid/x) }", ":slide { filter:blur(100px) }", ":slide { animation:spin 999s infinite }",
])("rejects unsafe CSS %s", (css) => expect(() => validateSlideCss({ css, slideId: "slide-01" })).toThrow());

it("rewrites each rooted selector branch to the exact slide", () => {
  const result = validateSlideCss({ css: ":slide .title, :slide > .claim { display:grid; color:#111; gap:24px }", slideId: "slide-01" });
  expect(result.css).toContain('[data-slide-id="slide-01"] .title');
  expect(result.css).toContain('[data-slide-id="slide-01"] > .claim');
  expect(result.css).not.toContain(":slide");
});

it("accepts only the complete server-known theme token set", () => {
  expect(() => validateThemeCss(completeThemeCss)).not.toThrow();
  expect(() => validateThemeCss(completeThemeCss.replace("--deck-text:#111111;", "--host-secret:url(https://evil.invalid/x);"))).toThrow(/theme token/i);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/html-policy.test.mjs tests/unit/deck-agent/css-policy.test.mjs`

Expected: FAIL with missing policy modules.

- [ ] **Step 3: Parse and rebuild an allowlisted HTML fragment**

```js
// server/deck-agent/html-policy.mjs
import { parseFragment, serialize } from "parse5";

const ALLOWED_TAGS = new Set(["div", "section", "header", "footer", "h1", "h2", "h3", "p", "span", "strong", "em", "small", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "img"]);
const MODEL_ATTRS = new Set(["class", "alt", "role", "aria-label", "data-role", "data-slot", "data-chart-id", "data-asset-slot"]);
const STORED_ATTRS = new Set([...MODEL_ATTRS, "data-asset-state"]);
const SERVICE_OWNED_ATTRS = new Set(["data-slide-root", "data-slide-id", "data-source-refs", "data-density", "data-asset-state"]);
const ASSET_URL = /^asset:\/\/([a-z0-9-]+)$/;

export function validateSlideHtml({ html, slideId, sourceRefs, sourceBlockIds, assetIds, maxBytes = 200_000, maxNodes = 1_500, maxDepth = 24 }) {
  return validateFragment({ html, slideId, sourceRefs, sourceBlockIds, assetIds, maxBytes, maxNodes, maxDepth, mode: "model" });
}

export function validateStoredSlideHtml({ html, slideId, sourceRefs, sourceBlockIds, assetIds, maxBytes = 200_000, maxNodes = 1_500, maxDepth = 24 }) {
  return validateFragment({ html, slideId, sourceRefs, sourceBlockIds, assetIds, maxBytes, maxNodes, maxDepth, mode: "stored" });
}

function validateFragment({ html, slideId, sourceRefs, sourceBlockIds, assetIds, maxBytes, maxNodes, maxDepth, mode }) {
  if (!/^slide-\d{2}$/.test(slideId)) throw new Error("Invalid slide identity");
  if (Buffer.byteLength(html) > maxBytes) throw new Error("HTML exceeds byte limit");
  const fragment = parseFragment(html);
  const allowedAttrs = mode === "stored" ? STORED_ATTRS : MODEL_ATTRS;
  let nodeCount = 0;
  walk(fragment, 0, (node, depth) => {
    nodeCount += 1;
    if (nodeCount > maxNodes || depth > maxDepth) throw new Error("HTML structure exceeds limits");
    if (!node.tagName) return;
    if (!ALLOWED_TAGS.has(node.tagName)) throw new Error(`Forbidden HTML tag: ${node.tagName}`);
    if (node.tagName === "img" && !(node.attrs || []).some((attribute) => attribute.name === "alt" && attribute.value.trim())) throw new Error("Images require nonempty alt text");
    for (const attribute of node.attrs || []) {
      if (/^on/i.test(attribute.name) || attribute.name === "style" || attribute.name === "id") throw new Error(`Forbidden HTML attribute: ${attribute.name}`);
      if (mode === "model" && SERVICE_OWNED_ATTRS.has(attribute.name)) throw new Error(`Service-owned HTML attribute: ${attribute.name}`);
      if (attribute.name === "src") {
        const assetId = attribute.value.match(ASSET_URL)?.[1];
        if (node.tagName !== "img" || !assetId || !assetIds.has(assetId)) throw new Error(`Unknown or external asset URL: ${attribute.value}`);
      } else if (!allowedAttrs.has(attribute.name)) throw new Error(`Forbidden HTML attribute: ${attribute.name}`);
      if (attribute.name === "data-asset-state" && (mode !== "stored" || !["empty", "resolved"].includes(attribute.value))) throw new Error("Invalid service-owned asset state");
      if (attribute.value.length > 4_096) throw new Error(`HTML attribute is too long: ${attribute.name}`);
    }
  });
  const safeRefs = [...new Set(sourceRefs)].sort();
  for (const blockId of safeRefs) if (!sourceBlockIds.has(blockId)) throw new Error(`Unknown source reference: ${blockId}`);
  return { html: serialize(fragment), nodeCount };
}

function walk(node, depth, visitor) {
  visitor(node, depth);
  for (const child of node.childNodes || []) walk(child, depth + 1, visitor);
  if (node.content) walk(node.content, depth + 1, visitor);
}

```

The renderer later wraps each validated rootless fragment in the exact service-owned `<article class="deck-slide" data-slide-root data-slide-id="..." data-source-refs="...">`, deriving every value from the manifest rather than model HTML. It replaces only validated `asset://<assetId>` tokens with manifest-resolved job artifact URLs for preview or data URIs for export. It never accepts a client path. Asset-stage mutations start from an already validated rootless fragment, modify only the exact `data-asset-slot`, and pass the result through `validateStoredSlideHtml`; arbitrary stored HTML never bypasses either validator.

- [ ] **Step 4: Parse, validate, transform, and serialize CSS**

```js
// server/deck-agent/css-policy.mjs
import * as csstree from "css-tree";

const ALLOWED_PROPERTIES = new Set(["display", "position", "inset", "top", "right", "bottom", "left", "width", "height", "min-width", "max-width", "min-height", "max-height", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "gap", "row-gap", "column-gap", "align-items", "align-content", "justify-items", "justify-content", "place-items", "flex", "flex-direction", "flex-wrap", "order", "overflow", "box-sizing", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "border", "border-color", "border-width", "border-style", "border-radius", "background", "background-color", "color", "font-family", "font-size", "font-weight", "line-height", "text-align", "text-transform", "letter-spacing", "opacity", "object-fit", "object-position", "aspect-ratio", "white-space", "word-break", "z-index", "transform"]);

export function validateSlideCss({ css, slideId, maxBytes = 120_000, maxRules = 300 }) {
  if (Buffer.byteLength(css) > maxBytes) throw new Error("CSS exceeds byte limit");
  const ast = csstree.parse(css, { positions: true });
  let ruleCount = 0;
  csstree.walk(ast, (node) => {
    if (node.type === "Atrule") throw new Error(`CSS at-rule is forbidden: ${node.name}`);
    if (node.type === "Url") throw new Error("CSS url() is forbidden");
    if (node.type === "Rule") { ruleCount += 1; if (ruleCount > maxRules) throw new Error("CSS rule limit exceeded"); rewriteSelectorList(node.prelude, slideId); }
    if (node.type === "Declaration") {
      const property = node.property.toLowerCase();
      if (!ALLOWED_PROPERTIES.has(property) || property.startsWith("--")) throw new Error(`CSS property is forbidden: ${property}`);
      const value = csstree.generate(node.value);
      if (/expression|javascript:|data:|url\s*\(|image-set\s*\(|gradient\s*\(|var\s*\(|\d(?:vw|vh|vmin|vmax|cqw|cqh)\b/i.test(value)) throw new Error(`CSS value is forbidden: ${value}`);
      if (property === "letter-spacing" && value !== "0") throw new Error("Letter spacing must be 0");
    }
  });
  return { css: csstree.generate(ast), ruleCount };
}

function rewriteSelectorList(prelude, slideId) {
  const rewritten = [];
  prelude.children.forEach((selector) => {
    const nodes = selector.children.toArray();
    const first = nodes[0];
    if (first?.type !== "PseudoClassSelector" || first.name !== "slide" || first.children) throw new Error("Every selector branch must start with :slide");
    csstree.walk(selector, (node) => {
      if (node.type === "IdSelector" || node.type === "AttributeSelector" || node.type === "PseudoElementSelector") throw new Error(`Forbidden selector node: ${node.type}`);
      if (node.type === "PseudoClassSelector" && node !== first) throw new Error(`Forbidden pseudo-class: ${node.name}`);
      if (node.type === "TypeSelector" && ["html", "body", ":root", "*"].includes(node.name.toLowerCase())) throw new Error(`Forbidden host selector: ${node.name}`);
    });
    const source = csstree.generate(selector);
    rewritten.push(`[data-slide-id="${slideId}"]${source.slice(":slide".length)}`);
  });
  const replacement = csstree.parse(rewritten.join(","), { context: "selectorList" });
  prelude.children = replacement.children;
}

const REQUIRED_THEME_TOKENS = new Set(["--deck-bg", "--deck-surface", "--deck-text", "--deck-muted", "--deck-primary", "--deck-secondary", "--deck-accent", "--deck-positive", "--deck-negative", "--deck-font-sans", "--deck-font-serif", "--deck-title-size", "--deck-heading-size", "--deck-body-size", "--deck-caption-size", "--deck-radius", "--deck-space", "--deck-grid-gap"]);

export function validateThemeCss(css) {
  const ast = csstree.parse(css); const seen = new Set(); let rules = 0;
  csstree.walk(ast, (node) => {
    if (node.type === "Atrule" || node.type === "Url") throw new Error("Theme CSS cannot contain at-rules or URLs");
    if (node.type === "Rule") { rules += 1; if (csstree.generate(node.prelude) !== ":root") throw new Error("Theme CSS may target only :root"); }
    if (node.type === "Declaration") {
      if (!REQUIRED_THEME_TOKENS.has(node.property)) throw new Error(`Unknown theme token: ${node.property}`);
      const value = csstree.generate(node.value); if (/url\s*\(|var\s*\(|expression|javascript:|data:/i.test(value)) throw new Error(`Unsafe theme token value: ${node.property}`);
      assertThemeValue(node.property, value);
      seen.add(node.property);
    }
  });
  if (rules !== 1 || [...REQUIRED_THEME_TOKENS].some((token) => !seen.has(token))) throw new Error("Theme CSS is missing required theme tokens");
  return csstree.generate(ast);
}

function assertThemeValue(token, value) {
  if (["--deck-bg", "--deck-surface", "--deck-text", "--deck-muted", "--deck-primary", "--deck-secondary", "--deck-accent", "--deck-positive", "--deck-negative"].includes(token) && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) throw new Error(`Theme color must be hex: ${token}`);
  const ranges = { "--deck-title-size": [48, 96], "--deck-heading-size": [32, 64], "--deck-body-size": [24, 40], "--deck-caption-size": [16, 28], "--deck-radius": [0, 8], "--deck-space": [8, 40], "--deck-grid-gap": [16, 64] };
  if (ranges[token]) { const match = value.match(/^(\d+)px$/); const number = Number(match?.[1]); if (!match || number < ranges[token][0] || number > ranges[token][1]) throw new Error(`Theme size is out of range: ${token}`); }
  if (token === "--deck-font-sans" && !["Arial,sans-serif", '"Noto Sans SC",Arial,sans-serif'].includes(value)) throw new Error("Unknown sans-serif font stack");
  if (token === "--deck-font-serif" && !["Georgia,serif", '"Noto Serif SC",Georgia,serif'].includes(value)) throw new Error("Unknown serif font stack");
}
```

The rewrite inspects every comma-separated selector AST independently, rejects `:is`, `:where`, `:has`, `:not`, pseudo-elements, IDs, attribute selectors, and any first compound other than the exact pseudo-class `:slide`, then reparses the server-owned selector string before serialization.

- [ ] **Step 5: Run policy tests plus fixture corpus**

Run: `npx vitest run tests/unit/deck-agent/html-policy.test.mjs tests/unit/deck-agent/css-policy.test.mjs`

Expected: all valid fragment/scope tests pass; every attack fixture is rejected with a bounded validation error; parse5/css-tree reserialization is stable across a second validation pass.

- [ ] **Step 6: Commit**

```bash
git add server/deck-agent/html-policy.mjs server/deck-agent/css-policy.mjs tests/fixtures/security tests/unit/deck-agent/html-policy.test.mjs tests/unit/deck-agent/css-policy.test.mjs
git commit -m "feat: enforce HTML deck artifact policy"
```

### Task 6: Assemble the fixed runtime and implement deterministic DOM/visual verification

**Files:**
- Create: `server/deck-agent/runtime-template.mjs`
- Create: `server/deck-agent/renderer.mjs`
- Create: `server/deck-agent/verifier.mjs`
- Create: `skills/generate-html-deck/assets/runtime/base.css`
- Create: `skills/generate-html-deck/assets/runtime/bridge.js`
- Create: `skills/generate-html-deck/assets/runtime/runtime-manifest.json`
- Create: `skills/generate-html-deck/scripts/assemble-deck.mjs`
- Create: `skills/generate-html-deck/scripts/inspect-dom.mjs`
- Create: `skills/generate-html-deck/scripts/capture-slides.mjs`
- Create: `skills/generate-html-deck/scripts/package-deck.mjs`
- Create: `tests/unit/deck-agent/renderer.test.mjs`
- Create: `tests/integration/deck-agent/verifier.browser.test.mjs`
- Create: `tests/helpers/seed-runtime-job.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: sanitized page fragments/CSS, `manifest.json`, local assets, exact Reveal.js/ECharts distributions, and the Artifact store.
- Produces: `createRenderer({ store, runtimeRoot, appOrigin }).assemblePreview({ jobId, revisionId })`, `.assembleStandalone({ jobId, revisionId })`, `createVerifier({ renderer, browserFactory }).verify({ jobId, revisionId, slideIds, captureContactSheet, signal })`, `mergeQaEvidence(dom, visual)`, `mergeVerificationReports(base, replacement, slideIds)`, and `failedSlideIds(report)`.
- `revisionId` is the literal `"working"` during initial generation or a validated `revision-\d{6}` directory after publication; arbitrary directory names are rejected.
- Verification result: `{ ok, slides: [{ slideId, issues, screenshotArtifactId }], contactSheetArtifactId, consoleErrors: [{ slideId, message }] }`. It contains deterministic/browser evidence only; stage handlers decide when to make the budgeted visual-review model call.

- [ ] **Step 1: Write failing CSP, offline, DOM, and pixel-occupancy tests**

```js
// tests/unit/deck-agent/renderer.test.mjs
it("assembles a fixed 1920x1080 offline document without workspace leaks", async () => {
  const html = await renderer.assembleStandalone({ jobId, revisionId: "revision-000001" });
  expect(html).toContain("--deck-width:1920px");
  expect(html).toContain("--deck-height:1080px");
  expect(html).toContain("connect-src 'none'");
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).not.toContain(jobRoot);
  expect(html).not.toMatch(/api[_-]?key|toolCalls|system prompt/i);
});
```

```js
// tests/integration/deck-agent/verifier.browser.test.mjs
it("reports overflow, broken images, duplicate IDs, console errors, and blank slides", async () => {
  const result = await verifier.verify({ jobId, revisionId: "revision-000099", slideIds: ["slide-01", "slide-02"], captureContactSheet: false, signal: new AbortController().signal });
  expect(result.ok).toBe(false);
  expect(result.slides.find((slide) => slide.slideId === "slide-01").issues).toEqual(expect.arrayContaining(["horizontal-overflow", "duplicate-id"]));
  expect(result.slides.find((slide) => slide.slideId === "slide-02").issues).toContain("blank-canvas");
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/renderer.test.mjs tests/integration/deck-agent/verifier.browser.test.mjs`

Expected: FAIL because renderer/verifier modules do not exist.

- [ ] **Step 3: Create a versioned runtime manifest and service-owned bridge**

Generate SHA-256 values for `reveal.js@6.0.1` JavaScript/CSS, `echarts@6.1.0`, `base.css`, and `bridge.js`; persist `{ package, version, relativePath, sha256 }` records in `runtime-manifest.json`. Startup must recompute and compare hashes before accepting jobs.

```js
// bridge.js message envelope; job/revision/origin are injected by runtime-template.mjs.
const channelToken = new URLSearchParams(location.hash.slice(1)).get("channel") || "";
if (!/^[A-Za-z0-9_-]{22}$/.test(channelToken)) throw new Error("Invalid preview channel");
const bridge = Object.freeze({ jobId: "__JOB_ID__", revision: __REVISION__, channelToken });
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== "__PARENT_ORIGIN__") return;
  const message = event.data;
  if (!message || message.type !== "deck-command" || message.channelToken !== bridge.channelToken || message.jobId !== bridge.jobId || message.revision !== bridge.revision) return;
  if (message.command === "go-to-slide" && document.querySelector(`[data-slide-id="${CSS.escape(message.slideId)}"]`)) Reveal.slide(Number(message.index));
});
Reveal.on("slidechanged", (event) => parent.postMessage({ type: "deck-slide-changed", channelToken: bridge.channelToken, jobId: bridge.jobId, revision: bridge.revision, slideId: event.currentSlide.dataset.slideId }, "__PARENT_ORIGIN__"));
```

Preview generation substitutes the exact application origin for `__PARENT_ORIGIN__`; standalone generation removes the parent bridge entirely. The model never writes or edits this file.

- [ ] **Step 4: Assemble preview and standalone documents from trusted pieces only**

```js
// server/deck-agent/runtime-template.mjs
export function buildCsp({ scriptHash, styleHashes, assetOrigin }) {
  const imageSources = ["data:", "blob:", assetOrigin].filter(Boolean).join(" ");
  return ["default-src 'none'", `script-src '${scriptHash}'`, `style-src-elem ${styleHashes.map((hash) => `'${hash}'`).join(" ")}`, "style-src-attr 'unsafe-inline'", `img-src ${imageSources}`, "font-src data:", "media-src data:", "connect-src 'none'", "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "navigate-to 'none'"].join("; ");
}
```

`assemblePreview` may reference only manifest-resolved asset URLs under the exact configured application origin, which is the sole `assetOrigin` allowed by its CSP. For each persisted rootless page fragment, the renderer creates one exact service-owned `<article class="deck-slide" data-slide-root data-slide-id="..." data-source-refs="...">`; it adds `data-density="tight"` only when the manifest contains that deterministic state. QA/contact-sheet documents and `assembleStandalone` convert every asset and font to data URIs, inline the verified fixed runtime, omit all job/event/chat metadata, and return one `dist/index.html`; their CSP omits `assetOrigin`. Escape JSON payloads by replacing `<`, `>`, `&`, U+2028, and U+2029 before embedding. The only `unsafe-inline` allowance is `style-src-attr`, because Reveal writes deterministic transform attributes at runtime; generated HTML cannot contain style attributes, static style elements require hashes, and `script-src` never permits `unsafe-inline` or `unsafe-eval`.

Chart data comes only from the Zod-validated manifest. The service embeds escaped chart JSON as text inside one service-owned `<template id="deck-chart-data">`; fixed runtime code reads `template.content.textContent`, looks up exact `data-chart-id` values, and passes a server-built ECharts option object to the local pinned runtime. It never inserts chart labels, notes, or messages through `innerHTML`.

The renderer appends one escaped `<aside class="notes">` per slide from manifest speaker notes. Fixed runtime code owns an in-page speaker panel, updates it with `textContent` on `slidechanged`, and toggles it with the `S` key without a popup or external speaker-view file. Generated page HTML cannot create `aside.notes`, and the export contains no source document beyond the approved speaker notes/source-ref metadata.

- [ ] **Step 5: Implement bounded Playwright verification and contact sheets**

`verifier.verify` must first compare manifest order, unique stable IDs, source refs, and nonempty speaker notes against the parsed outline. It then launches the bundled Chromium with its sandbox enabled and no `--no-sandbox`/`--disable-setuid-sandbox` flags, uses a job-local temporary profile, creates a fresh context with JavaScript enabled, service workers blocked, a 1920 x 1080 viewport, and a route handler that aborts every `http:`, `https:`, `ws:`, and `wss:` request. For each requested slide it must collect:

```js
const domReport = await page.evaluate(() => {
  const roots = [...document.querySelectorAll("[data-slide-id]")];
  const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
  return roots.map((root) => {
    const bounds = root.getBoundingClientRect();
    const descendants = [...root.querySelectorAll("*")];
    return {
      slideId: root.dataset.slideId,
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      verticalOverflow: root.scrollHeight > root.clientHeight + 1,
      outsideSafeArea: descendants.some((node) => { const rect = node.getBoundingClientRect(); return rect.left < bounds.left - 1 || rect.top < bounds.top - 1 || rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1; }),
      brokenImages: [...root.querySelectorAll("img")].filter((image) => !image.complete || image.naturalWidth === 0).length,
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      visibleTextLength: (root.textContent || "").trim().length,
    };
  });
});
```

Use these pure report combiners in calibration, whole-deck review, and revisions so every stage agrees on failure semantics:

```js
export function mergeQaEvidence(dom, visual) {
  const visualIssues = new Map((visual.failedSlides || []).map((item) => [item.slideId, item.reasons.map((reason) => `visual:${reason}`)]));
  const slides = dom.slides.map((slide) => ({ ...slide, issues: [...new Set([...slide.issues, ...(visualIssues.get(slide.slideId) || [])])] }));
  return { ...dom, slides, ok: slides.every((slide) => slide.issues.length === 0) && dom.consoleErrors.length === 0 };
}

export function mergeVerificationReports(base, replacement, slideIds) {
  const target = new Set(slideIds); const byId = new Map(replacement.slides.map((slide) => [slide.slideId, slide]));
  const slides = base.slides.map((slide) => target.has(slide.slideId) ? byId.get(slide.slideId) || slide : slide);
  const consoleErrors = [...base.consoleErrors.filter((error) => !target.has(error.slideId)), ...replacement.consoleErrors].filter((error, index, all) => all.findIndex((candidate) => candidate.slideId === error.slideId && candidate.message === error.message) === index);
  return { ...base, slides, consoleErrors, ok: slides.every((slide) => slide.issues.length === 0) && consoleErrors.length === 0 };
}

export function failedSlideIds(report) { return [...new Set([...report.slides.filter((slide) => slide.issues.length > 0).map((slide) => slide.slideId), ...report.consoleErrors.map((error) => error.slideId)])]; }
```

Save one screenshot per slide. Use `pngjs` to sample the screenshot and mark `blank-canvas` when fewer than 0.5% of pixels differ by more than 12 RGB levels from the dominant corner color. Compose the contact sheet as local HTML with slide screenshots and capture it in the same network-blocked context. Close the page/context/browser in `finally`, delete the temporary profile, and abort within 90 seconds per deck. Enforce screenshot/profile bytes through the job quota; production deployment must additionally place the worker and Chromium process tree inside a container or OS sandbox with explicit CPU and RSS limits because Node worker limits do not constrain Chromium children.

Add four deterministic Skill CLIs as thin wrappers over these server modules: `assemble-deck.mjs --job --revision`, `inspect-dom.mjs --job --revision --slides`, `capture-slides.mjs --job --revision --slides`, and `package-deck.mjs --job --revision`. Each reads `DECK_JOB_ROOT`, validates all identifiers through the Artifact store, prints bounded JSON, and offers no arbitrary input/output path or subprocess option. The server imports the modules directly; the model cannot execute the CLIs.

- [ ] **Step 6: Run renderer/verifier tests**

Run:

```bash
npm install --save-dev --save-exact pngjs
npx playwright install chromium
npx vitest run tests/unit/deck-agent/renderer.test.mjs tests/integration/deck-agent/verifier.browser.test.mjs
node tests/helpers/seed-runtime-job.mjs artifacts/test-deck-jobs job-00000000-0000-4000-8000-000000000001 revision-000001
DECK_JOB_ROOT=artifacts/test-deck-jobs node skills/generate-html-deck/scripts/inspect-dom.mjs --job job-00000000-0000-4000-8000-000000000001 --revision revision-000001 --slides slide-01,slide-02
```

Expected: tests pass for fixed canvas, valid ECharts rendering, no external requests, overflow/broken-image/font/ID/console detection, nonblank pixel checks, contact-sheet creation, and offline standalone navigation; the CLI prints the seeded fixture's bounded JSON report and exits `0`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server/deck-agent/runtime-template.mjs server/deck-agent/renderer.mjs server/deck-agent/verifier.mjs skills/generate-html-deck/assets/runtime skills/generate-html-deck/scripts tests/helpers/seed-runtime-job.mjs tests/unit/deck-agent/renderer.test.mjs tests/integration/deck-agent/verifier.browser.test.mjs
git commit -m "feat: render and inspect fixed HTML decks"
```

### Task 7: Implement outline, single-design, and two-page calibration stages

**Files:**
- Create: `server/deck-agent/tool-registry.mjs`
- Create: `server/deck-agent/stages/outline-stage.mjs`
- Create: `server/deck-agent/stages/design-stage.mjs`
- Create: `server/deck-agent/stages/calibration-stage.mjs`
- Create: `tests/unit/deck-agent/early-stages.test.mjs`
- Create: `tests/integration/deck-agent/calibration.test.mjs`
- Modify: `scripts/mock-openai.mjs`

**Interfaces:**
- Consumes: Artifact/Event stores, outline parser, Skill loader, Agent runner, HTML/CSS policy, renderer, verifier, and source blocks.
- Produces: `createToolRegistry(deps).forStage(stage, jobContext)`, `runOutlineStage(context)`, `runDesignStage(context)`, and `runCalibrationStage(context)`.
- Successful outputs: `slides-content.md`, `design-brief.md`, `working/theme.css`, sanitized calibration files under `working/slides/`, and `working/manifest.json` checkpoints.

- [ ] **Step 1: Write failing automatic-advance, repair-limit, and calibration-fallback tests**

```js
// tests/unit/deck-agent/early-stages.test.mjs
it("publishes the Markdown artifact and advances without user confirmation", async () => {
  await runOutlineStage(context);
  expect(await store.readArtifact(jobId, "slides-content.md")).toContain("## 幻灯片 1");
  expect(eventsFor(jobId)).toContainEqual(expect.objectContaining({ type: "artifact", artifactId: "slides-content", status: "done" }));
  expect(context.waitForUser).not.toHaveBeenCalled();
});

it("repairs invalid Markdown once and then fails in outline", async () => {
  runner.runStage.mockResolvedValueOnce(invalidOutlineResult).mockResolvedValueOnce(invalidOutlineResult);
  await expect(runOutlineStage(context)).rejects.toThrow(/outline validation failed/i);
  expect(runner.runStage).toHaveBeenCalledTimes(2);
});

it("calibrates the cover and densest slide and falls back after one failed correction", async () => {
  verifier.verify
    .mockResolvedValueOnce({ ok: false, slides: [{ slideId: "slide-01", issues: ["overflow"] }, { slideId: "slide-07", issues: ["blank-canvas"] }] })
    .mockResolvedValueOnce({ ok: false, slides: [{ slideId: "slide-01", issues: ["overflow"] }, { slideId: "slide-07", issues: [] }] })
    .mockResolvedValueOnce({ ok: true, slides: [{ slideId: "slide-01", issues: [] }, { slideId: "slide-07", issues: [] }] });
  await runCalibrationStage(context);
  expect(context.writeDefaultTheme).toHaveBeenCalledTimes(1);
  expect(context.generateSlides).toHaveBeenNthCalledWith(1, ["slide-01", "slide-07"]);
  expect(context.generateSlides).toHaveBeenCalledTimes(2);
  expect(verifier.verify).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/early-stages.test.mjs tests/integration/deck-agent/calibration.test.mjs`

Expected: FAIL because stage handlers and tool registry do not exist.

- [ ] **Step 3: Register stage-specific tools with Zod argument schemas**

```js
// server/deck-agent/tool-registry.mjs
import { z } from "zod";

const assetSlotSchema = z.object({ slotId: z.string().regex(/^[a-z0-9-]+$/), purpose: z.string().min(1).max(500), aspectRatio: z.enum(["16:9", "4:3", "3:2", "1:1", "3:4"]), safeArea: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) }).strict(), sourceBlockIds: z.array(z.string()).max(20) }).strict();
const chartSpecSchema = z.object({ chartId: z.string().regex(/^chart-[a-z0-9-]+$/), type: z.enum(["bar", "line", "pie", "scatter"]), labels: z.array(z.string().max(120)).max(40), series: z.array(z.object({ name: z.string().max(120), values: z.array(z.number().finite()).max(40), colorToken: z.enum(["primary", "secondary", "accent", "positive", "negative"]) }).strict()).min(1).max(8) }).strict();
const writeSlideInputSchema = z.object({ slideId: z.string().regex(/^slide-\d{2}$/), html: z.string().max(200_000), css: z.string().max(120_000), assetSlots: z.array(assetSlotSchema).max(6), charts: z.array(chartSpecSchema).max(6) }).strict();

const STAGE_TOOLS = Object.freeze({
  outline: ["read_source_blocks", "write_outline"],
  design: ["read_outline", "write_design_brief", "write_theme"],
  calibrating: ["read_outline", "write_slide", "render_deck", "inspect_slide", "capture_slide", "patch_slide"],
  building: ["read_outline", "write_slide"],
  "generating-assets": ["generate_asset", "patch_slide"],
  verifying: ["render_deck", "inspect_slide", "capture_slide"],
  repairing: ["read_outline", "inspect_slide", "capture_slide", "patch_slide", "publish_deck"],
});

export function createToolRegistry({ tools }) {
  return { forStage(stage, context) {
    const names = STAGE_TOOLS[stage];
    if (!names) throw new Error(`No tool policy for stage ${stage}`);
    return Object.fromEntries(names.map((name) => [name, bindTool(tools[name], context)]));
  } };
}
```

Register `writeSlideInputSchema` on `write_slide`. `write_outline` accepts `{ markdown }` and validates before writing. `write_theme` accepts `{ designBriefMarkdown, themeCss }` and validates theme tokens. `write_slide` ignores model-supplied IDs/source refs beyond the requested target, derives stable identity, source refs, title, and speaker notes from the outline, validates structured chart data, sanitizes HTML/CSS, and atomically writes the rootless fragment to `working/slides/<slideId>.html`, scoped CSS to `working/slides/<slideId>.css`, and identity/source/density metadata to the corresponding `working/manifest.json` entry. Unresolved visual regions are empty elements with `data-asset-slot`; only the server asset stage may insert `<img src="asset://<validated assetId>">` and `data-asset-state`.

- [ ] **Step 4: Implement outline and design stages with exact budgets**

```js
// outline-stage.mjs
export async function runOutlineStage(context) {
  const skill = await context.skillLoader.load("outline");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await context.runner.runStage({ jobId: context.jobId, stage: "outline", messages: buildOutlineMessages(context, skill, attempt), allowedTools: context.tools.forStage("outline", context), maxTurns: 2, maxUpstreamCalls: 2, timeoutMs: 120_000, signal: context.signal, emit: context.emit });
    const markdown = await context.store.readArtifact(context.jobId, "slides-content.md", { optional: true });
    try {
      const outline = parseOutline(markdown || "", { expectedSlideCount: context.input.source.slideCount, sourceBlockIds: new Set(context.sourceBlocks.map((block) => block.id)) });
      await context.store.writeJson(context.jobId, "working/manifest.json", initialManifest(outline));
      await context.emit({ stage: "outline", type: "artifact", status: "done", title: "整理幻灯片内容大纲并写入 Markdown", artifactId: "slides-content", progress: { completed: 1, total: 1 } });
      return outline;
    } catch (error) {
      if (attempt === 1) throw new Error(`Outline validation failed after one repair: ${error.message}`);
    }
  }
}
```

`runDesignStage` performs one model call, writes exactly one `design-brief.md` and one validated `working/theme.css`, and emits no choice/confirmation event. The design brief must specify typography scale, palette, grid, spacing, image grammar, chart grammar, motion level, and prohibited patterns without altering outline content.

Map existing UI styles to a default catalog hint before the call; the model still returns one direction only:

```js
const STYLE_THEME_HINT = Object.freeze({ blank: "minimal-white", "product-calm": "corporate-clean", "consulting-grid": "swiss-grid", "editorial-tech": "magazine-bold", "cinematic-dark": "tokyo-night" });
const themeHint = STYLE_THEME_HINT[context.input.source.styleId] || "minimal-white";
```

`reviewCalibration` performs exactly one structured visual call with `{ failedSlides: [{ slideId, reasons }], designChanges: string[] }`, rejects IDs outside the two calibration targets, and never receives source blocks or the full Skill pack. The correction may update only `design-brief.md`, `working/theme.css`, and the calibration slide files.

- [ ] **Step 5: Implement calibration with one correction and deterministic fallback**

```js
// calibration-stage.mjs
export async function runCalibrationStage(context) {
  const outline = await context.readOutline();
  const slideIds = selectCalibrationSlides(outline);
  await context.generateSlides(slideIds, { stage: "calibrating", maxUpstreamCalls: 1 });
  let dom = await context.verifier.verify({ jobId: context.jobId, revisionId: context.revisionId, slideIds, captureContactSheet: true, signal: context.signal });
  const visual = await context.reviewCalibration({ slideIds, contactSheetArtifactId: dom.contactSheetArtifactId, maxUpstreamCalls: 1 });
  let report = mergeQaEvidence(dom, visual);
  if (!report.ok) {
    await context.reviseCalibration({ slideIds, report, maxUpstreamCalls: 1 });
    report = await context.verifier.verify({ jobId: context.jobId, revisionId: context.revisionId, slideIds, captureContactSheet: false, signal: context.signal });
    if (!report.ok) {
      await context.writeDefaultTheme();
      await context.generateSlides(slideIds, { stage: "calibrating", deterministicTheme: true, maxUpstreamCalls: 1 });
      report = await context.verifier.verify({ jobId: context.jobId, revisionId: context.revisionId, slideIds, captureContactSheet: false, signal: context.signal });
      if (!report.ok) throw new Error("Verified default calibration failed");
    }
  }
  await context.lockDesignRules({ slideIds, report });
}
```

- [ ] **Step 6: Run focused and retained tests**

Run:

```bash
npx vitest run tests/unit/deck-agent/early-stages.test.mjs tests/integration/deck-agent/calibration.test.mjs
npm run test:attachments
npm run test:provenance
```

Expected: tests pass; source block IDs survive attachment parsing into outline validation; no user gate is called; repair and fallback counts are exact.

- [ ] **Step 7: Commit**

```bash
git add server/deck-agent/tool-registry.mjs server/deck-agent/stages scripts/mock-openai.mjs tests/unit/deck-agent/early-stages.test.mjs tests/integration/deck-agent/calibration.test.mjs
git commit -m "feat: generate and calibrate HTML deck plans"
```

### Task 8: Build pages in bounded batches, resolve assets, review once, and publish

**Files:**
- Create: `server/deck-agent/stages/build-stage.mjs`
- Create: `server/deck-agent/stages/asset-stage.mjs`
- Create: `server/deck-agent/stages/verify-stage.mjs`
- Create: `server/deck-agent/stages/publish-stage.mjs`
- Create: `server/deck-agent/orchestrator.mjs`
- Create: `tests/unit/deck-agent/batching.test.mjs`
- Create: `tests/integration/deck-agent/orchestrator.test.mjs`
- Create: `tests/fixtures/deck-agent/dense-report/source.json`
- Create: `tests/fixtures/deck-agent/data-table/source.json`
- Create: `tests/fixtures/deck-agent/image-portfolio/source.json`
- Modify: `scripts/mock-openai.mjs`

**Interfaces:**
- Consumes: stage handlers from Task 7 plus image client, renderer, verifier, Artifact/Event stores, and fixed manifest.
- Produces: `partitionSlideBatches(slideIds)`, `mapConcurrent(items, limit, worker)`, `resolveAssetSlots(context)`, `runVerificationStage(context)`, `publishDeck(context)`, and `createDeckJobOrchestrator(deps).run(jobId, { signal })`.

- [ ] **Step 1: Write failing batch, checkpoint, asset fallback, and repair-budget tests**

```js
// tests/unit/deck-agent/batching.test.mjs
it("uses 2-3 target pages per normal batch and no more than two concurrent workers", async () => {
  expect(partitionSlideBatches(["03", "04", "05", "06", "07", "08", "09", "10"])).toEqual([["03", "04", "05"], ["06", "07", "08"], ["09", "10"]]);
  let active = 0; let maximum = 0;
  await mapConcurrent(partitionSlideBatches(["03", "04", "05", "06", "07", "08", "09", "10"]), 2, async () => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1; });
  expect(maximum).toBe(2);
});
```

```js
// tests/integration/deck-agent/orchestrator.test.mjs
it("keeps successful pages when one batch fails and retries only failed targets", async () => {
  buildBatch.mockRejectedValueOnce(new BatchError(["slide-06"])).mockResolvedValueOnce([{ slideId: "slide-06", ok: true }]);
  await orchestrator.run(jobId, { signal: new AbortController().signal });
  expect(buildBatch.mock.calls[1][0].slideIds).toEqual(["slide-06"]);
  expect((await store.readJson(jobId, "working/manifest.json")).slides.filter((slide) => slide.status === "done")).toHaveLength(10);
});

it("falls back to an empty asset slot and performs one whole-deck review plus one targeted repair", async () => {
  imageClient.generateAsset.mockRejectedValue(new Error("mock 524"));
  visualReview.mockResolvedValue({ failedSlides: [{ slideId: "slide-08", reasons: ["weak hierarchy"] }] });
  reviewRepairedSlides.mockResolvedValue({ failedSlides: [] });
  await orchestrator.run(jobId, { signal: new AbortController().signal });
  expect(visualReview).toHaveBeenCalledTimes(1);
  expect(repairSlides).toHaveBeenCalledWith(["slide-08"], expect.anything());
  expect(repairSlides).toHaveBeenCalledTimes(1);
  expect(reviewRepairedSlides).toHaveBeenCalledTimes(1);
  expect(await store.readArtifact(jobId, "working/slides/slide-04.html")).toContain('data-asset-state="empty"');
});

it("publishes persistent post-repair visual failures as needs-review", async () => {
  visualReview.mockResolvedValue({ failedSlides: [{ slideId: "slide-08", reasons: ["weak hierarchy"] }] });
  reviewRepairedSlides.mockResolvedValue({ failedSlides: [{ slideId: "slide-08", reasons: ["weak hierarchy"] }] });
  const result = await orchestrator.run(jobId, { signal: new AbortController().signal });
  expect(result.status).toBe("needs-review");
  expect(repairSlides).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/batching.test.mjs tests/integration/deck-agent/orchestrator.test.mjs`

Expected: FAIL because batch helpers and orchestrator do not exist.

- [ ] **Step 3: Implement deterministic batching and independent page checkpoints**

```js
// build-stage.mjs
export function partitionSlideBatches(slideIds) {
  const batches = [];
  for (let index = 0; index < slideIds.length;) {
    const remaining = slideIds.length - index;
    const size = remaining === 4 ? 2 : Math.min(3, remaining);
    batches.push(slideIds.slice(index, index + size));
    index += size;
  }
  return batches;
}

export async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length); let cursor = 0;
  async function consume() { while (cursor < items.length) { const index = cursor; cursor += 1; try { results[index] = { status: "fulfilled", value: await worker(items[index], index) }; } catch (reason) { results[index] = { status: "rejected", reason }; } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => consume()));
  return results;
}
```

Each batch prompt receives the global title, narrative, locked brief summary, full Markdown for target pages, neighboring titles/claims, allowed assets, and HTML/CSS contract. A successful `write_slide` is checkpointed immediately. `mapConcurrent` already returns one settled-result object per input, so after the first pass collect failed `slideId`s directly from entries whose `status === "rejected"`; do not wrap its returned array in `Promise.allSettled`, which would turn those entries into fulfilled outer results. Retry only the failed IDs once and never rewrite successful page files.

```js
const firstPass = await mapConcurrent(batches, 2, (slideIds) => buildBatch({ ...context, slideIds }));
const failedSlideIds = [...new Set(firstPass.flatMap((result, index) => {
  if (result.status !== "rejected") return [];
  return Array.isArray(result.reason?.slideIds) ? result.reason.slideIds : batches[index];
}))];
if (failedSlideIds.length) await buildBatch({ ...context, slideIds: failedSlideIds, retry: true });
```

For a one-slide deck, calibration contains that single page. When calibration leaves exactly one unbuilt page, include its nearest calibrated neighbor as read-only context so the model call still receives two-page continuity, but permit `write_slide` only for the one target; never regenerate the calibrated neighbor.

- [ ] **Step 4: Resolve structured asset slots after layout**

For every manifest slot `{ slotId, purpose, aspectRatio, safeArea, sourceBlockIds }`, choose in this order: uploaded asset with a matching source reference, licensed internal asset with matching tags, generated asset when enabled and within `imageCount`, or empty fallback. `generateAsset` receives only purpose, aspect ratio, safe area, and relevant source summaries; its prompt must state that presentation text is forbidden inside the image.

Walk slots in stable slide/slot order with image-generation concurrency `1`, checkpoint every resolved or empty slot, and skip completed slots on retry. Matching uploaded/library assets is local and does not consume the generation budget.

```js
export async function resolveAssetSlot(context, slide, slot) {
  const matched = matchUploadedAsset(context.uploads, slot) || matchLicensedAsset(context.library, slot);
  if (matched) return context.publishAsset(matched, slide.slideId, slot.slotId);
  if (context.generationBudget.take()) {
    try { return await context.generateAndPublishAsset({ slide, slot, signal: context.signal }); }
    catch (error) { await context.emitAssetFallback(slide.slideId, slot.slotId, error); }
  }
  await context.markEmptyAssetSlot(slide.slideId, slot.slotId);
  return { state: "empty", slotId: slot.slotId };
}
```

`markEmptyAssetSlot` reparses the already sanitized rootless fragment, adds only `data-asset-state="empty"` to the exact `data-asset-slot`, removes its `<img>`, passes the result through `validateStoredSlideHtml`, and atomically replaces that slide.

- [ ] **Step 5: Implement one whole-deck review and one targeted repair**

`runVerificationStage` first runs deterministic DOM checks on every page. It creates one contact sheet and sends one structured whole-deck visual-review request containing only the contact sheet plus slide titles/claims. The result schema is `{ failedSlides: [{ slideId, reasons: string[] }] }`; reject unknown slide IDs. Merge deterministic and visual failures and repair that union once. Then rerun deterministic QA/screenshots only for repaired slides and make one targeted visual recheck using only those repaired-slide screenshots. Merge both replacement reports into the original report. Persist any remaining deterministic or `visual:*` failure as `needs-review`; otherwise publish `ready`. The targeted recheck cannot request another repair.

`applyDeterministicRepairs` has three bounded operations: replace a broken asset slot with its empty-state layout, replace a failed font token with the bundled sans/serif fallback, and record one service-owned `density: "tight"` manifest state that makes the renderer add `data-density="tight"` and reduce body/font/spacing tokens by a fixed 10% for an overflowing slide. It may run once per slide, reparses/revalidates every changed fragment, and must not truncate text, change claims, delete table rows, alter source refs, or introduce arbitrary CSS. All other failures go to the single Agent repair round.

```js
export async function runVerificationStage(context) {
  let deterministic = await context.verifier.verify({ jobId: context.jobId, revisionId: context.revisionId, slideIds: context.allSlideIds, captureContactSheet: true, signal: context.signal });
  const deterministicFailures = failedSlideIds(deterministic);
  if (deterministicFailures.length) {
    const changed = await context.applyDeterministicRepairs(deterministicFailures, deterministic);
    if (changed.length) {
      const rechecked = await context.verifier.verify({ jobId: context.jobId, revisionId: context.revisionId, slideIds: changed, captureContactSheet: false, signal: context.signal });
      deterministic = mergeVerificationReports(deterministic, rechecked, changed);
      deterministic = { ...deterministic, contactSheetArtifactId: await context.rebuildContactSheet(deterministic) };
    }
  }
  const visual = await context.reviewContactSheet({ contactSheetArtifactId: deterministic.contactSheetArtifactId, slideIds: context.allSlideIds, maxUpstreamCalls: 1 });
  const initial = mergeQaEvidence(deterministic, visual);
  const failed = failedSlideIds(initial);
  if (failed.length === 0) return { status: "ready", report: initial };
  await context.transition(context.jobId, "repairing");
  await context.repairSlides(failed, { report: initial, maxUpstreamCalls: 1 });
  const deterministicFinal = await context.verifier.verify({ jobId: context.jobId, revisionId: context.revisionId, slideIds: failed, captureContactSheet: false, signal: context.signal });
  const visualFinal = await context.reviewRepairedSlides({
    slideIds: failed,
    screenshotArtifactIds: deterministicFinal.slides.map((slide) => slide.screenshotArtifactId),
    maxUpstreamCalls: 1,
  });
  const replacement = mergeQaEvidence(deterministicFinal, visualFinal);
  const report = mergeVerificationReports(initial, replacement, failed);
  return { status: report.ok ? "ready" : "needs-review", report };
}
```

- [ ] **Step 6: Implement the deterministic orchestrator and checkpoints**

```js
// orchestrator.mjs
const HANDLERS = { outline: runOutlineStage, design: runDesignStage, calibrating: runCalibrationStage, building: runBuildStage, "generating-assets": runAssetStage, verifying: runVerificationStage };

export function createDeckJobOrchestrator(deps) {
  return { async run(jobId, { signal }) {
    let job = await deps.store.readJob(jobId);
    while (!TERMINAL_JOB_STATUSES.includes(job.status)) {
      const stage = deps.nextIncompleteStage(job);
      await deps.transition(jobId, stage);
      try {
        const result = await HANDLERS[stage]({ ...deps, jobId, signal });
        await deps.checkpoint(jobId, stage, result);
        if (stage === "verifying") { await publishDeck({ ...deps, jobId, signal, result }); await deps.transition(jobId, result.status); }
      } catch (error) {
        if (signal.aborted) { await deps.transition(jobId, "cancelled"); break; }
        await deps.fail(jobId, stage, error); break;
      }
      job = await deps.store.readJob(jobId);
    }
    return deps.store.readJob(jobId);
  } };
}
```

`nextIncompleteStage` derives from persisted checkpoints, never a model response. `publishDeck` writes `working/qa/report.json`, calls `assembleStandalone`, writes `working/dist/index.html`, creates `revision-000001`, registers artifact descriptors, and emits terminal events only after every atomic rename succeeds.

- [ ] **Step 7: Run lifecycle tests**

Run:

```bash
npx vitest run tests/unit/deck-agent/batching.test.mjs tests/integration/deck-agent/orchestrator.test.mjs
npx vitest run tests/integration/deck-agent/verifier.browser.test.mjs
```

Expected: tests pass for 2-3 page batching, maximum concurrency two, partial checkpoint retention, one failed-batch retry, optional image fallback, one whole-deck contact-sheet review, one targeted repair, one repaired-slide visual recheck, `ready`, and persistent visual/deterministic failures becoming `needs-review`.

- [ ] **Step 8: Commit**

```bash
git add server/deck-agent/stages server/deck-agent/orchestrator.mjs scripts/mock-openai.mjs tests/unit/deck-agent/batching.test.mjs tests/integration/deck-agent/orchestrator.test.mjs tests/fixtures/deck-agent
git commit -m "feat: orchestrate bounded HTML deck generation"
```

### Task 9: Add candidate revisions, natural-language edits, atomic publication, and undo

**Files:**
- Create: `server/deck-agent/revision-store.mjs`
- Create: `server/deck-agent/stages/revision-stage.mjs`
- Create: `tests/unit/deck-agent/revision-store.test.mjs`
- Create: `tests/integration/deck-agent/revision-stage.test.mjs`
- Modify: `server/deck-agent/orchestrator.mjs`
- Modify: `server/deck-agent/renderer.mjs`

**Interfaces:**
- Consumes: a published deck revision, exact `expectedRevision`, user instruction, optional explicit `slideIds`, and optional `currentSlideId`.
- Produces: `createRevisionStore({ store })`, `resolveEditScope(request, manifest)`, and `orchestrator.applyMessage(jobId, request, { signal })` / `.undo(jobId)`.
- Revision store methods: `createInitial`, `createCandidate`, `readCurrent`, `publishCandidate`, `discardCandidate`, `undo`, and `resolveRevisionArtifact`.

- [ ] **Step 1: Write failing candidate, conflict, failed-QA, scoped-edit, and undo tests**

```js
// tests/unit/deck-agent/revision-store.test.mjs
it("does not publish a candidate that failed QA", async () => {
  const parent = await revisions.createInitial(jobId, workingFiles);
  const candidate = await revisions.createCandidate(jobId, { parentRevision: parent.number, instruction: "放大标题", slideIds: ["slide-03"] });
  await revisions.recordQa(jobId, candidate.number, { ok: false, slides: [{ slideId: "slide-03", issues: ["overflow"] }] });
  await expect(revisions.publishCandidate(jobId, candidate.number, { expectedRevision: parent.number })).rejects.toThrow(/QA/i);
  expect((await revisions.readCurrent(jobId)).number).toBe(parent.number);
});

it("publishes by one atomic pointer write and undo returns to the parent", async () => {
  const parent = await revisions.createInitial(jobId, workingFiles);
  const candidate = await createPassingCandidate(revisions, jobId, parent.number);
  await revisions.publishCandidate(jobId, candidate.number, { expectedRevision: parent.number });
  expect((await revisions.readCurrent(jobId)).number).toBe(candidate.number);
  await revisions.undo(jobId, { expectedRevision: candidate.number });
  expect((await revisions.readCurrent(jobId)).number).toBe(parent.number);
});
```

```js
// tests/integration/deck-agent/revision-stage.test.mjs
it("defaults an unnumbered instruction to the current preview slide", async () => {
  await orchestrator.applyMessage(jobId, { instruction: "把结论写得更直接", currentSlideId: "slide-05", expectedRevision: 1 }, { signal });
  expect(patchSlides).toHaveBeenCalledWith(["slide-05"], expect.anything());
  expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({ slideIds: ["slide-05"] }));
});

it("keeps explicit page targets even when the classifier suggests a theme edit", async () => {
  classifier.mockResolvedValueOnce({ scope: "theme", slideIds: [] });
  await orchestrator.applyMessage(jobId, { instruction: "把这些页改成深色", slideIds: ["slide-03"], currentSlideId: "slide-02", expectedRevision: 1 }, { signal });
  expect(patchCandidate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ slideIds: ["slide-03"], classification: expect.objectContaining({ scope: "slides", slideIds: ["slide-03"] }) }));
  expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({ slideIds: ["slide-03"] }));
});

it("rechecks every slide for a whole-theme edit and rejects narrative rewrites", async () => {
  classifier.mockResolvedValueOnce({ scope: "theme", slideIds: [] });
  await orchestrator.applyMessage(jobId, { instruction: "整套改成深色发布会风格", currentSlideId: "slide-02", expectedRevision: 1 }, { signal });
  expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({ slideIds: allSlideIds }));
  classifier.mockResolvedValueOnce({ scope: "new-job-required", slideIds: [] });
  await expect(orchestrator.applyMessage(jobId, { instruction: "完全重写叙事", currentSlideId: "slide-02", expectedRevision: 2 }, { signal })).rejects.toMatchObject({ statusCode: 409 });
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent/revision-store.test.mjs tests/integration/deck-agent/revision-stage.test.mjs`

Expected: FAIL because revision storage and edit orchestration do not exist.

- [ ] **Step 3: Implement immutable revision directories and an atomic current pointer**

The initial publish copies the validated working `manifest.json`, `theme.css`, `slides/`, `qa/`, and `dist/` into `revisions/revision-000001/`. Shared local assets remain immutable under the job's `assets/` directory. A candidate is created in `revisions/.candidate-<uuid>/`, receives a full copy of the current revision excluding screenshots, then is atomically renamed to its numbered revision. Publication changes only `current-revision.json`; failed candidates remain inspectable until cleanup but never become current.

```js
// server/deck-agent/revision-store.mjs
export function createRevisionStore({ store, now = () => new Date().toISOString() }) {
  async function publishCandidate(jobId, number, { expectedRevision }) {
    return store.runExclusive(jobId, async () => {
      const current = await readCurrent(jobId, { alreadyLocked: true });
      if (current.number !== expectedRevision) throw conflict(`Expected revision ${expectedRevision}, current is ${current.number}`);
      const meta = await readRevisionMeta(jobId, number, { alreadyLocked: true });
      if (meta.parentRevision !== current.number) throw conflict("Candidate parent is no longer current");
      if (meta.qa?.ok !== true) throw conflict("Candidate revision has not passed QA");
      await store.writeJson(jobId, "current-revision.json", { number, revisionId: meta.revisionId, publishedAt: now() }, { alreadyLocked: true });
      await store.updateJob(jobId, { revision: number }, { alreadyLocked: true });
      return meta;
    });
  }
  async function undo(jobId, { expectedRevision }) {
    const current = await readCurrent(jobId);
    if (current.number !== expectedRevision) throw conflict("Revision changed before undo");
    const meta = await readRevisionMeta(jobId, current.number);
    if (!meta.parentRevision) throw conflict("No parent revision is available");
    return pointToExistingRevision(jobId, meta.parentRevision, expectedRevision);
  }
  return { createInitial, createCandidate, recordQa, readCurrent, publishCandidate, discardCandidate, undo, resolveRevisionArtifact };
}
```

Revision metadata is strict JSON: `{ revisionId, number, parentRevision, instruction, scope, slideIds, changedFiles, qa, createdAt }`. It never stores model prompts or raw chat history.

- [ ] **Step 4: Implement target resolution and candidate QA**

```js
// revision-stage.mjs
export function resolveExplicitTargets({ slideIds, currentSlideId }, manifest) {
  const known = new Set(manifest.slides.map((slide) => slide.slideId));
  const targets = slideIds?.length ? [...new Set(slideIds)] : currentSlideId ? [currentSlideId] : [];
  if (targets.some((slideId) => !known.has(slideId))) throw badRequest("Edit references an unknown slide");
  if (targets.length === 0) throw badRequest("An edit requires the current slide or explicit slide IDs");
  return targets;
}

export async function runRevisionStage(context, request) {
  const current = await context.revisions.readCurrent(context.jobId);
  if (request.expectedRevision !== current.number) throw conflict("Deck revision changed; reload before editing");
  const manifest = await context.readRevisionManifest(current.number);
  const classification = await context.classifyInstruction(request, manifest);
  if (classification.scope === "new-job-required") throw conflict("A narrative rewrite requires a new job");
  const explicitSlideIds = request.slideIds?.length ? resolveExplicitTargets({ slideIds: request.slideIds }, manifest) : undefined;
  const effectiveClassification = explicitSlideIds ? { ...classification, scope: "slides", slideIds: explicitSlideIds } : classification;
  const slideIds = explicitSlideIds || (effectiveClassification.scope === "theme" ? manifest.slides.map((slide) => slide.slideId) : resolveExplicitTargets({ slideIds: effectiveClassification.slideIds, currentSlideId: request.currentSlideId }, manifest));
  const candidate = await context.revisions.createCandidate(context.jobId, { parentRevision: current.number, instruction: request.instruction, scope: effectiveClassification.scope, slideIds });
  try {
    await context.patchCandidate(candidate, { request, slideIds, classification: effectiveClassification });
    const dom = await context.verifier.verify({ jobId: context.jobId, revisionId: candidate.revisionId, slideIds, captureContactSheet: true, signal: context.signal });
    const visual = await context.reviewCandidate({ candidate, slideIds, contactSheetArtifactId: dom.contactSheetArtifactId, maxUpstreamCalls: 1 });
    const qa = mergeQaEvidence(dom, visual);
    await context.revisions.recordQa(context.jobId, candidate.number, qa);
    if (!qa.ok) throw conflict("Candidate revision failed QA");
    await context.renderCandidate(candidate);
    return context.revisions.publishCandidate(context.jobId, candidate.number, { expectedRevision: current.number });
  } catch (error) { await context.revisions.discardCandidate(context.jobId, candidate.number, error); throw error; }
}
```

The classifier uses one structured call and may return only `slides`, `theme`, or `new-job-required`. After rejecting `new-job-required`, valid explicit request `slideIds` override both model-inferred IDs and a model-inferred `theme` scope; the effective scope becomes `slides`, so only those pages can change. A theme edit may change `theme.css` only when the request has no explicit page targets; a slide edit may change only target slide HTML/CSS/assets. Neither path modifies `slides-content.md`.

- [ ] **Step 5: Run revision tests**

Run: `npx vitest run tests/unit/deck-agent/revision-store.test.mjs tests/integration/deck-agent/revision-stage.test.mjs`

Expected: tests pass for expected-revision conflicts, target defaulting, explicit multi-page edits, theme-wide QA, failed candidate rollback, successful atomic publication, and undo.

- [ ] **Step 6: Commit**

```bash
git add server/deck-agent/revision-store.mjs server/deck-agent/stages/revision-stage.mjs server/deck-agent/orchestrator.mjs server/deck-agent/renderer.mjs tests/unit/deck-agent/revision-store.test.mjs tests/integration/deck-agent/revision-stage.test.mjs
git commit -m "feat: publish verified deck revisions atomically"
```

### Task 10: Expose durable Job APIs with cancellation, retry, replay, and restart recovery

**Files:**
- Create: `server/deck-agent/job-manager.mjs`
- Create: `server/deck-agent/worker-entry.mjs`
- Create: `server/deck-agent/routes.mjs`
- Create: `tests/integration/deck-agent/jobs-api.test.mjs`
- Create: `tests/integration/deck-agent/recovery-cancel-events.test.mjs`
- Modify: `server/index.mjs`

**Interfaces:**
- Consumes: orchestrator/revisions, Artifact/Event stores, normalized source input, and server configuration.
- Produces: `createJobManager({ store, events, executor })` and `createDeckJobRouter({ manager, events, store, revisions, parentOrigin })`.
- Job manager methods: `start`, `create`, `get`, `cancel`, `retry`, `message`, `undo`, and `shutdown`.
- Routes: the eight approved `/api/html-deck/jobs` endpoints plus manifest-resolved preview/artifact delivery.

`normalizeInput` reuses the existing server source normalizer, then rejects duplicate block IDs, any `block.id !== block.source.blockId`, unsupported source kinds/extraction methods, and source/image payloads over the Task 2 quotas. It returns only the fields accepted by `createJobRequestSchema`; provider/model/key/base/proxy fields are dropped.

- [ ] **Step 1: Write failing API, replay, cancel, retry, and recovery tests**

```js
// tests/integration/deck-agent/jobs-api.test.mjs
it("creates a job and never echoes provider configuration", async () => {
  const response = await request(app).post("/api/html-deck/jobs").send({ ...validRequest, apiKey: "leak", provider: "attacker" }).expect(202);
  expect(response.body.job.status).toBe("queued");
  expect(JSON.stringify(response.body)).not.toMatch(/leak|attacker/);
  expect(await store.readJson(response.body.job.id, "source-blocks.json")).toEqual(validRequest.source.sourceBlocks);
});

it("serves artifacts by manifest ID and rejects path-like IDs", async () => {
  await request(app).get(`/api/html-deck/jobs/${jobId}/artifacts/slides-content`).expect(200).expect("Content-Type", /text\/markdown/);
  await request(app).get(`/api/html-deck/jobs/${jobId}/artifacts/..%2f..%2f.env`).expect(400);
});
```

```js
// tests/integration/deck-agent/recovery-cancel-events.test.mjs
it("replays strictly after seq and stops artifact writes after cancellation", async () => {
  const stream = await openEventStream(app, jobId, 3);
  expect((await stream.take(2)).map((event) => event.seq)).toEqual([4, 5]);
  await request(app).post(`/api/html-deck/jobs/${jobId}/cancel`).expect(202);
  const countAtCancel = (await store.listArtifacts(jobId)).length;
  await executor.settled(jobId);
  expect((await store.listArtifacts(jobId)).length).toBe(countAtCancel);
});

it("resumes a nonterminal job from its earliest incomplete checkpoint after restart", async () => {
  await seedJob({ status: "building", checkpoints: ["outline", "design", "calibrating"], completedSlides: ["slide-01", "slide-07", "slide-02", "slide-03"] });
  await manager.start();
  expect(executor.start).toHaveBeenCalledWith(jobId, expect.objectContaining({ resumeFrom: "building" }));
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/integration/deck-agent/jobs-api.test.mjs tests/integration/deck-agent/recovery-cancel-events.test.mjs`

Expected: FAIL because the manager/router do not exist.

- [ ] **Step 3: Implement an injectable worker executor and manager lifecycle**

Production `worker-entry.mjs` runs one job in a Node worker thread with `resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 }`. The worker imports configuration itself, never receives secrets through `workerData`, and accepts only `{ type: "run", jobId, resumeFrom }` or `{ type: "cancel", jobId }`. Tests inject a fake executor with the same interface.

```js
export function createJobManager({ store, events, executor, normalizeInput, now = () => new Date().toISOString() }) {
  const active = new Map();
  async function create(raw) {
    const input = normalizeInput(raw);
    const jobId = `job-${crypto.randomUUID()}`;
    const job = await store.createJob({ jobId, title: input.source.topic, input: { source: { ...input.source, sourceBlocks: undefined, images: undefined }, options: input.options }, sourceBlocks: input.source.sourceBlocks });
    await store.persistUploadedAssets(jobId, input.source.images);
    await events.append(jobId, { stage: "queued", type: "job", status: "queued", title: "已创建 HTML 幻灯片任务" });
    await events.append(jobId, { stage: "queued", type: "message", status: "done", title: "开始制作演示文稿", message: `我会把“${input.source.topic}”整理成面向${input.source.audience || "目标听众"}的 ${input.source.slideCount} 页演示，先生成可查看的 Markdown 内容大纲，然后自动进入设计。` });
    active.set(jobId, executor.start(jobId, { resumeFrom: "outline" }).finally(() => active.delete(jobId)));
    return publicJob(job);
  }
  async function cancel(jobId) {
    const job = await store.readJob(jobId);
    if (TERMINAL_JOB_STATUSES.includes(job.status)) throw conflict("Job is not cancellable");
    await executor.cancel(jobId);
    const stopped = await store.readJob(jobId);
    if (!TERMINAL_JOB_STATUSES.includes(stopped.status)) {
      await store.updateJob(jobId, { status: "cancelled", updatedAt: now() });
      await events.append(jobId, { stage: "cancelled", type: "job", status: "cancelled", title: "任务已取消" });
    }
    return publicJob(await store.readJob(jobId));
  }
  return { start, create, get, cancel, retry, message, undo, shutdown };
}
```

`start` scans `listRecoverableJobs`, reconciles partial event tails, finds each earliest incomplete checkpoint, and resumes once. `retry` is accepted only for `failed`, `cancelled`, or `needs-review`, uses a dedicated `assertResumeTransition` rather than an ordinary forward transition, increments the failed-stage attempt count, and never deletes completed artifacts. `executor.cancel` aborts the worker's shared `AbortController`, waits for its stopped acknowledgement, and only then returns; every tool/store write checks the signal immediately before its atomic rename. If acknowledgement exceeds five seconds, terminate the worker before marking the job cancelled. `shutdown` applies the same fence to all active workers.

`message` is accepted only for `ready` or `needs-review` jobs with no active worker and dispatches `{ type: "revision", request }` to the same restricted worker entry; `undo` is an Artifact-store pointer operation with expected-revision conflict checking. Both emit revision events after success, and a failed candidate emits an error event without changing the snapshot revision.

- [ ] **Step 4: Implement route validation and manifest-only artifact delivery**

```js
// server/deck-agent/routes.mjs
router.post("/jobs", asyncRoute(async (req, res) => res.status(202).json({ ok: true, job: await manager.create(req.body) })));
router.get("/jobs/:jobId", asyncRoute(async (req, res) => res.json({ ok: true, job: await manager.get(req.params.jobId) })));
router.get("/jobs/:jobId/events", asyncRoute(async (req, res) => events.pipeNdjson(req, res, { jobId: req.params.jobId, after: parseSequence(req.query.after) })));
router.get("/jobs/:jobId/artifacts/:artifactId", asyncRoute(async (req, res) => sendManifestArtifact(req, res, { store, revisions })));
router.post("/jobs/:jobId/cancel", accepted((req) => manager.cancel(req.params.jobId)));
router.post("/jobs/:jobId/retry", accepted((req) => manager.retry(req.params.jobId)));
router.post("/jobs/:jobId/messages", accepted((req) => manager.message(req.params.jobId, editRequestSchema.parse(req.body))));
router.post("/jobs/:jobId/undo", accepted((req) => manager.undo(req.params.jobId, undoRequestSchema.parse(req.body))));
```

Return `400` for invalid input/path/sequence, `404` for unknown jobs/artifacts, `409` for invalid states or revision conflicts, `413` for quotas, and `202` for accepted mutations. Add `Cache-Control: no-store` to job/events/preview responses, `X-Content-Type-Options: nosniff` to every artifact, a strict CSP to HTML preview, and `Content-Disposition: attachment` only for `?download=1`.

- [ ] **Step 5: Mount routes before Vite/static fallback and run API tests**

Mount `app.use("/api/html-deck", deckJobRouter)` after JSON middleware and before the production SPA catch-all/Vite middleware. Keep `/api/ai/test`, `/api/ai/generate-deck*`, `/api/ai/generate-images`, and `/api/ai/decompose-images` for PPTX modes.

Call `await jobManager.start()` before accepting traffic. On SIGINT/SIGTERM, stop accepting new requests, call `await jobManager.shutdown()`, close the HTTP server, and then exit; restart tests must use this same lifecycle rather than importing a listening `server/index.mjs` into the test process.

Run:

```bash
npx vitest run tests/integration/deck-agent/jobs-api.test.mjs tests/integration/deck-agent/recovery-cancel-events.test.mjs
node --check server/index.mjs
```

Expected: API/recovery tests pass; the server syntax check exits `0`; event streams release subscriptions on disconnect.

- [ ] **Step 6: Commit**

```bash
git add server/deck-agent/job-manager.mjs server/deck-agent/worker-entry.mjs server/deck-agent/routes.mjs server/index.mjs tests/integration/deck-agent/jobs-api.test.mjs tests/integration/deck-agent/recovery-cancel-events.test.mjs
git commit -m "feat: expose recoverable HTML deck jobs"
```

### Task 11: Build the typed frontend job client, reducer, URL restoration, and reconnect hook

**Files:**
- Create: `src/deck-agent-ui/types.ts`
- Create: `src/deck-agent-ui/api.ts`
- Create: `src/deck-agent-ui/jobReducer.ts`
- Create: `src/deck-agent-ui/jobLocation.ts`
- Create: `src/deck-agent-ui/useDeckAgentJob.ts`
- Create: `tests/unit/deck-agent-ui/api.test.ts`
- Create: `tests/unit/deck-agent-ui/jobReducer.test.ts`
- Create: `tests/unit/deck-agent-ui/useDeckAgentJob.test.tsx`

**Interfaces:**
- Consumes: Task 10 route/event JSON.
- Produces: `DeckJobStatus`, `DeckJobEvent`, `DeckJobSnapshot`, `DeckArtifactSummary`, and `DeckEditRequest` Zod schemas/types.
- API functions: `createDeckJob`, `getDeckJob`, `streamDeckJobEvents`, `cancelDeckJob`, `retryDeckJob`, `sendDeckMessage`, `undoDeckRevision`, `fetchArtifact`, and `artifactUrl`.
- Hook result: `{ state, create, cancel, retry, sendMessage, undo, selectArtifact, closeArtifact, reconnect }`.

- [ ] **Step 1: Write failing split-chunk, sequence, reducer, StrictMode, and URL tests**

```ts
// tests/unit/deck-agent-ui/api.test.ts
import { describe, expect, it } from "vitest";
import { decodeDeckEventStream } from "../../../src/deck-agent-ui/api";

it("decodes split NDJSON chunks and ignores heartbeat records", async () => {
  const chunks = ['{"seq":1,"jobId":"job-00000000-0000-4000-8000-000000000001","stage":"outline",', '"type":"stage","status":"running","title":"大纲","createdAt":"2026-07-22T00:00:00.000Z"}\n{"type":"heartbeat"}\n'];
  expect(await collect(decodeDeckEventStream(streamFrom(chunks)))).toEqual([expect.objectContaining({ seq: 1, title: "大纲" })]);
});

it("rejects malformed sequenced records instead of silently advancing", async () => {
  await expect(collect(decodeDeckEventStream(streamFrom(['{"seq":2,"type":"stage"}\n'])))).rejects.toThrow(/invalid deck event/i);
});
```

```ts
// tests/unit/deck-agent-ui/jobReducer.test.ts
it("rejects wrong-job and duplicate events and keeps timeline sequence order", () => {
  const afterFirst = reduceDeckJob(initialState(jobId), { type: "event", event: event({ seq: 2 }) });
  const afterDuplicate = reduceDeckJob(afterFirst, { type: "event", event: event({ seq: 2, title: "duplicate" }) });
  const afterWrongJob = reduceDeckJob(afterDuplicate, { type: "event", event: event({ seq: 3, jobId: otherJobId }) });
  expect(afterWrongJob.events.map((item) => item.seq)).toEqual([2]);
  expect(afterWrongJob.lastSeq).toBe(2);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent-ui/api.test.ts tests/unit/deck-agent-ui/jobReducer.test.ts tests/unit/deck-agent-ui/useDeckAgentJob.test.tsx`

Expected: FAIL because frontend job modules do not exist.

- [ ] **Step 3: Define matching strict client contracts and an abortable NDJSON decoder**

```ts
// src/deck-agent-ui/types.ts
export const deckJobStatusSchema = z.enum(["queued", "outline", "design", "calibrating", "building", "generating-assets", "verifying", "repairing", "ready", "needs-review", "failed", "cancelled"]);
export const deckJobEventSchema = z.object({ seq: z.number().int().positive(), jobId: z.string(), stage: deckJobStatusSchema, type: z.enum(["message", "stage", "progress", "artifact", "error", "revision", "job"]), status: z.enum(["queued", "running", "done", "failed", "cancelled"]), title: z.string(), message: z.string().optional(), artifactId: z.string().optional(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict().optional(), progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(), revision: z.number().int().nonnegative().optional(), createdAt: z.string() }).strict();
export const deckArtifactSchema = z.object({ id: z.string(), filename: z.string(), kind: z.enum(["markdown", "html", "image", "json"]), stage: deckJobStatusSchema, revision: z.number().int().nonnegative().optional(), previewable: z.boolean(), downloadable: z.boolean() }).strict();
export const deckJobSnapshotSchema = z.object({ id: z.string(), title: z.string(), status: deckJobStatusSchema, failedStage: deckJobStatusSchema.optional(), error: z.string().optional(), lastSeq: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(), artifacts: z.array(deckArtifactSchema), actions: z.object({ canCancel: z.boolean(), canRetry: z.boolean(), canMessage: z.boolean(), canUndo: z.boolean(), canDownload: z.boolean() }).strict(), createdAt: z.string(), updatedAt: z.string() }).strict();
export type DeckJobEvent = z.infer<typeof deckJobEventSchema>;
export type DeckJobSnapshot = z.infer<typeof deckJobSnapshotSchema>;
export type DeckArtifactSummary = z.infer<typeof deckArtifactSchema>;
export type DeckEditRequest = { instruction: string; currentSlideId?: string; slideIds?: string[]; expectedRevision: number };
```

```ts
// src/deck-agent-ui/api.ts
export async function* decodeDeckEventStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const value = JSON.parse(line) as unknown;
        if (isHeartbeat(value)) continue;
        const parsed = deckJobEventSchema.safeParse(value);
        if (!parsed.success) throw new Error(`Invalid deck event: ${parsed.error.message}`);
        yield parsed.data;
      }
      if (done) break;
    }
    if (buffer.trim()) throw new Error("Deck event stream ended with an incomplete record");
  } finally { reader.releaseLock(); }
}
```

`streamDeckJobEvents(jobId, after, signal, onEvent)` performs `GET` with `Accept: application/x-ndjson`, passes `signal`, and does not wait for a legacy `result` event. Every JSON response is parsed through its matching Zod schema before reaching React state.

- [ ] **Step 4: Implement sequence-safe reducer, URL helpers, and reconnect lifecycle**

`jobReducer` accepts an event only when `event.jobId === state.job.id` and `event.seq > state.lastSeq`, inserts by sequence, derives stage groups, artifacts, progress, current revision, and allowed commands, and never stores Markdown/HTML bodies. `jobLocation` reads/writes only a validated `?job=job-<uuid>` parameter using `history.replaceState`.

```ts
// useDeckAgentJob.ts reconnect core
const jobId = state.jobId;
const terminal = isTerminal(state.status);
useEffect(() => {
  if (!jobId || terminal) return;
  const controller = new AbortController();
  let stopped = false;
  void (async () => {
    let delayMs = 250;
    while (!stopped && !controller.signal.aborted) {
      try {
        let reachedTerminal = false;
        await streamDeckJobEvents(jobId, lastSeqRef.current, controller.signal, (event) => { lastSeqRef.current = Math.max(lastSeqRef.current, event.seq); reachedTerminal ||= isTerminal(event.stage); dispatch({ type: "event", event }); });
        if (reachedTerminal) break;
        await abortableDelay(delayMs, controller.signal);
        delayMs = 250;
      } catch (error) {
        if (controller.signal.aborted) break;
        dispatch({ type: "transport-error", error: toMessage(error) });
        await abortableDelay(delayMs, controller.signal);
        delayMs = Math.min(delayMs * 2, 3_000);
      }
    }
  })();
  return () => { stopped = true; controller.abort(); };
}, [jobId, terminal]);
```

React StrictMode may mount the effect twice; abort cleanup plus server replay/deduplication must make this harmless. Calling `cancel` first sends the cancel request with its own signal, then aborts the event transport after the server acknowledges.

- [ ] **Step 5: Run frontend data tests**

Run: `npx vitest run tests/unit/deck-agent-ui/api.test.ts tests/unit/deck-agent-ui/jobReducer.test.ts tests/unit/deck-agent-ui/useDeckAgentJob.test.tsx`

Expected: tests pass for split chunks, malformed events, deduplication, wrong-job rejection, reconnect after last accepted `seq`, terminal stop, StrictMode cleanup, command failures, and `?job=` restoration.

- [ ] **Step 6: Commit**

```bash
git add src/deck-agent-ui/types.ts src/deck-agent-ui/api.ts src/deck-agent-ui/jobReducer.ts src/deck-agent-ui/jobLocation.ts src/deck-agent-ui/useDeckAgentJob.ts tests/unit/deck-agent-ui
git commit -m "feat: add resilient deck agent client state"
```

### Task 12: Build the Manus-style Agent timeline, Markdown preview, and sandboxed deck preview

**Files:**
- Create: `src/deck-agent-ui/AgentRunView.tsx`
- Create: `src/deck-agent-ui/AgentMessage.tsx`
- Create: `src/deck-agent-ui/AgentStep.tsx`
- Create: `src/deck-agent-ui/ArtifactPreview.tsx`
- Create: `src/deck-agent-ui/DeckPreview.tsx`
- Create: `src/deck-agent-ui/deck-agent.css`
- Create: `tests/unit/deck-agent-ui/AgentRunView.test.tsx`
- Create: `tests/unit/deck-agent-ui/ArtifactPreview.test.tsx`
- Create: `tests/unit/deck-agent-ui/DeckPreview.test.tsx`

**Interfaces:**
- Consumes: Task 11 hook state/actions and artifact URLs.
- Produces: `<AgentRunView jobId initialRequest onExit />`, accessible collapsible steps, read-only Markdown artifact preview, final deck iframe, edit composer, cancel/retry/undo/download commands, and current-slide context.

- [ ] **Step 1: Write failing interaction and hostile-message tests**

```tsx
// tests/unit/deck-agent-ui/AgentRunView.test.tsx
it("expands a step title and opens Markdown while later events continue", async () => {
  render(<AgentRunView jobId={jobId} initialRequest={request} onExit={vi.fn()} />);
  const heading = await screen.findByRole("button", { name: "整理幻灯片内容大纲并写入 Markdown" });
  expect(heading).toHaveAttribute("aria-expanded", "false");
  await user.click(heading);
  expect(heading).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "slides-content.md" }));
  expect(await screen.findByRole("heading", { name: "智能制造转型方案" })).toBeVisible();
  emitEvent(event({ seq: 8, stage: "building", type: "progress", title: "生成 HTML 页面", progress: { completed: 3, total: 8 } }));
  expect(await screen.findByText("3 / 8")).toBeVisible();
});
```

```tsx
// tests/unit/deck-agent-ui/DeckPreview.test.tsx
it("accepts only the exact opaque-origin channel envelope", () => {
  render(<DeckPreview job={job} artifact={previewArtifact} onSlideChange={onSlideChange} />);
  const frame = screen.getByTitle("HTML 幻灯片预览") as HTMLIFrameElement;
  dispatchMessage({ source: frame.contentWindow, origin: "null", data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-03" } });
  expect(onSlideChange).toHaveBeenCalledWith("slide-03");
  dispatchMessage({ source: frame.contentWindow, origin: "https://evil.invalid", data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-04" } });
  dispatchMessage({ source: window, origin: "null", data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-05" } });
  expect(onSlideChange).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npx vitest run tests/unit/deck-agent-ui/AgentRunView.test.tsx tests/unit/deck-agent-ui/ArtifactPreview.test.tsx tests/unit/deck-agent-ui/DeckPreview.test.tsx`

Expected: FAIL because UI components do not exist.

- [ ] **Step 3: Implement accessible Agent messages, steps, and artifact rows**

`AgentStep` uses a real `<button>` heading with `aria-expanded` and `aria-controls`; details remain local React state and never call the server. Completed artifacts are separate buttons with file icons. Running stages expose text progress through `aria-live="polite"`; errors show retry only when the snapshot permits it.

`AgentMessage` renders the submitted user request followed by durable server message events. The first assistant event must naturally restate topic, audience, requested page count, and the current action; it must not expose provider names, prompt text, schemas, tool calls, or API details. The outline artifact appears only inside the outline step; HTML page summaries/thumbnails appear only in building or later steps.

```tsx
export function AgentStep({ step, onArtifact, onRetry }: AgentStepProps) {
  const [expanded, setExpanded] = useState(step.status === "running" || step.status === "failed");
  const panelId = `deck-agent-step-${step.key}`;
  return <section className={`deck-agent-step is-${step.status}`}>
    <button type="button" className="deck-agent-step__toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((value) => !value)}>
      <StepStatusIcon status={step.status} /><span>{step.title}</span><ChevronDown aria-hidden="true" />
    </button>
    {expanded && <div id={panelId} className="deck-agent-step__body">
      {step.message && <p>{step.message}</p>}
      {step.progress && <span aria-live="polite">{step.progress.completed} / {step.progress.total}</span>}
      {step.artifacts.map((artifact) => <button type="button" className="deck-agent-artifact" key={artifact.id} onClick={() => onArtifact(artifact)}><FileText aria-hidden="true" /><span>{artifact.filename}</span></button>)}
      {step.status === "failed" && step.canRetry && <button type="button" onClick={onRetry}><RotateCcw aria-hidden="true" />重试</button>}
    </div>}
  </section>;
}
```

- [ ] **Step 4: Implement a read-only Markdown preview with focus/scroll restoration**

`ArtifactPreview` fetches the selected artifact once per revision, validates content type and byte limit, and renders with `react-markdown` + `remark-gfm` without `rehype-raw`. It never renders a textarea, input, `contentEditable`, or raw HTML. Opening stores the previously focused element and timeline scroll position; closing restores both after the timeline pane is visible.

```tsx
<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>
  {markdown}
</ReactMarkdown>
```

- [ ] **Step 5: Implement strict iframe and edit command behavior**

`DeckPreview` generates a fresh 128-bit channel token with `crypto.getRandomValues`, appends it only in the URL fragment, and renders `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer">` without `allow-same-origin`, forms, popups, downloads, or navigation permissions. Its message listener applies the exact checks in the Task 12 test plus membership in the current manifest slide IDs. The edit composer sends `{ instruction, currentSlideId, expectedRevision }`; explicit page selections add `slideIds`.

Because the sandbox target has an opaque origin, parent-to-frame commands must use `postMessage(envelope, "*")`; safety comes from the child validating `event.source === parent`, the exact embedded parent origin, message type, token, job, revision, and slide. Frame-to-parent messages use the exact embedded parent origin rather than `"*"`, and the parent validates `event.origin === "null"` plus the same envelope fields.

A `409 new-job-required` edit response is rendered as a non-destructive choice explaining that the request changes the whole narrative; it does not automatically create a new job or replay old local revisions. `needs-review` keeps preview/download available and presents retry, while `failed` shows only completed artifacts plus retry/cancel-safe navigation.

```ts
function createChannelToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
const channelToken = useMemo(createChannelToken, [job.id, job.revision]);
const previewSrc = `${artifactUrl(job.id, "deck-preview", job.revision)}#channel=${channelToken}`;
```

- [ ] **Step 6: Add responsive, work-focused layout styling**

Use `.deck-agent-*` selectors in the new CSS file. Desktop uses `grid-template-columns: minmax(320px, 0.42fr) minmax(0, 0.58fr)`; mobile uses one column and turns the preview into a full-width pane below the timeline. Keep icon controls at stable 36 x 36 or 40 x 40 dimensions, cards at radius 8px or less, body text at fixed rem sizes, and the iframe in an `aspect-ratio: 16 / 9` wrapper. Reuse existing neutral tokens with blue, green, red, and charcoal semantic accents; do not add gradient/orb decoration or nested cards.

- [ ] **Step 7: Run component tests and build**

Run:

```bash
npx vitest run tests/unit/deck-agent-ui/AgentRunView.test.tsx tests/unit/deck-agent-ui/ArtifactPreview.test.tsx tests/unit/deck-agent-ui/DeckPreview.test.tsx
npm run build
```

Expected: tests pass for collapse/expand, Markdown preview, continuing background events, focus/scroll restoration, command availability, strict sandbox attributes, hostile-message rejection, and responsive text containment; build exits `0`.

- [ ] **Step 8: Commit**

```bash
git add src/deck-agent-ui tests/unit/deck-agent-ui/AgentRunView.test.tsx tests/unit/deck-agent-ui/ArtifactPreview.test.tsx tests/unit/deck-agent-ui/DeckPreview.test.tsx
git commit -m "feat: add Manus-style deck agent workspace"
```

### Task 13: Cut HTML mode over to the Job workflow while retaining dormant rollback code

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/HomeScreen.tsx`
- Create: `tests/integration/deck-agent/app-cutover.test.tsx`

**Interfaces:**
- Consumes: existing `GenerationSource`, `toDeckSource`, `assetToApiImage`, and new Agent UI/client.
- Produces: HTML submission creates one server job, records `?job=`, and renders `AgentRunView`; PPTX presets continue using their existing state/pipelines.
- Detaches: the active frontend no longer imports or calls `generateAiHtmlDeck`, `patchAiHtmlDeck`, `HtmlDeckSpec` hydration/patching/export, object editor state/effects, or IndexedDB persistence.
- Retains temporarily: dormant `src/html-deck/**`, legacy client functions/routes/prompts, obsolete editor CSS, and `idb` remain in the repository until Task 14's pre-retirement browser/security gate passes.

- [ ] **Step 1: Write a failing cutover regression test**

```tsx
// tests/integration/deck-agent/app-cutover.test.tsx
it("submits HTML mode directly from parsed source blocks to one Deck Agent job", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url !== "/api/html-deck/jobs") throw new Error(`Unexpected request: ${url}`);
    const body = JSON.parse(String(init?.body));
    expect(body.source.sourceBlocks[0].source.blockId).toBe("block-001");
    expect(body.options.imageMaxRetries).toBeLessThanOrEqual(1);
    expect(body.source).not.toHaveProperty("deck");
    expect(body).not.toHaveProperty("draft");
    return new Response(JSON.stringify({ ok: true, job: queuedJob }), { status: 202, headers: { "Content-Type": "application/json" } });
  });
  render(<App />);
  await selectHtmlPresetAndSubmit(user, fixtureFile);
  expect(await screen.findByText("已创建 HTML 幻灯片任务")).toBeVisible();
  expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringMatching(/generate-html-deck|patch-html-deck/), expect.anything());
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/integration/deck-agent/app-cutover.test.tsx`

Expected: FAIL because `App.tsx` still calls the legacy HTML object pipeline.

- [ ] **Step 3: Replace only the HTML submission/render branch**

Keep attachment parsing at the existing `App.tsx` submission boundary. Convert uploads with `assetToApiImage`, call `toDeckSource`, preserve the user's `imageEnabled`, `imageCount`, `imageQuality`, and timeout settings, clamp the HTML image retry setting to the approved maximum of one, and create the job. Do not force image generation on.

```tsx
if (preset === "html-interactive") {
  setMode("html");
  const sourceImages = await Promise.all(source.assets.map(assetToApiImage));
  const job = await createDeckJob({
    source: toDeckSource(source, sourceImages),
    options: { imageEnabled: config.imageEnabled, imageCount: config.imageCount, imageQuality: config.imageQuality, imageTimeoutMs: config.imageTimeoutSeconds * 1_000, imageMaxRetries: Math.min(config.imageMaxRetries, 1) },
  });
  setActiveHtmlJobId(job.id);
  writeJobToLocation(job.id);
  return;
}
```

When `mode === "html"`, render only `<AgentRunView jobId={activeHtmlJobId} initialRequest={sourceSummary} onExit={returnHome} />` in the workspace body. On initial load, a valid `?job=` restores that view from `GET /api/html-deck/jobs/:jobId`. Leave local/API PPTX `deck`, steps, image generation, editors, and exporters unchanged.

- [ ] **Step 4: Detach legacy HTML state without deleting the rollback implementation**

Remove `runHtmlPipeline`, HTML in-memory checkpoints, IndexedDB effects, object-editor handlers, object export buttons, node-level patching, and all `src/html-deck/**`/legacy API imports from `App.tsx`. Do not delete the underlying files, routes, prompts, obsolete `.html-*` CSS, or `idb` dependency in this task; they remain dormant rollback code and are retired only in Task 14 after the new E2E/security/offline suite passes.

Update the Home option copy to: `生成 HTML/CSS 演示文稿，支持大纲预览、自动检查和自然语言修改`.

Run: `rg -n "generateAiHtmlDeck|patchAiHtmlDeck|HtmlDeckSpec|HtmlDeckWorkspace|htmlInitialSteps" src/App.tsx`

Expected: no matches in the active application entry point; matching definitions elsewhere are intentionally retained until Task 14.

- [ ] **Step 5: Run cutover and retained PPTX regressions**

Run:

```bash
npx vitest run tests/integration/deck-agent/app-cutover.test.tsx
npm run test:attachments
npm run test:provenance
npm run test:integrated-export
npm run test:image-geometry
npm run test:image-prompt
npm run test:visual
npm run build
```

Expected: HTML creates only a Job; source refs remain stable; every retained PPTX test exits `0`; the production `App` bundle has no reachable import of `src/html-deck` and sends no request to a legacy HTML endpoint. Dormant source files and server routes still exist for the Task 14 rollback window.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/HomeScreen.tsx tests/integration/deck-agent/app-cutover.test.tsx
git commit -m "refactor: cut HTML mode over to deck agent jobs"
```

### Task 14: Complete browser/security/visual QA, notices, and operator documentation

**Files:**
- Create: `tests/helpers/start-deck-agent-stack.mjs`
- Create: `tests/e2e/deck-agent-ui.spec.ts`
- Create: `tests/e2e/sandbox-security.spec.ts`
- Create: `tests/e2e/offline-export.spec.ts`
- Create: `tests/e2e/visual-qa.spec.ts`
- Rewrite: `scripts/test-html-deck.mjs`
- Modify: `src/app/workflow.ts`
- Modify: `src/lib/apiClient.ts`
- Modify: `src/styles.css`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `server/index.mjs`
- Modify: `scripts/test-source-provenance.mjs`
- Delete: `src/html-deck/HtmlDeckFrame.tsx`
- Delete: `src/html-deck/HtmlDeckWorkspace.tsx`
- Delete: `src/html-deck/document.ts`
- Delete: `src/html-deck/exportHtmlDeck.ts`
- Delete: `src/html-deck/exportHtmlDeckPptx.ts`
- Delete: `src/html-deck/fromNotebook.ts`
- Delete: `src/html-deck/patches.ts`
- Delete: `src/html-deck/persistence.ts`
- Delete: `src/html-deck/schema.ts`
- Delete: `src/html-deck/types.ts`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `README.md`
- Modify: `DESIGN.md`
- Rewrite: `docs/HTML_INTERACTIVE_MODE.md`
- Modify: `docs/COLLABORATOR_REPRODUCTION.md`
- Modify: `API_SETUP.md`

**Interfaces:**
- Consumes: the complete job workflow, three fixed material fixtures, mock model/image modes, and local Chromium.
- Produces: end-to-end acceptance evidence for Agent interaction, recovery, sandbox isolation, visual integrity, offline export, licensing, and operating instructions.
- Retires: the dormant object-model HTML implementation only after the new Job workflow passes the pre-retirement browser/security/offline gate in Step 5.

- [ ] **Step 1: Write failing end-to-end acceptance tests**

```ts
// tests/e2e/deck-agent-ui.spec.ts
test("outline artifact opens read-only while generation continues", async ({ page }) => {
  await createFixtureJob(page, "dense-report");
  const outlineStep = page.getByRole("button", { name: "整理幻灯片内容大纲并写入 Markdown" });
  await expect(outlineStep).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "slides-content.md" }).click();
  await expect(page.getByRole("heading", { name: "智能制造转型方案" })).toBeVisible();
  await expect(page.locator("textarea, [contenteditable=true]")).toHaveCount(0);
  await expect(page.getByText(/生成 HTML 页面/)).toBeVisible();
});

test("refresh resumes after the last event and does not duplicate timeline rows", async ({ page }) => {
  await createFixtureJob(page, "data-table");
  const before = await page.locator("[data-event-seq]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-event-seq")));
  await page.reload();
  await expect.poll(() => page.locator("[data-event-seq]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-event-seq")))).toEqual(expect.arrayContaining(before));
  expect(new Set(await page.locator("[data-event-seq]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-event-seq")))).size).toBe(await page.locator("[data-event-seq]").count());
});
```

```ts
// tests/e2e/sandbox-security.spec.ts
test("preview cannot read parent storage, navigate, submit, open popups, or use the network", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("deck-secret-sentinel", "must-not-leak"));
  await openPublishedPreview(page, "security-fixture");
  const frame = page.frameLocator('iframe[title="HTML 幻灯片预览"]');
  await expect(frame.locator("body")).not.toContainText("must-not-leak");
  expect(await page.locator('iframe[title="HTML 幻灯片预览"]').getAttribute("sandbox")).toBe("allow-scripts");
  expect(networkRequests.filter((url) => /^https?:/.test(url) && !url.startsWith(appOrigin))).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(page.url()).toContain("?job=");
});
```

- [ ] **Step 2: Run one end-to-end spec and verify it fails**

Run: `npx playwright test tests/e2e/deck-agent-ui.spec.ts --project=desktop-chromium`

Expected: FAIL until the test stack helper and final mock lifecycle modes are wired.

- [ ] **Step 3: Add deterministic test stack and browser assertions**

`start-deck-agent-stack.mjs` starts the mock gateway and app on dynamically selected loopback ports, exports environment-only provider settings to the child app, waits for `/api/health`, writes no credentials to stdout, and forwards SIGINT/SIGTERM to both children. Add mock scenarios for invalid outline twice, calibration fallback, one failed batch, image 524, delayed cancel, one visual repair, persistent `needs-review`, scoped edit failure, and undo.

Browser coverage must include:

- Collapsible `aria-expanded`, read-only Markdown, ongoing progress, close focus/scroll restoration, retry, cancel, refresh restore, natural-language target edit, failed revision rollback, undo, preview, and standalone download.
- Desktop 1440 x 900 and mobile 390 x 844 with no horizontal application overflow or overlapping controls.
- Internal 1920 x 1080 slide bounds, 16:9 aspect ratio, nonblank pixel occupancy, no slide overflow, broken images, duplicate IDs, font failures, chart failures, or console errors.
- Parent storage/cookie/top access failure; blocked external network, popups, forms, frames, and navigation; forged origin/source/token/job/revision/slide messages ignored.
- Offline standalone file opened in a context with all network aborted, keyboard navigation working, and no key/provider/prompt/job-path strings in its source.

- [ ] **Step 4: Rewrite the old HTML regression entry point as a suite wrapper**

Replace object-model assertions in `scripts/test-html-deck.mjs` with a small process wrapper that runs the Vitest deck-agent suites and the four Playwright specs, propagates the first nonzero exit code, and always terminates spawned test servers. Keep `npm run test:html-deck` as the collaborator-facing command.

```js
const commands = [
  ["npx", ["vitest", "run", "tests/unit/deck-agent", "tests/integration/deck-agent"]],
  ["npx", ["playwright", "test", "tests/e2e/deck-agent-ui.spec.ts", "tests/e2e/sandbox-security.spec.ts", "tests/e2e/offline-export.spec.ts", "tests/e2e/visual-qa.spec.ts"]],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

- [ ] **Step 5: Pass the new workflow's pre-retirement browser and security gate**

Run the complete new HTML entry point, Job API, sandbox, visual, and offline-export suite while the dormant legacy implementation is still available for rollback:

```bash
npm run test:html-deck
npm run build
```

Expected: every Vitest and Playwright check in the new Job workflow exits `0`; desktop/mobile previews are nonblank; sandbox and offline checks pass; the production build uses the Job entry point. If either command fails, stop this task and keep all legacy files/routes/dependencies intact.

- [ ] **Step 6: Retire the dormant object-model implementation only after Step 5 passes**

Delete `src/html-deck/**`; remove `htmlInitialSteps` from `src/app/workflow.ts`; remove `generateAiHtmlDeck`, `patchAiHtmlDeck`, and their obsolete type imports from `src/lib/apiClient.ts`; remove the four `/api/ai/generate-html-deck*` and `/api/ai/patch-html-deck*` routes plus their schemas/prompts from `server/index.mjs`; remove obsolete `.html-*` editor CSS; and update the provenance regression so it no longer imports the retired HTML object model. Then remove `idb` only after the source search confirms it has no remaining use.

Run:

```bash
git rm -r src/html-deck
npm uninstall idb
rg -n "from ['\"]idb|src/html-deck|HtmlDeckSpec|HtmlDeckWorkspace|generateAiHtmlDeck|patchAiHtmlDeck|notebookToHtmlDeck" src server scripts
npm run build
```

Expected: the search reports no runtime-code matches and the build exits `0`. Historical migration notes in `docs/` are checked separately in Step 9.

- [ ] **Step 7: Add licenses and update documentation to the implemented architecture**

`THIRD_PARTY_NOTICES.md` must identify Reveal.js 6.0.1, ECharts 6.1.0, and any copied/adapted code with repository URL, exact version/commit, copyright holder, license, and retained license text location. Record the six audited Skill repositories as design references; label entries with no copied code as references, not bundled dependencies. `assembleStandalone` embeds only the required copyright text, license identifiers, and applicable retained license text in a non-executable HTML comment; repository/source URLs remain in `THIRD_PARTY_NOTICES.md` and are not copied into standalone HTML, preserving the artifact's no-URL invariant.

Update all architecture diagrams and commands to show `attachmentParser -> slides-content.md -> design/calibration -> HTML/CSS/assets -> QA -> revisioned standalone HTML`. Document `DECK_JOB_ROOT`, workspace quotas, Chromium installation, cleanup/retention, `ready` versus `needs-review`, cancel/retry semantics, required production container CPU/RSS limits for the Chromium process tree, and the fact that API credentials remain environment-only. Remove claims about drag/resize, property panels, editable HTML objects, and HTML-to-PPTX export.

- [ ] **Step 8: Run the complete post-retirement verification matrix**

Run:

```bash
npm ci
npx playwright install chromium
npm run test
npm run test:attachments
npm run test:provenance
npm run test:integrated-export
npm run test:image-geometry
npm run test:image-prompt
npm run test:html-deck
npm run test:visual
npm run build
node --check server/index.mjs
git diff --check
```

Expected: every command exits `0`; no browser test emits a console/page error; generated screenshots/contact sheets are nonblank; `git diff --check` reports no whitespace errors.

- [ ] **Step 9: Run acceptance searches**

Run:

```bash
rg -n "generate-html-deck|patch-html-deck|HtmlDeckSpec|HtmlDeckWorkspace|notebookToHtmlDeck" src server scripts README.md DESIGN.md docs
rg -n "https?://|<script|on[a-z]+=" skills/generate-html-deck/assets/themes skills/generate-html-deck/assets/layouts
rg -n "https?://|api[_-]?key|system prompt|toolCalls|DECK_JOB_ROOT" artifacts/deck-jobs/*/revisions/*/dist/index.html
```

Expected: the first search finds only historical migration notes in the approved design/plan, not runtime code; the second finds no match; the third finds no match in standalone artifacts.

- [ ] **Step 10: Commit**

```bash
git add tests scripts/test-html-deck.mjs src/app/workflow.ts src/lib/apiClient.ts src/styles.css package.json package-lock.json server/index.mjs THIRD_PARTY_NOTICES.md README.md DESIGN.md docs/HTML_INTERACTIVE_MODE.md docs/COLLABORATOR_REPRODUCTION.md API_SETUP.md
git add -u src/html-deck
git commit -m "test: verify deck agent and retire legacy HTML path"
```
