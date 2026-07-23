import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createEventStore } from "../../../server/deck-agent/event-store.mjs";
import {
  createJobManager,
  normalizeDeckJobInput,
} from "../../../server/deck-agent/job-manager.mjs";

const PIPELINE = [
  "outline",
  "design",
  "calibrating",
  "building",
  "generating-assets",
  "verifying",
];

const validRequest = {
  source: {
    topic: "Lifecycle races",
    audience: "Engineering",
    slideCount: 7,
    textInput: "Durable lifecycle state",
    tableInput: "",
    imageBrief: "",
    styleId: "blank",
    images: [],
    sourceBlocks: [{
      id: "block-001",
      type: "paragraph",
      text: "Evidence",
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function settled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function seedJob(store, {
  jobId = "job-00000000-0000-4000-8000-000000000020",
  status = "needs-review",
  revision = 1,
  failedStage = "building",
  checkpoints = PIPELINE,
} = {}) {
  await store.createJob({
    jobId,
    title: "Lifecycle races",
    input: validRequest,
    sourceBlocks: validRequest.source.sourceBlocks,
  });
  await store.updateJob(jobId, {
    status,
    revision,
    ...(failedStage ? { failedStage } : {}),
    checkpoints,
  });
  return jobId;
}

describe("deck job lifecycle race fences", () => {
  let store;
  let events;

  beforeEach(async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-lifecycle-races-"));
    store = createArtifactStore({ rootDir });
    events = createEventStore({ store });
  });

  it("allows only retry to mutate when a message arrives during its paused job read", async () => {
    const jobId = await seedJob(store);
    const retryReadEntered = deferred();
    const releaseRetryRead = deferred();
    const releaseRevision = deferred();
    const revisionStarted = deferred();
    let pauseNextRead = true;
    const managerStore = {
      ...store,
      readJob: vi.fn(async (...args) => {
        const job = await store.readJob(...args);
        if (pauseNextRead) {
          pauseNextRead = false;
          retryReadEntered.resolve();
          await releaseRetryRead.promise;
        }
        return job;
      }),
    };
    const executor = {
      start: vi.fn(async (receivedJobId, options) => {
        if (options.type === "revision") {
          revisionStarted.resolve();
          await releaseRevision.promise;
          const current = await store.readJob(receivedJobId);
          await store.updateJob(receivedJobId, { revision: current.revision + 1 });
          return;
        }
        await store.updateJob(receivedJobId, {
          status: "needs-review",
          failedStage: undefined,
          error: undefined,
          checkpoints: PIPELINE,
        });
      }),
      cancel: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const manager = createJobManager({
      store: managerStore,
      events,
      executor,
      normalizeInput: normalizeDeckJobInput,
    });

    const retryPromise = manager.retry(jobId);
    await retryReadEntered.promise;
    const messagePromise = manager.message(jobId, {
      instruction: "Tighten the conclusion",
      expectedRevision: 1,
    });
    const messageResult = settled(messagePromise);
    await Promise.race([revisionStarted.promise, messageResult]);

    releaseRetryRead.resolve();
    const retryResult = await settled(retryPromise);
    releaseRevision.resolve();
    const finalMessageResult = await messageResult;

    expect(retryResult.status).toBe("fulfilled");
    expect(finalMessageResult).toMatchObject({
      status: "rejected",
      reason: { status: 409 },
    });
    expect(executor.start).toHaveBeenCalledTimes(1);
    expect(executor.start).toHaveBeenCalledWith(jobId, { resumeFrom: "verifying" });
    const retryEvents = (await events.readAfter(jobId, 0))
      .filter((event) => event.stage === "verifying" && event.type === "job" && event.status === "queued");
    const revisionStarts = executor.start.mock.calls
      .filter(([, options]) => options.type === "revision");
    expect(retryEvents.length + revisionStarts.length).toBe(1);
    await vi.waitFor(async () => {
      expect(await store.readJob(jobId)).toMatchObject({
        status: "needs-review",
        checkpoints: PIPELINE,
      });
    });
    await manager.shutdown();
  });

  it("allows only undo to mutate when a message arrives during the undo", async () => {
    const jobId = await seedJob(store, {
      status: "ready",
      revision: 3,
      failedStage: undefined,
    });
    const undoEntered = deferred();
    const releaseUndo = deferred();
    const revisionStarted = deferred();
    const revisions = {
      undo: vi.fn(async (receivedJobId, { expectedRevision }) => {
        undoEntered.resolve();
        await releaseUndo.promise;
        await store.updateJob(receivedJobId, { revision: expectedRevision - 1 });
      }),
    };
    const executor = {
      start: vi.fn(async (receivedJobId) => {
        revisionStarted.resolve();
        const current = await store.readJob(receivedJobId);
        await store.updateJob(receivedJobId, { revision: current.revision + 1 });
      }),
      cancel: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const manager = createJobManager({
      store,
      events,
      executor,
      revisions,
      normalizeInput: normalizeDeckJobInput,
    });

    const undoPromise = manager.undo(jobId, { expectedRevision: 3 });
    await undoEntered.promise;
    const messagePromise = manager.message(jobId, {
      instruction: "Change the title",
      expectedRevision: 3,
    });
    const messageResult = settled(messagePromise);
    await Promise.race([revisionStarted.promise, messageResult]);
    releaseUndo.resolve();
    const [undoResult, finalMessageResult] = await Promise.all([
      settled(undoPromise),
      messageResult,
    ]);

    expect(undoResult.status).toBe("fulfilled");
    expect(finalMessageResult).toMatchObject({
      status: "rejected",
      reason: { status: 409 },
    });
    expect(revisions.undo).toHaveBeenCalledTimes(1);
    expect(executor.start).not.toHaveBeenCalled();
    expect((await store.readJob(jobId)).revision).toBe(2);
    await manager.shutdown();
  });

  it("waits for accepted create persistence and never launches it after shutdown", async () => {
    const createEntered = deferred();
    const releaseCreate = deferred();
    const managerStore = {
      ...store,
      createJob: vi.fn(async (input) => {
        createEntered.resolve(input.jobId);
        await releaseCreate.promise;
        return store.createJob(input);
      }),
    };
    let shutdownResolved = false;
    const startsAfterShutdown = [];
    const executor = {
      start: vi.fn(async (jobId) => {
        if (shutdownResolved) startsAfterShutdown.push(jobId);
      }),
      cancel: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    const manager = createJobManager({
      store: managerStore,
      events,
      executor,
      normalizeInput: normalizeDeckJobInput,
    });

    const createResult = settled(manager.create(validRequest));
    const jobId = await createEntered.promise;
    const shutdownPromise = manager.shutdown().then(() => {
      shutdownResolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const resolvedBeforeCreateRelease = shutdownResolved;

    releaseCreate.resolve();
    await Promise.all([createResult, shutdownPromise]);

    expect(resolvedBeforeCreateRelease).toBe(false);
    expect(executor.start).not.toHaveBeenCalled();
    expect(startsAfterShutdown).toEqual([]);
    expect(await store.readJson(jobId, "source-blocks.json"))
      .toEqual(validRequest.source.sourceBlocks);
    expect((await store.listRecoverableJobs()).map((job) => job.id)).toContain(jobId);
  });

  it("rejects provenance IDs that differ only after the normalization limit", () => {
    const sharedPrefix = "x".repeat(160);
    const input = structuredClone(validRequest);
    input.source.sourceBlocks[0].id = `${sharedPrefix}-block`;
    input.source.sourceBlocks[0].source.blockId = `${sharedPrefix}-source`;

    let failure;
    try {
      normalizeDeckJobInput(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ status: 400 });
  });
});
