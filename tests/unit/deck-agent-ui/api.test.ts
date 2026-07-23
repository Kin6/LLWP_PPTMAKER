import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactUrl,
  cancelDeckJob,
  decodeDeckEventStream,
  getDeckJob,
  streamDeckJobEvents,
} from "../../../src/deck-agent-ui/api";
import type { DeckJobEvent, DeckJobSnapshot } from "../../../src/deck-agent-ui/types";

const jobId = "job-00000000-0000-4000-8000-000000000001";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function event(overrides: Partial<DeckJobEvent> = {}): DeckJobEvent {
  return {
    seq: 1,
    jobId,
    stage: "outline",
    type: "stage",
    status: "running",
    title: "大纲",
    createdAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<DeckJobSnapshot> = {}): DeckJobSnapshot {
  return {
    id: jobId,
    title: "季度复盘",
    status: "outline",
    lastSeq: 1,
    revision: 0,
    progress: { completed: 0, total: 8 },
    artifacts: [],
    actions: {
      canCancel: true,
      canRetry: false,
      canMessage: false,
      canUndo: false,
      canDownload: false,
    },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deck job API", () => {
  it("decodes split NDJSON chunks and ignores heartbeat records", async () => {
    const encoded = JSON.stringify(event());
    const chunks = [
      encoded.slice(0, 73),
      `${encoded.slice(73)}\n{"type":"heartbeat"}\n`,
    ];

    expect(await collect(decodeDeckEventStream(streamFrom(chunks)))).toEqual([
      expect.objectContaining({ seq: 1, title: "大纲" }),
    ]);
  });

  it("rejects malformed sequenced records instead of silently advancing", async () => {
    await expect(
      collect(decodeDeckEventStream(streamFrom(['{"seq":2,"type":"stage"}\n']))),
    ).rejects.toThrow(/invalid deck event/i);
  });

  it("rejects incomplete trailing records", async () => {
    await expect(
      collect(decodeDeckEventStream(streamFrom([JSON.stringify(event())]))),
    ).rejects.toThrow(/incomplete record/i);
  });

  it("requests replay after the supplied sequence with an abort signal", async () => {
    const controller = new AbortController();
    const onEvent = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      `${JSON.stringify(event({ seq: 5 }))}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await streamDeckJobEvents(jobId, 4, controller.signal, onEvent);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/html-deck/jobs/${jobId}/events?after=4`,
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/x-ndjson" },
        signal: controller.signal,
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ seq: 5 }));
  });

  it("strictly parses job snapshots before returning them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      job: snapshot(),
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDeckJob(jobId)).resolves.toEqual(snapshot());

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      job: { ...snapshot(), html: "<script>not client state</script>" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(getDeckJob(jobId)).rejects.toThrow(/invalid deck api response/i);
  });

  it("surfaces validated command failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "Job is not cancellable",
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(cancelDeckJob(jobId)).rejects.toThrow("Job is not cancellable");
  });

  it("builds encoded artifact URLs without accepting path-like identifiers", () => {
    expect(artifactUrl(jobId, "slides-content")).toBe(
      `/api/html-deck/jobs/${jobId}/artifacts/slides-content`,
    );
    expect(artifactUrl(jobId, "slides-content", { download: true })).toBe(
      `/api/html-deck/jobs/${jobId}/artifacts/slides-content?download=1`,
    );
    expect(() => artifactUrl(jobId, "../secret")).toThrow(/artifact id/i);
  });
});
