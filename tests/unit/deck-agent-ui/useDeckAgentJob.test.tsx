// @vitest-environment jsdom

import React, { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckJobEvent, DeckJobSnapshot } from "../../../src/deck-agent-ui/types";

const api = vi.hoisted(() => ({
  createDeckJob: vi.fn(),
  getDeckJob: vi.fn(),
  streamDeckJobEvents: vi.fn(),
  cancelDeckJob: vi.fn(),
  retryDeckJob: vi.fn(),
  sendDeckMessage: vi.fn(),
  undoDeckRevision: vi.fn(),
}));

vi.mock("../../../src/deck-agent-ui/api", () => api);

import {
  readDeckJobId,
  replaceDeckJobId,
} from "../../../src/deck-agent-ui/jobLocation";
import { useDeckAgentJob } from "../../../src/deck-agent-ui/useDeckAgentJob";

const jobId = "job-00000000-0000-4000-8000-000000000001";

function snapshot(overrides: Partial<DeckJobSnapshot> = {}): DeckJobSnapshot {
  return {
    id: jobId,
    title: "季度复盘",
    source: { topic: "季度复盘", audience: "管理层", slideCount: 8 },
    status: "building",
    lastSeq: 4,
    revision: 0,
    progress: { completed: 2, total: 8 },
    artifacts: [],
    actions: {
      canCancel: true,
      canRetry: false,
      canMessage: false,
      canUndo: false,
      canDownload: false,
    },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:04.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<DeckJobEvent> = {}): DeckJobEvent {
  return {
    seq: 5,
    jobId,
    stage: "building",
    type: "progress",
    status: "running",
    title: "生成页面",
    createdAt: "2026-07-22T00:00:05.000Z",
    ...overrides,
  };
}

function StrictWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

function pendingUntilAbort(signal: AbortSignal, signals: AbortSignal[]): Promise<void> {
  signals.push(signal);
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
  api.getDeckJob.mockResolvedValue(snapshot());
  api.streamDeckJobEvents.mockImplementation(
    (_jobId: string, _after: number, signal: AbortSignal) => pendingUntilAbort(signal, []),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("job URL location", () => {
  it("restores only one canonical job UUID and preserves unrelated URL state", () => {
    window.history.replaceState({ kept: true }, "", `/?tab=activity&job=${jobId}#latest`);
    expect(readDeckJobId()).toBe(jobId);

    replaceDeckJobId(null);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/?tab=activity#latest",
    );
    expect(window.history.state).toEqual({ kept: true });

    window.history.replaceState(null, "", "/?job=../secrets");
    expect(readDeckJobId()).toBeNull();
    expect(() => replaceDeckJobId("job-not-a-uuid")).toThrow(/job id/i);
  });
});

describe("useDeckAgentJob", () => {
  it("restores a job from the URL and replays from the first unconsumed event", async () => {
    window.history.replaceState(null, "", `/?job=${jobId}`);
    const signals: AbortSignal[] = [];
    api.streamDeckJobEvents.mockImplementation(
      (_id: string, _after: number, signal: AbortSignal) => pendingUntilAbort(signal, signals),
    );

    const { result, unmount } = renderHook(() => useDeckAgentJob());

    await waitFor(() => expect(result.current.state.job?.id).toBe(jobId));
    await waitFor(() => expect(api.streamDeckJobEvents).toHaveBeenCalled());
    expect(api.streamDeckJobEvents).toHaveBeenLastCalledWith(
      jobId,
      0,
      expect.any(AbortSignal),
      expect.any(Function),
    );

    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("starts a newly created job at cursor zero instead of its server watermark", async () => {
    const signals: AbortSignal[] = [];
    api.createDeckJob.mockResolvedValue(snapshot({ status: "queued", lastSeq: 2 }));
    api.streamDeckJobEvents.mockImplementation(
      (_id: string, _after: number, signal: AbortSignal) => pendingUntilAbort(signal, signals),
    );

    const { result, unmount } = renderHook(() => useDeckAgentJob());
    await act(async () => {
      await result.current.create({ source: "new deck" });
    });

    await waitFor(() => expect(api.streamDeckJobEvents).toHaveBeenCalled());
    expect(api.streamDeckJobEvents).toHaveBeenLastCalledWith(
      jobId,
      0,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(result.current.state.job?.lastSeq).toBe(2);
    expect(result.current.state.lastSeq).toBe(0);

    unmount();
  });

  it("replays a restored terminal job until its accepted cursor reaches the watermark", async () => {
    window.history.replaceState(null, "", `/?job=${jobId}`);
    api.getDeckJob.mockResolvedValue(snapshot({
      status: "ready",
      lastSeq: 5,
      revision: 1,
      actions: {
        canCancel: false,
        canRetry: false,
        canMessage: true,
        canUndo: false,
        canDownload: true,
      },
    }));
    api.streamDeckJobEvents.mockImplementationOnce(async (
      _id: string,
      _after: number,
      _signal: AbortSignal,
      onEvent: (value: DeckJobEvent) => void,
    ) => {
      onEvent(event({ seq: 1, stage: "queued", type: "job", status: "queued" }));
      onEvent(event({ seq: 5, stage: "ready", type: "job", status: "done" }));
    });

    const { result, unmount } = renderHook(() => useDeckAgentJob());

    await waitFor(() => expect(result.current.state.lastSeq).toBe(5));
    expect(api.streamDeckJobEvents).toHaveBeenCalledTimes(1);
    expect(api.streamDeckJobEvents).toHaveBeenCalledWith(
      jobId,
      0,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(result.current.state.events.map((item) => item.seq)).toEqual([1, 5]);
    expect(result.current.state.job?.lastSeq).toBe(5);

    unmount();
  });

  it("aborts in-flight restoration and transport work during StrictMode cleanup", async () => {
    window.history.replaceState(null, "", `/?job=${jobId}`);
    const restoreSignals: AbortSignal[] = [];
    const streamSignals: AbortSignal[] = [];
    api.getDeckJob.mockImplementation((_id: string, signal?: AbortSignal) => {
      if (signal) restoreSignals.push(signal);
      return Promise.resolve(snapshot());
    });
    api.streamDeckJobEvents.mockImplementation(
      (_id: string, _after: number, signal: AbortSignal) => pendingUntilAbort(signal, streamSignals),
    );

    const { unmount } = renderHook(() => useDeckAgentJob(), { wrapper: StrictWrapper });
    await waitFor(() => expect(api.streamDeckJobEvents).toHaveBeenCalled());
    unmount();

    expect(restoreSignals.some((signal) => signal.aborted)).toBe(true);
    expect(streamSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("reconnects after the last accepted sequence", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", `/?job=${jobId}`);
    api.streamDeckJobEvents
      .mockImplementationOnce(async (
        _id: string,
        _after: number,
        _signal: AbortSignal,
        onEvent: (value: DeckJobEvent) => void,
      ) => {
        onEvent(event({ seq: 5 }));
      })
      .mockImplementationOnce(
        (_id: string, _after: number, signal: AbortSignal) => pendingUntilAbort(signal, []),
      );

    const { result, unmount } = renderHook(() => useDeckAgentJob());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state.lastSeq).toBe(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(api.streamDeckJobEvents).toHaveBeenNthCalledWith(
      2,
      jobId,
      5,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    unmount();
  });

  it("refreshes artifact summaries without restarting the stream or losing accepted sequence", async () => {
    window.history.replaceState(null, "", `/?job=${jobId}`);
    const streamSignals: AbortSignal[] = [];
    api.getDeckJob
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({
        lastSeq: 4,
        artifacts: [{
          id: "slides-content",
          filename: "slides-content.md",
          kind: "markdown",
          stage: "outline",
          previewable: true,
          downloadable: true,
        }],
      }));
    api.streamDeckJobEvents.mockImplementation((
      _id: string,
      _after: number,
      signal: AbortSignal,
      onEvent: (value: DeckJobEvent) => void,
    ) => {
      streamSignals.push(signal);
      onEvent(event({
        seq: 5,
        stage: "outline",
        type: "artifact",
        status: "done",
        title: "内容大纲已生成",
        artifactId: "slides-content",
      }));
      return pendingUntilAbort(signal, []);
    });

    const { result, unmount } = renderHook(() => useDeckAgentJob());

    await waitFor(() => expect(api.getDeckJob).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.artifacts).toEqual([
      expect.objectContaining({ id: "slides-content", filename: "slides-content.md" }),
    ]));
    expect(api.getDeckJob).toHaveBeenNthCalledWith(2, jobId, expect.any(AbortSignal));
    expect(result.current.state.lastSeq).toBe(5);
    expect(result.current.state.events.map((item) => item.seq)).toEqual([5]);
    expect(api.streamDeckJobEvents).toHaveBeenCalledTimes(1);
    expect(streamSignals[0].aborted).toBe(false);

    unmount();
  });

  it("aborts a stale artifact refresh when the active job changes", async () => {
    window.history.replaceState(null, "", `/?job=${jobId}`);
    const nextJobId = "job-00000000-0000-4000-8000-000000000002";
    let resolveRefresh!: (job: DeckJobSnapshot) => void;
    let refreshSignal!: AbortSignal;
    api.getDeckJob
      .mockResolvedValueOnce(snapshot())
      .mockImplementationOnce((_id: string, signal?: AbortSignal) => {
        refreshSignal = signal!;
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      });
    api.createDeckJob.mockResolvedValue(snapshot({
      id: nextJobId,
      status: "ready",
      lastSeq: 8,
      revision: 1,
      actions: {
        canCancel: false,
        canRetry: false,
        canMessage: true,
        canUndo: true,
        canDownload: false,
      },
    }));
    api.streamDeckJobEvents.mockImplementation((
      _id: string,
      _after: number,
      signal: AbortSignal,
      onEvent: (value: DeckJobEvent) => void,
    ) => {
      onEvent(event({
        seq: 5,
        type: "artifact",
        status: "done",
        artifactId: "slides-content",
      }));
      return pendingUntilAbort(signal, []);
    });

    const { result, unmount } = renderHook(() => useDeckAgentJob());
    await waitFor(() => expect(api.getDeckJob).toHaveBeenCalledTimes(2));

    await act(async () => {
      await result.current.create({ source: "replacement" });
    });
    await waitFor(() => expect(refreshSignal.aborted).toBe(true));

    await act(async () => {
      resolveRefresh(snapshot({
        artifacts: [{
          id: "slides-content",
          filename: "stale.md",
          kind: "markdown",
          stage: "outline",
          previewable: true,
          downloadable: true,
        }],
      }));
      await Promise.resolve();
    });
    expect(result.current.state.job?.id).toBe(nextJobId);
    expect(result.current.state.artifacts).toEqual([]);

    unmount();
  });

  it("refreshes the published snapshot after a terminal event before stopping reconnects", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", `/?job=${jobId}`);
    api.getDeckJob
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot({
        status: "ready",
        lastSeq: 5,
        revision: 1,
        artifacts: [{
          id: "deck-preview",
          filename: "index.html",
          kind: "html",
          stage: "verifying",
          revision: 1,
          previewable: true,
          downloadable: true,
        }],
        actions: {
          canCancel: false,
          canRetry: false,
          canMessage: true,
          canUndo: false,
          canDownload: true,
        },
      }));
    api.streamDeckJobEvents.mockImplementationOnce(async (
      _id: string,
      _after: number,
      _signal: AbortSignal,
      onEvent: (value: DeckJobEvent) => void,
    ) => {
      onEvent(event({ seq: 5, stage: "ready", type: "job", status: "done", revision: 1 }));
    });

    const { result, unmount } = renderHook(() => useDeckAgentJob());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getDeckJob).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("ready");
    expect(result.current.state.revision).toBe(1);
    expect(result.current.state.artifacts).toEqual([
      expect.objectContaining({ id: "deck-preview", revision: 1 }),
    ]);
    expect(result.current.state.actions.canDownload).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.streamDeckJobEvents).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("waits for cancel acknowledgement before aborting the event transport", async () => {
    window.history.replaceState(null, "", `/?job=${jobId}`);
    const streamSignals: AbortSignal[] = [];
    api.streamDeckJobEvents.mockImplementation(
      (_id: string, _after: number, signal: AbortSignal) => pendingUntilAbort(signal, streamSignals),
    );
    let acknowledge!: (job: DeckJobSnapshot) => void;
    api.cancelDeckJob.mockImplementation(() => new Promise((resolve) => {
      acknowledge = resolve;
    }));
    const { result, unmount } = renderHook(() => useDeckAgentJob());
    await waitFor(() => expect(api.streamDeckJobEvents).toHaveBeenCalled());

    let command!: Promise<void>;
    act(() => {
      command = result.current.cancel();
    });
    expect(streamSignals[0].aborted).toBe(false);

    await act(async () => {
      acknowledge(snapshot({
        status: "cancelled",
        actions: {
          canCancel: false,
          canRetry: true,
          canMessage: false,
          canUndo: false,
          canDownload: false,
        },
      }));
      await command;
    });
    expect(streamSignals[0].aborted).toBe(true);
    expect(result.current.state.status).toBe("cancelled");
    unmount();
  });

  it("keeps command failures in state without losing the current snapshot", async () => {
    window.history.replaceState(null, "", `/?job=${jobId}`);
    api.retryDeckJob.mockRejectedValue(new Error("retry rejected"));
    const { result, unmount } = renderHook(() => useDeckAgentJob());
    await waitFor(() => expect(result.current.state.job?.id).toBe(jobId));

    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state.commandError).toBe("retry rejected");
    expect(result.current.state.job?.id).toBe(jobId);
    unmount();
  });
});
