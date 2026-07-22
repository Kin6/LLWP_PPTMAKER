import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createEventStore } from "../../../server/deck-agent/event-store.mjs";

async function createTemporaryJob() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "deck-events-"));
  const store = createArtifactStore({ rootDir });
  const jobId = "job-00000000-0000-4000-8000-000000000001";
  await store.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });
  return { rootDir, store, jobId };
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

it("reconciles a durable event before retrying after the job update fails", async () => {
  const { rootDir, store, jobId } = await createTemporaryJob();
  let failJobUpdate = true;
  const faultyStore = createArtifactStore({
    rootDir,
    fsHooks: {
      beforeRename: (_temporary, target) => {
        if (failJobUpdate && target === path.join(rootDir, jobId, "job.json")) {
          failJobUpdate = false;
          throw new Error("job update fault");
        }
      },
    },
  });
  const events = createEventStore({ store: faultyStore, now: () => "2026-07-22T00:00:00.000Z" });

  await expect(events.append(jobId, {
    stage: "outline", type: "progress", status: "running", title: "durable before failure",
  })).rejects.toThrow(/job update fault/);
  expect((await store.readJob(jobId)).lastSeq).toBe(0);

  const retried = await events.append(jobId, {
    stage: "outline", type: "progress", status: "running", title: "retry",
  });
  expect(retried.seq).toBe(2);
  expect((await events.readAfter(jobId, 0)).map((event) => event.seq)).toEqual([1, 2]);
  expect((await store.readJob(jobId)).lastSeq).toBe(2);
});

it("drops an incomplete final record and reconciles lastSeq to the last valid event", async () => {
  const { rootDir, store, jobId } = await createTemporaryJob();
  const events = createEventStore({ store, now: () => "2026-07-22T00:00:00.000Z" });
  await events.append(jobId, { stage: "outline", type: "stage", status: "running", title: "outline" });
  await appendFile(path.join(rootDir, jobId, "events.ndjson"), '{"seq":2,"jobId":');
  await store.updateJob(jobId, { lastSeq: 9 });

  expect((await events.readAfter(jobId, 0)).map((event) => event.seq)).toEqual([1]);
  expect((await store.readJob(jobId)).lastSeq).toBe(1);
  const repaired = await readFile(path.join(rootDir, jobId, "events.ndjson"), "utf8");
  expect(repaired.endsWith("\n")).toBe(true);
  expect(repaired).not.toContain('{"seq":2,"jobId":');
});

it("drops an unterminated schema-invalid final record", async () => {
  const { rootDir, store, jobId } = await createTemporaryJob();
  const events = createEventStore({ store, now: () => "2026-07-22T00:00:00.000Z" });
  await events.append(jobId, { stage: "outline", type: "stage", status: "running", title: "outline" });
  await appendFile(path.join(rootDir, jobId, "events.ndjson"), '{"seq":2}');
  await store.updateJob(jobId, { lastSeq: 2 });

  expect((await events.readAfter(jobId, 0)).map((event) => event.seq)).toEqual([1]);
  expect((await store.readJob(jobId)).lastSeq).toBe(1);
  const repaired = await readFile(path.join(rootDir, jobId, "events.ndjson"), "utf8");
  expect(repaired.endsWith("\n")).toBe(true);
  expect(repaired).not.toContain('{"seq":2}');
});

it("rejects a corrupt newline-terminated persisted event", async () => {
  const { rootDir, store, jobId } = await createTemporaryJob();
  const events = createEventStore({ store });
  await appendFile(path.join(rootDir, jobId, "events.ndjson"), "not-json\n");
  await expect(events.readAfter(jobId, 0)).rejects.toThrow(/corrupt persisted event at line 1/i);
});

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headers = new Map();
    this.ended = false;
  }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  flushHeaders() {}
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end() { this.ended = true; this.emit("finish"); }
  objects() { return this.chunks.flatMap((chunk) => chunk.split("\n").filter(Boolean).map((line) => JSON.parse(line))); }
}

it("subscribes before replay, orders and deduplicates events, then closes on a terminal job event", async () => {
  const { store, jobId } = await createTemporaryJob();
  await createEventStore({ store, now: () => "2026-07-22T00:00:00.000Z" }).append(jobId, {
    stage: "queued", type: "job", status: "queued", title: "created",
  });
  let releaseRead;
  let signalRead;
  const readStarted = new Promise((resolve) => { signalRead = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const delayedStore = {
    ...store,
    async readArtifact(...args) {
      signalRead();
      await readGate;
      return store.readArtifact(...args);
    },
  };
  const events = createEventStore({ store: delayedStore, now: () => "2026-07-22T00:00:00.000Z" });
  const req = new EventEmitter();
  const res = new TestResponse();
  const piping = events.pipeNdjson(req, res, { jobId, after: 0 });
  await readStarted;
  const live = events.append(jobId, { stage: "outline", type: "stage", status: "running", title: "outline" });
  releaseRead();
  await live;
  await events.append(jobId, { stage: "ready", type: "job", status: "done", title: "ready" });
  await piping;

  expect(res.objects().filter((event) => "seq" in event).map((event) => event.seq)).toEqual([1, 2, 3]);
  expect(res.ended).toBe(true);
  expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
});

it("emits a 15-second heartbeat without seq and unsubscribes immediately on request close", async () => {
  vi.useFakeTimers();
  try {
    const { store, jobId } = await createTemporaryJob();
    const events = createEventStore({ store, now: () => "2026-07-22T00:00:00.000Z" });
    const req = new EventEmitter();
    const res = new TestResponse();
    const piping = events.pipeNdjson(req, res, { jobId, after: 0 });
    await vi.advanceTimersByTimeAsync(15_000);
    const heartbeat = res.objects().find((event) => event.type === "heartbeat");
    expect(heartbeat).not.toHaveProperty("seq");
    expect(heartbeat).toEqual({ type: "heartbeat", createdAt: "2026-07-22T00:00:00.000Z" });

    req.emit("close");
    await piping;
    const countAfterClose = res.chunks.length;
    await events.append(jobId, { stage: "outline", type: "stage", status: "running", title: "after close" });
    expect(res.chunks).toHaveLength(countAfterClose);
  } finally {
    vi.useRealTimers();
  }
});
