import express from "express";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { deckJobSnapshotSchema } from "../../../server/deck-agent/contracts.mjs";
import { createEventStore } from "../../../server/deck-agent/event-store.mjs";
import {
  createJobManager,
  normalizeDeckJobInput,
} from "../../../server/deck-agent/job-manager.mjs";
import { createDeckJobRouter } from "../../../server/deck-agent/routes.mjs";

const validRequest = {
  source: {
    topic: "可信 AI 决策",
    audience: "管理层",
    slideCount: 7,
    textInput: "以可追溯证据支持决策。",
    tableInput: "",
    imageBrief: "",
    styleId: "consulting-grid",
    images: [],
    sourceBlocks: [{
      id: "block-001",
      type: "paragraph",
      text: "关键证据",
      source: {
        blockId: "block-001",
        attachmentId: "attachment-001",
        filename: "evidence.pdf",
        kind: "pdf",
        extraction: "native",
        page: 1,
      },
    }],
  },
  options: {
    imageEnabled: false,
    imageCount: 0,
    imageQuality: "medium",
    imageTimeoutMs: 600_000,
    imageMaxRetries: 1,
  },
};
const execFileAsync = promisify(execFile);

function deferredExecutor() {
  const runs = new Map();
  return {
    starts: [],
    start: vi.fn((jobId, options) => {
      const current = runs.get(jobId);
      if (current) return current.promise;
      let resolve;
      let reject;
      const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      runs.set(jobId, { promise, resolve, reject });
      this?.starts?.push?.({ jobId, options });
      return promise.finally(() => runs.delete(jobId));
    }),
    cancel: vi.fn(async (jobId) => {
      runs.get(jobId)?.resolve({ stopped: true });
      await runs.get(jobId)?.promise;
    }),
    shutdown: vi.fn(async () => {
      for (const run of runs.values()) run.resolve({ stopped: true });
      await Promise.allSettled([...runs.values()].map((run) => run.promise));
    }),
    settle(jobId, value) {
      runs.get(jobId)?.resolve(value);
    },
  };
}

function revisionAdapter(store) {
  return {
    resolveRevisionArtifact: vi.fn(async (jobId, artifactId) => {
      if (artifactId === "slides-content") {
        return { id: artifactId, relativePath: "slides-content.md" };
      }
      if (artifactId === "deck-preview") {
        const pointer = await store.readJson(jobId, "current-revision.json", { optional: true });
        if (!pointer?.revisionId) return undefined;
        return {
          id: artifactId,
          relativePath: `revisions/${pointer.revisionId}/dist/index.html`,
          preview: true,
        };
      }
      return undefined;
    }),
    undo: vi.fn(async (jobId, { expectedRevision }) => {
      const job = await store.readJob(jobId);
      if (job.revision !== expectedRevision) {
        const error = new Error("Revision changed before undo");
        error.status = 409;
        throw error;
      }
      const revision = expectedRevision - 1;
      await store.updateJob(jobId, { revision });
      return { number: revision };
    }),
  };
}

function createApp({ manager, events, store, revisions }) {
  const app = express();
  app.use(express.json({ limit: "42mb" }));
  app.use("/api/html-deck", createDeckJobRouter({
    manager,
    events,
    store,
    revisions,
    parentOrigin: "http://127.0.0.1:5173",
  }));
  return app;
}

describe("HTML deck jobs API", () => {
  let store;
  let events;
  let executor;
  let revisions;
  let manager;
  let app;

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-jobs-api-"));
    store = createArtifactStore({ rootDir });
    events = createEventStore({ store });
    executor = deferredExecutor();
    revisions = revisionAdapter(store);
    manager = createJobManager({ store, events, executor, revisions, normalizeInput: normalizeDeckJobInput });
    app = createApp({ manager, events, store, revisions });
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("creates a queued job without echoing provider configuration", async () => {
    const response = await request(app)
      .post("/api/html-deck/jobs")
      .send({
        ...validRequest,
        apiKey: "leak",
        provider: "attacker",
        model: "attacker-model",
        baseUrl: "https://attacker.invalid/v1",
        proxyUrl: "https://attacker.invalid/proxy",
      })
      .expect(202)
      .expect("Cache-Control", /no-store/);

    expect(response.body.ok).toBe(true);
    expect(deckJobSnapshotSchema.parse(response.body.job).status).toBe("queued");
    expect(JSON.stringify(response.body)).not.toMatch(/leak|attacker/);
    expect(await store.readJson(response.body.job.id, "source-blocks.json"))
      .toEqual(validRequest.source.sourceBlocks);
    expect(await store.readJson(response.body.job.id, "job-input.json"))
      .not.toHaveProperty("source.sourceBlocks");
    expect(executor.start).toHaveBeenCalledWith(response.body.job.id, { resumeFrom: "outline" });
  });

  it("normalizes the UI follow-total image count into a durable per-job budget", async () => {
    const response = await request(app)
      .post("/api/html-deck/jobs")
      .send({
        ...validRequest,
        options: { ...validRequest.options, imageEnabled: true, imageCount: 0 },
      })
      .expect(202);

    const input = await store.readJson(response.body.job.id, "job-input.json");
    expect(input.options.imageEnabled).toBe(true);
    expect(input.options.imageCount).toBe(validRequest.source.slideCount);
  });

  it.each([
    ["duplicate block IDs", {
      ...validRequest,
      source: {
        ...validRequest.source,
        sourceBlocks: [validRequest.source.sourceBlocks[0], validRequest.source.sourceBlocks[0]],
      },
    }],
    ["mismatched provenance IDs", {
      ...validRequest,
      source: {
        ...validRequest.source,
        sourceBlocks: [{
          ...validRequest.source.sourceBlocks[0],
          source: { ...validRequest.source.sourceBlocks[0].source, blockId: "block-999" },
        }],
      },
    }],
    ["unsupported source kinds", {
      ...validRequest,
      source: {
        ...validRequest.source,
        sourceBlocks: [{
          ...validRequest.source.sourceBlocks[0],
          source: { ...validRequest.source.sourceBlocks[0].source, kind: "html" },
        }],
      },
    }],
    ["unsupported extraction methods", {
      ...validRequest,
      source: {
        ...validRequest.source,
        sourceBlocks: [{
          ...validRequest.source.sourceBlocks[0],
          source: { ...validRequest.source.sourceBlocks[0].source, extraction: "remote" },
        }],
      },
    }],
  ])("rejects %s", async (_label, body) => {
    await request(app).post("/api/html-deck/jobs").send(body).expect(400);
    expect(executor.start).not.toHaveBeenCalled();
  });

  it("returns 413 for source payloads over the durable storage quota", async () => {
    const response = await request(app)
      .post("/api/html-deck/jobs")
      .send({
        ...validRequest,
        source: { ...validRequest.source, textInput: "x".repeat(2_000_001) },
      })
      .expect(413);

    expect(response.body).toEqual({ ok: false, error: expect.any(String) });
    expect(executor.start).not.toHaveBeenCalled();
  });

  it("gets a strict public snapshot and returns 404 for an unknown job", async () => {
    const created = await request(app).post("/api/html-deck/jobs").send(validRequest).expect(202);
    const response = await request(app)
      .get(`/api/html-deck/jobs/${created.body.job.id}`)
      .expect(200)
      .expect("Cache-Control", /no-store/);

    expect(deckJobSnapshotSchema.parse(response.body.job)).toEqual(response.body.job);
    expect(response.body.job.source).toEqual({
      topic: validRequest.source.topic,
      audience: validRequest.source.audience,
      slideCount: validRequest.source.slideCount,
    });
    expect(response.body.job).not.toHaveProperty("source.textInput");
    await request(app)
      .get("/api/html-deck/jobs/job-00000000-0000-4000-8000-000000000099")
      .expect(404);
  });

  it("serves artifacts only after manifest resolution and rejects path-like IDs", async () => {
    const created = await request(app).post("/api/html-deck/jobs").send(validRequest).expect(202);
    const jobId = created.body.job.id;
    await store.writeArtifact(jobId, "slides-content.md", "# Evidence\n");

    await request(app)
      .get(`/api/html-deck/jobs/${jobId}/artifacts/slides-content`)
      .expect(200)
      .expect("Content-Type", /text\/markdown/)
      .expect("X-Content-Type-Options", "nosniff")
      .expect("# Evidence\n");
    expect(revisions.resolveRevisionArtifact).toHaveBeenCalledWith(jobId, "slides-content");

    await request(app)
      .get(`/api/html-deck/jobs/${jobId}/artifacts/..%2f..%2f.env`)
      .expect(400);
    await request(app)
      .get(`/api/html-deck/jobs/${jobId}/artifacts/not-in-manifest`)
      .expect(404);
  });

  it("sets preview isolation headers and adds attachment disposition only for downloads", async () => {
    const created = await request(app).post("/api/html-deck/jobs").send(validRequest).expect(202);
    const jobId = created.body.job.id;
    const previewCsp = "default-src 'none'; script-src 'sha256-AbCdEf0123456789+/='; style-src-elem 'sha256-ZyXwVu9876543210+/='; img-src data:; object-src 'none'; base-uri 'none'";
    await store.writeArtifact(jobId, "slides-content.md", "# Evidence\n");
    const previewHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${previewCsp}"><title>Parent preview</title>`;
    const standaloneHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${previewCsp}"><title>Offline standalone</title>`;
    revisions.renderPreview = vi.fn(async () => previewHtml);
    await store.writeArtifact(jobId, "revisions/revision-000001/dist/index.html", standaloneHtml);
    await store.writeJson(jobId, "current-revision.json", { revision: 1, revisionId: "revision-000001", status: "ready" });
    await store.updateJob(jobId, { revision: 1 });

    const preview = await request(app)
      .get(`/api/html-deck/jobs/${jobId}/artifacts/deck-preview`)
      .expect(200)
      .expect("Content-Type", /text\/html/)
      .expect("Cache-Control", /no-store/)
      .expect("X-Content-Type-Options", "nosniff")
      .expect("Content-Security-Policy", previewCsp);
    expect(preview.headers).not.toHaveProperty("content-disposition");
    expect(preview.text).toContain("Parent preview");

    const download = await request(app)
      .get(`/api/html-deck/jobs/${jobId}/artifacts/deck-preview?download=1`)
      .expect(200)
      .expect("Content-Disposition", /attachment/);
    expect(download.text).toContain("Offline standalone");
    expect(download.text).not.toContain("Parent preview");
    expect(revisions.renderPreview).toHaveBeenCalledTimes(1);
  });

  it("uses a Chromium-compatible fallback CSP when preview HTML has no policy", async () => {
    const created = await request(app).post("/api/html-deck/jobs").send(validRequest).expect(202);
    const jobId = created.body.job.id;
    await store.writeJson(jobId, "current-revision.json", {
      revision: 1,
      revisionId: "revision-000001",
      status: "ready",
    });
    revisions.renderPreview = vi.fn(async () => "<!doctype html><title>Fallback preview</title>");

    const preview = await request(app)
      .get(`/api/html-deck/jobs/${jobId}/artifacts/deck-preview`)
      .expect(200)
      .expect("Content-Security-Policy", /default-src 'none'/);

    expect(preview.headers["content-security-policy"]).not.toContain("navigate-to");
  });

  it("validates messages and undo, emitting revision events after successful mutations", async () => {
    const created = await request(app).post("/api/html-deck/jobs").send(validRequest).expect(202);
    const jobId = created.body.job.id;
    executor.settle(jobId);
    await Promise.resolve();
    await store.updateJob(jobId, { status: "ready", revision: 2, checkpoints: [
      "outline", "design", "calibrating", "building", "generating-assets", "verifying",
    ] });

    executor.start.mockImplementationOnce(async (receivedJobId, options) => {
      expect(receivedJobId).toBe(jobId);
      expect(options).toEqual({
        type: "revision",
        request: {
          instruction: "把结论写得更直接",
          currentSlideId: "slide-02",
          slideIds: ["slide-02"],
          expectedRevision: 2,
        },
      });
      await store.updateJob(jobId, { revision: 3 });
    });

    const edited = await request(app)
      .post(`/api/html-deck/jobs/${jobId}/messages`)
      .send({
        instruction: "把结论写得更直接",
        currentSlideId: "slide-02",
        slideIds: ["slide-02"],
        expectedRevision: 2,
        provider: "must-be-rejected",
      })
      .expect(400);
    expect(edited.body.ok).toBe(false);

    const accepted = await request(app)
      .post(`/api/html-deck/jobs/${jobId}/messages`)
      .send({
        instruction: "把结论写得更直接",
        currentSlideId: "slide-02",
        slideIds: ["slide-02"],
        expectedRevision: 2,
      })
      .expect(202);
    expect(accepted.body.job.revision).toBe(3);

    const undone = await request(app)
      .post(`/api/html-deck/jobs/${jobId}/undo`)
      .send({ expectedRevision: 3 })
      .expect(202);
    expect(undone.body.job.revision).toBe(2);

    const revisionEvents = (await events.readAfter(jobId, 0)).filter((event) => event.type === "revision");
    expect(revisionEvents.map((event) => event.revision)).toEqual([3, 2]);
  });
});

it("imports the server without listening and exposes the explicit lifecycle", async () => {
  const serverEntry = path.resolve("server/index.mjs");
  const probe = [
    `const module = await import(${JSON.stringify(new URL(`file://${serverEntry}`).href)});`,
    "process.stdout.write(JSON.stringify({ hasApp: Boolean(module.app), hasStart: typeof module.startServer === 'function', listening: Boolean(module.httpServer?.listening) }));",
  ].join("\n");
  const port = String(45_000 + (process.pid % 10_000));
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    probe,
    "--",
    "--port",
    port,
  ], {
    cwd: path.dirname(path.dirname(path.dirname(serverEntry))),
    env: { ...process.env, NODE_ENV: "production" },
    timeout: 10_000,
  });
  expect(JSON.parse(stdout)).toEqual({ hasApp: true, hasStart: true, listening: false });
});

it("stops the server while a durable event stream remains open", async () => {
  const serverEntry = path.resolve("server/index.mjs");
  const artifactStoreEntry = path.resolve("server/deck-agent/artifact-store.mjs");
  const jobRoot = await mkdtemp(path.join(tmpdir(), "deck-server-stop-"));
  const port = String(46_000 + (process.pid % 10_000));
  const probe = [
    `const { createArtifactStore } = await import(${JSON.stringify(new URL(`file://${artifactStoreEntry}`).href)});`,
    "const jobId = 'job-00000000-0000-4000-8000-000000000015';",
    "const store = createArtifactStore({ rootDir: process.env.DECK_JOB_ROOT });",
    "await store.createJob({ jobId, title: 'stream', input: { source: {}, options: {} }, sourceBlocks: [] });",
    "await store.updateJob(jobId, { status: 'ready' });",
    `const module = await import(${JSON.stringify(new URL(`file://${serverEntry}`).href)});`,
    "const server = await module.startServer({ installSignalHandlers: false });",
    "const address = server.address();",
    "const response = await fetch(`http://127.0.0.1:${address.port}/api/html-deck/jobs/${jobId}/events?after=0`);",
    "const reader = response.body.getReader();",
    "const outcome = await Promise.race([module.stopServer().then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 750))]);",
    "if (outcome === 'timeout') await reader.cancel().catch(() => {});",
    "await module.stopServer();",
    "process.stdout.write(`\\nRESULT:${JSON.stringify({ outcome, cacheControl: response.headers.get('cache-control') })}`);",
  ].join("\n");
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    probe,
  ], {
    cwd: path.dirname(path.dirname(path.dirname(serverEntry))),
    env: { ...process.env, DECK_JOB_ROOT: jobRoot, NODE_ENV: "production", PORT: port },
    timeout: 10_000,
  });
  const result = JSON.parse(stdout.match(/RESULT:(\{.*\})/)?.[1] || "null");
  expect(result).toEqual({ outcome: "stopped", cacheControl: expect.stringContaining("no-store") });
});
