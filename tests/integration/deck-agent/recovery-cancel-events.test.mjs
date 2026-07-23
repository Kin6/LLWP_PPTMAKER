import http from "node:http";
import { EventEmitter } from "node:events";
import express from "express";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createEventStore } from "../../../server/deck-agent/event-store.mjs";
import {
  createJobManager,
  normalizeDeckJobInput,
} from "../../../server/deck-agent/job-manager.mjs";
import { createDeckJobRouter } from "../../../server/deck-agent/routes.mjs";
import * as workerEntry from "../../../server/deck-agent/worker-entry.mjs";

const { createWorkerExecutor, runWorkerCommand } = workerEntry;

const validRequest = {
  source: {
    topic: "恢复测试",
    audience: "工程团队",
    slideCount: 7,
    textInput: "可靠恢复",
    tableInput: "",
    imageBrief: "",
    styleId: "blank",
    images: [],
    sourceBlocks: [],
  },
  options: {
    imageEnabled: false,
    imageCount: 0,
    imageQuality: "medium",
    imageTimeoutMs: 600_000,
    imageMaxRetries: 1,
  },
};

function cancellableExecutor(store) {
  const runs = new Map();
  const executor = {
    start: vi.fn((jobId, options) => {
      const controller = new AbortController();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const promise = (async () => {
        await gate;
        await store.writeArtifact(jobId, "design-brief.md", "late write", {
          signal: controller.signal,
        });
      })();
      runs.set(jobId, { controller, release, promise });
      promise.catch(() => {}).finally(() => runs.delete(jobId));
      return promise;
    }),
    cancel: vi.fn(async (jobId) => {
      const run = runs.get(jobId);
      if (!run) return;
      run.controller.abort(new Error("cancelled"));
      run.release();
      await Promise.allSettled([run.promise]);
    }),
    shutdown: vi.fn(async () => {
      await Promise.all([...runs.keys()].map((jobId) => executor.cancel(jobId)));
    }),
    async settled(jobId) {
      const run = runs.get(jobId);
      if (run) await Promise.allSettled([run.promise]);
    },
  };
  return executor;
}

function recordingExecutor() {
  const pending = new Map();
  return {
    start: vi.fn((jobId) => {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      pending.set(jobId, { promise, resolve });
      return promise.finally(() => pending.delete(jobId));
    }),
    cancel: vi.fn(async (jobId) => {
      pending.get(jobId)?.resolve();
      await pending.get(jobId)?.promise;
    }),
    shutdown: vi.fn(async () => {
      for (const item of pending.values()) item.resolve();
      await Promise.allSettled([...pending.values()].map((item) => item.promise));
    }),
  };
}

function createApp({ manager, events, store }) {
  const app = express();
  app.use(express.json({ limit: "42mb" }));
  app.use("/api/html-deck", createDeckJobRouter({
    manager,
    events,
    store,
    revisions: { resolveRevisionArtifact: async () => undefined },
    parentOrigin: "http://127.0.0.1:5173",
  }));
  return app;
}

async function openEventStream(app, jobId, after) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/html-deck/jobs/${jobId}/events?after=${after}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return {
    cacheControl: response.headers.get("cache-control"),
    async take(count) {
      const values = [];
      while (values.length < count) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() || "";
        for (const line of lines) {
          if (line) values.push(JSON.parse(line));
          if (values.length === count) break;
        }
      }
      return values;
    },
    async close() {
      await reader.cancel().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function seedJob(store, {
  jobId = "job-00000000-0000-4000-8000-000000000010",
  status,
  failedStage,
  checkpoints = [],
  revision = 0,
} = {}) {
  await store.createJob({
    jobId,
    title: "恢复测试",
    input: validRequest,
    sourceBlocks: [],
  });
  await store.updateJob(jobId, {
    status,
    ...(failedStage ? { failedStage } : {}),
    checkpoints,
    revision,
  });
  return jobId;
}

describe("HTML deck recovery, cancellation, and event replay", () => {
  let store;
  let events;
  const managers = [];

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-recovery-"));
    store = createArtifactStore({ rootDir });
    events = createEventStore({ store });
  });

  afterEach(async () => {
    await Promise.all(managers.map((manager) => manager.shutdown()));
  });

  it("replays strictly after seq and fences artifact writes before cancellation returns", async () => {
    const executor = cancellableExecutor(store);
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);
    const app = createApp({ manager, events, store });
    const created = await request(app).post("/api/html-deck/jobs").send(validRequest).expect(202);
    const jobId = created.body.job.id;
    for (let index = 0; index < 3; index += 1) {
      await events.append(jobId, {
        stage: "queued",
        type: "progress",
        status: "running",
        title: `queued-${index}`,
        progress: { completed: index, total: 3 },
      });
    }

    const stream = await openEventStream(app, jobId, 3);
    const cacheControl = stream.cacheControl;
    expect((await stream.take(2)).map((event) => event.seq)).toEqual([4, 5]);

    await request(app).post(`/api/html-deck/jobs/${jobId}/cancel`).expect(202);
    const countAtCancel = (await store.listArtifacts(jobId)).length;
    await executor.settled(jobId);
    expect((await store.listArtifacts(jobId)).length).toBe(countAtCancel);
    expect((await store.readJob(jobId)).status).toBe("cancelled");
    await stream.close();
    expect(cacheControl).toContain("no-store");
  });

  it("rejects invalid replay sequences before opening a stream", async () => {
    const executor = recordingExecutor();
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);
    const app = createApp({ manager, events, store });
    const jobId = await seedJob(store, { status: "ready", checkpoints: [] });

    await request(app).get(`/api/html-deck/jobs/${jobId}/events?after=-1`).expect(400);
    await request(app).get(`/api/html-deck/jobs/${jobId}/events?after=1.5`).expect(400);
    await request(app).get(`/api/html-deck/jobs/${jobId}/events?after=not-a-number`).expect(400);
  });

  it("resumes a nonterminal job once from its earliest incomplete checkpoint after restart", async () => {
    const jobId = await seedJob(store, {
      status: "building",
      checkpoints: ["outline", "design", "calibrating"],
    });
    await store.writeJson(jobId, "working/manifest.json", {
      slides: ["slide-01", "slide-07", "slide-02", "slide-03"].map((slideId) => ({
        slideId,
        status: "done",
      })),
    });
    const persisted = {
      seq: 1,
      jobId,
      stage: "building",
      type: "stage",
      status: "running",
      title: "building",
      createdAt: "2026-07-22T00:00:00.000Z",
    };
    await store.writeArtifact(jobId, "events.ndjson", `${JSON.stringify(persisted)}\n{\"seq\":`);
    await store.updateJob(jobId, { lastSeq: 99 });

    const executor = recordingExecutor();
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);
    await manager.start();
    await manager.start();

    expect(executor.start).toHaveBeenCalledTimes(1);
    expect(executor.start).toHaveBeenCalledWith(jobId, { resumeFrom: "building" });
    expect((await store.readJob(jobId)).lastSeq).toBe(1);
    expect(await store.readArtifact(jobId, "events.ndjson")).toBe(`${JSON.stringify(persisted)}\n`);
  });

  it("reopens verification when a nonterminal job persisted every checkpoint before restart", async () => {
    const jobId = await seedJob(store, {
      status: "verifying",
      checkpoints: ["outline", "design", "calibrating", "building", "generating-assets", "verifying"],
    });
    const executor = recordingExecutor();
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);

    await manager.start();

    expect(executor.start).toHaveBeenCalledWith(jobId, { resumeFrom: "verifying" });
    expect((await store.readJob(jobId)).checkpoints).toEqual([
      "outline", "design", "calibrating", "building", "generating-assets",
    ]);
  });

  it("allows startup recovery to be retried after a transient event replay failure", async () => {
    const jobId = await seedJob(store, {
      status: "building",
      checkpoints: ["outline", "design", "calibrating"],
    });
    const executor = recordingExecutor();
    const readAfter = vi.fn()
      .mockRejectedValueOnce(new Error("temporary replay failure"))
      .mockImplementation((...args) => events.readAfter(...args));
    const manager = createJobManager({
      store,
      events: { ...events, readAfter },
      executor,
      normalizeInput: normalizeDeckJobInput,
    });
    managers.push(manager);

    await expect(manager.start()).rejects.toThrow(/temporary replay failure/i);
    await expect(manager.start()).resolves.toBeUndefined();

    expect(readAfter).toHaveBeenCalledTimes(2);
    expect(executor.start).toHaveBeenCalledOnce();
    expect(executor.start).toHaveBeenCalledWith(jobId, { resumeFrom: "building" });
  });

  it("retries only retryable terminal jobs without deleting completed artifacts", async () => {
    const jobId = await seedJob(store, {
      status: "failed",
      failedStage: "building",
      checkpoints: ["outline", "design", "calibrating"],
    });
    await store.writeArtifact(jobId, "slides-content.md", "# durable outline\n");
    const executor = recordingExecutor();
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);
    const app = createApp({ manager, events, store });

    const response = await request(app)
      .post(`/api/html-deck/jobs/${jobId}/retry`)
      .expect(202);

    expect(response.body.job.status).toBe("building");
    expect(executor.start).toHaveBeenCalledWith(jobId, { resumeFrom: "building" });
    expect((await store.readJob(jobId)).attempts).toEqual({ building: 1 });
    expect(await store.readArtifact(jobId, "slides-content.md")).toBe("# durable outline\n");

    await store.updateJob(jobId, { status: "ready" });
    await request(app).post(`/api/html-deck/jobs/${jobId}/retry`).expect(409);
  });

  it("retries needs-review by reopening the verifying checkpoint", async () => {
    const jobId = await seedJob(store, {
      status: "needs-review",
      failedStage: "building",
      revision: 1,
      checkpoints: ["outline", "design", "calibrating", "building", "generating-assets", "verifying"],
    });
    const executor = recordingExecutor();
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);
    const app = createApp({ manager, events, store });

    const response = await request(app)
      .post(`/api/html-deck/jobs/${jobId}/retry`)
      .expect(202);

    expect(response.body.job.status).toBe("verifying");
    expect(executor.start).toHaveBeenCalledWith(jobId, { resumeFrom: "verifying" });
    expect((await store.readJob(jobId)).attempts).toEqual({ verifying: 1 });
    expect((await store.readJob(jobId)).checkpoints).toEqual([
      "outline", "design", "calibrating", "building", "generating-assets",
    ]);
  });

  it("clears stale failure state after a resumed worker reaches a successful terminal status", async () => {
    const jobId = await seedJob(store, {
      status: "needs-review",
      failedStage: "building",
      revision: 1,
      checkpoints: ["outline", "design", "calibrating", "building", "generating-assets", "verifying"],
    });
    await store.updateJob(jobId, { error: "old failure" });
    const executor = {
      start: vi.fn(async () => {
        await store.updateJob(jobId, { status: "needs-review" });
        return { status: "needs-review" };
      }),
      cancel: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);

    await manager.retry(jobId);
    await vi.waitFor(async () => {
      const completed = await store.readJob(jobId);
      expect(completed.failedStage).toBeUndefined();
      expect(completed.error).toBeUndefined();
    });
  });

  it("serializes concurrent retries before either can append a duplicate queue event", async () => {
    const jobId = await seedJob(store, {
      status: "failed",
      failedStage: "building",
      checkpoints: ["outline", "design", "calibrating"],
    });
    const executor = recordingExecutor();
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);

    const results = await Promise.allSettled([manager.retry(jobId), manager.retry(jobId)]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(executor.start).toHaveBeenCalledTimes(1);
    const retryEvents = (await events.readAfter(jobId, 0))
      .filter((event) => event.title === "任务已重新排队");
    expect(retryEvents).toHaveLength(1);
  });

  it("serializes concurrent cancellation before invoking the worker fence", async () => {
    const jobId = await seedJob(store, { status: "building" });
    let releaseCancel;
    const gate = new Promise((resolve) => { releaseCancel = resolve; });
    const executor = {
      start: vi.fn(),
      cancel: vi.fn(() => gate),
      shutdown: vi.fn(async () => {}),
    };
    const manager = createJobManager({ store, events, executor, normalizeInput: normalizeDeckJobInput });
    managers.push(manager);

    const first = manager.cancel(jobId);
    await vi.waitFor(() => expect(executor.cancel).toHaveBeenCalledTimes(1));
    const second = manager.cancel(jobId);
    const settled = Promise.allSettled([first, second]);
    await new Promise((resolve) => setImmediate(resolve));
    releaseCancel();
    const results = await settled;

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(executor.cancel).toHaveBeenCalledTimes(1);
    const cancelledEvents = (await events.readAfter(jobId, 0))
      .filter((event) => event.stage === "cancelled" && event.type === "job");
    expect(cancelledEvents).toHaveLength(1);
  });
});

describe("HTML deck worker executor", () => {
  it("uses bounded worker resources and sends no configuration through workerData", async () => {
    const instances = [];
    class FakeWorker extends EventEmitter {
      constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        this.messages = [];
        instances.push(this);
      }

      postMessage(message) {
        this.messages.push(message);
        if (message.type === "run") {
          queueMicrotask(() => this.emit("message", {
            type: "stopped",
            jobId: message.jobId,
            result: { status: "ready" },
          }));
        }
      }

      async terminate() {
        this.emit("exit", 1);
        return 1;
      }
    }

    const executor = createWorkerExecutor({
      WorkerClass: FakeWorker,
      workerUrl: new URL("file:///worker-entry.mjs"),
    });
    const jobId = "job-00000000-0000-4000-8000-000000000011";
    await expect(executor.start(jobId, { resumeFrom: "building" }))
      .resolves.toEqual({ status: "ready" });

    expect(instances).toHaveLength(1);
    expect(instances[0].options).toEqual({
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8,
      },
    });
    expect(instances[0].options).not.toHaveProperty("workerData");
    expect(instances[0].messages).toEqual([{
      type: "run",
      jobId,
      resumeFrom: "building",
    }]);
  });

  it("filters incomplete model progress payloads and accepts normalized milestones", async () => {
    class FakeWorker extends EventEmitter {
      postMessage(message) {
        if (message.type !== "run") return;
        queueMicrotask(() => {
          this.emit("message", {
            type: "event",
            jobId: message.jobId,
            requestId: "raw-progress",
            event: { type: "progress", progress: { type: "delta", totalChars: 12 } },
          });
          this.emit("message", {
            type: "event",
            jobId: message.jobId,
            requestId: "model-milestone",
            event: {
              stage: "design",
              type: "progress",
              status: "running",
              title: "建立单一设计方向",
              message: "模型服务正在进行兼容重试",
              progress: { completed: 0, total: 1 },
            },
          });
          this.emit("message", {
            type: "event",
            jobId: message.jobId,
            requestId: "valid-stage",
            event: {
              stage: "building",
              type: "stage",
              status: "running",
              title: "生成幻灯片页面",
              progress: { completed: 0, total: 1 },
            },
          });
          this.emit("message", {
            type: "stopped",
            jobId: message.jobId,
            result: { status: "ready" },
          });
        });
      }

      async terminate() { return 0; }
    }
    const onEvent = vi.fn(async () => {});
    const executor = createWorkerExecutor({ WorkerClass: FakeWorker, onEvent });
    const jobId = "job-00000000-0000-4000-8000-000000000012";

    await executor.start(jobId, { resumeFrom: "building" });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith(jobId, expect.objectContaining({
      stage: "design",
      type: "progress",
      message: "模型服务正在进行兼容重试",
      progress: { completed: 0, total: 1 },
    }));
    expect(onEvent).toHaveBeenCalledWith(jobId, expect.objectContaining({
      stage: "building",
      type: "stage",
      status: "running",
    }));
  });

  it("drains accepted event writes and ignores late events before cancellation returns", async () => {
    let releaseEvent;
    const eventGate = new Promise((resolve) => { releaseEvent = resolve; });
    class FakeWorker extends EventEmitter {
      postMessage(message) {
        if (message.type === "run") {
          this.jobId = message.jobId;
          queueMicrotask(() => this.emit("message", {
            type: "event",
            jobId: message.jobId,
            requestId: "accepted-before-cancel",
            event: {
              stage: "building",
              type: "stage",
              status: "running",
              title: "生成幻灯片页面",
              progress: { completed: 0, total: 1 },
            },
          }));
        }
        if (message.type === "cancel") {
          queueMicrotask(() => {
            this.emit("message", {
              type: "event",
              jobId: message.jobId,
              requestId: "late-after-cancel",
              event: {
                stage: "building",
                type: "progress",
                status: "running",
                title: "late event",
                progress: { completed: 1, total: 1 },
              },
            });
            this.emit("message", {
              type: "stopped",
              jobId: message.jobId,
              result: { status: "cancelled" },
            });
          });
        }
      }

      async terminate() { return 0; }
    }
    const onEvent = vi.fn(() => eventGate);
    const executor = createWorkerExecutor({ WorkerClass: FakeWorker, onEvent });
    const jobId = "job-00000000-0000-4000-8000-000000000016";
    const running = executor.start(jobId, { resumeFrom: "building" });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    let cancelSettled = false;
    const cancelling = executor.cancel(jobId).then(() => { cancelSettled = true; });

    await new Promise((resolve) => setImmediate(resolve));
    const settledBeforeEventWrite = cancelSettled;
    releaseEvent();
    await cancelling;
    await running;

    expect(settledBeforeEventWrite).toBe(false);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("leaves queued-to-outline transition ownership with the orchestrator", async () => {
    const jobId = "job-00000000-0000-4000-8000-000000000013";
    const store = {
      readJob: vi.fn(async () => ({ id: jobId, status: "queued" })),
      updateJob: vi.fn(),
    };
    const emitted = [];
    const orchestrator = {
      run: vi.fn(async () => {
        expect(store.updateJob).not.toHaveBeenCalled();
        emitted.push({ stage: "outline", type: "stage", status: "running" });
        return { status: "ready" };
      }),
    };

    await runWorkerCommand({ type: "run", jobId, resumeFrom: "outline" }, {
      signal: new AbortController().signal,
      runtimeFactory: async () => ({ store, orchestrator }),
    });

    expect(store.updateJob).not.toHaveBeenCalled();
    expect(emitted).toEqual([{ stage: "outline", type: "stage", status: "running" }]);
  });

  it("emits one running event when a resumed job already has the requested status", async () => {
    const jobId = "job-00000000-0000-4000-8000-000000000014";
    const emitted = [];
    const store = { readJob: vi.fn(async () => ({ id: jobId, status: "building" })) };
    const orchestrator = { run: vi.fn(async () => ({ status: "ready" })) };

    await runWorkerCommand({ type: "run", jobId, resumeFrom: "building" }, {
      signal: new AbortController().signal,
      emit: async (event) => emitted.push(event),
      runtimeFactory: async () => ({ store, orchestrator }),
    });

    expect(emitted).toEqual([expect.objectContaining({
      stage: "building",
      type: "stage",
      status: "running",
      progress: { completed: 0, total: 1 },
    })]);
  });

  it("publishes uploaded and generated images into exact stored asset slots", async () => {
    expect(workerEntry.createAssetPublicationAdapter).toEqual(expect.any(Function));
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-asset-publication-"));
    const assetStore = createArtifactStore({ rootDir });
    const jobId = await seedJob(assetStore, { status: "building" });
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const [uploaded] = await assetStore.persistUploadedAssets(jobId, [{ name: "evidence.png", summary: "Evidence", dataUrl }]);
    const sourceBlocks = [{ id: "block-001", type: "image", assetId: uploaded.id }];
    await assetStore.writeJson(jobId, "source-blocks.json", sourceBlocks);
    await assetStore.writeJson(jobId, "working/manifest.json", {
      title: "Assets",
      assets: [],
      slides: [{
        slideId: "slide-01",
        title: "Evidence",
        speakerNotes: "Explain the evidence.",
        sourceRefs: ["block-001"],
        sourceBlockIds: ["block-001"],
        charts: [],
        assetSlots: [
          { slotId: "uploaded", purpose: "Uploaded evidence" },
          { slotId: "generated", purpose: "Generated evidence" },
        ],
        status: "done",
      }],
    });
    await assetStore.writeArtifact(
      jobId,
      "working/slides/slide-01.html",
      '<figure data-asset-slot="uploaded"></figure><figure data-asset-slot="generated"></figure>',
    );
    const adapter = workerEntry.createAssetPublicationAdapter({
      store: assetStore,
      jobId,
      uploads: [uploaded],
      sourceBlocks,
      signal: new AbortController().signal,
    });

    await adapter.publishAsset(uploaded, "slide-01", "uploaded");
    const generated = await adapter.publishGeneratedAsset(
      { dataUrl, revisedPrompt: "Generated evidence without text" },
      "slide-01",
      "generated",
    );

    expect(generated.assetId).toMatch(/^asset-[a-f0-9]+$/);
    expect(adapter.uploads.map((asset) => asset.id)).toEqual([uploaded.id, generated.assetId]);
    const html = await assetStore.readArtifact(jobId, "working/slides/slide-01.html");
    expect(html).toContain(`data-asset-slot="uploaded" data-asset-state="resolved"><img src="asset://${uploaded.id}"`);
    expect(html).toContain(`data-asset-slot="generated" data-asset-state="resolved"><img src="asset://${generated.assetId}"`);
  });
});
