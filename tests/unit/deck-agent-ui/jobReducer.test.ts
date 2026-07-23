import { describe, expect, it } from "vitest";
import {
  createDeckJobState,
  reduceDeckJob,
} from "../../../src/deck-agent-ui/jobReducer";
import type { DeckJobEvent, DeckJobSnapshot } from "../../../src/deck-agent-ui/types";

const jobId = "job-00000000-0000-4000-8000-000000000001";
const otherJobId = "job-00000000-0000-4000-8000-000000000002";

function snapshot(overrides: Partial<DeckJobSnapshot> = {}): DeckJobSnapshot {
  return {
    id: jobId,
    title: "季度复盘",
    source: { topic: "季度复盘", audience: "管理层", slideCount: 8 },
    status: "queued",
    lastSeq: 0,
    revision: 0,
    progress: { completed: 0, total: 8 },
    artifacts: [{
      id: "slides-content",
      filename: "slides-content.md",
      kind: "markdown",
      stage: "outline",
      previewable: true,
      downloadable: true,
    }],
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

function event(overrides: Partial<DeckJobEvent> = {}): DeckJobEvent {
  return {
    seq: 1,
    jobId,
    stage: "outline",
    type: "stage",
    status: "running",
    title: "生成内容大纲",
    createdAt: "2026-07-22T00:00:01.000Z",
    ...overrides,
  };
}

describe("deck job reducer", () => {
  it("keeps the accepted cursor separate from the snapshot server watermark", () => {
    const initial = createDeckJobState(snapshot({ lastSeq: 4 }));

    expect(initial.lastSeq).toBe(0);
    expect(initial.job?.lastSeq).toBe(4);

    const replayed = reduceDeckJob(initial, {
      type: "event",
      event: event({ seq: 1 }),
    });
    const refreshed = reduceDeckJob(replayed, {
      type: "snapshot",
      job: snapshot({ lastSeq: 6 }),
    });

    expect(refreshed.lastSeq).toBe(1);
    expect(refreshed.job?.lastSeq).toBe(6);
    expect(refreshed.events.map((item) => item.seq)).toEqual([1]);
  });

  it("keeps an in-flight command locked during a background server refresh", () => {
    const pending = reduceDeckJob(createDeckJobState(snapshot()), { type: "command-start" });
    const refreshed = reduceDeckJob(pending, {
      type: "server-refreshed",
      job: snapshot({
        status: "ready",
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
      }),
    });

    expect(refreshed.commandPending).toBe(true);
    expect(refreshed.revision).toBe(1);
    expect(refreshed.artifacts).toEqual([expect.objectContaining({ id: "deck-preview" })]);
  });

  it("rejects wrong-job and duplicate events and keeps timeline sequence order", () => {
    const initial = createDeckJobState(snapshot());
    const afterFirst = reduceDeckJob(initial, { type: "event", event: event({ seq: 2 }) });
    const afterDuplicate = reduceDeckJob(afterFirst, {
      type: "event",
      event: event({ seq: 2, title: "duplicate" }),
    });
    const afterWrongJob = reduceDeckJob(afterDuplicate, {
      type: "event",
      event: event({ seq: 3, jobId: otherJobId }),
    });

    expect(afterWrongJob.events.map((item) => item.seq)).toEqual([2]);
    expect(afterWrongJob.lastSeq).toBe(2);
  });

  it("derives ordered stage groups, progress, revision, status, and commands", () => {
    const initial = createDeckJobState(snapshot());
    const outlined = reduceDeckJob(initial, {
      type: "event",
      event: event({ seq: 1, progress: { completed: 2, total: 8 } }),
    });
    const ready = reduceDeckJob(outlined, {
      type: "event",
      event: event({
        seq: 2,
        stage: "ready",
        type: "revision",
        status: "done",
        title: "演示文稿已完成",
        revision: 3,
      }),
    });

    expect(ready.stageGroups.map((group) => group.stage)).toEqual(["outline", "ready"]);
    expect(ready.stageGroups.flatMap((group) => group.events.map((item) => item.seq))).toEqual([1, 2]);
    expect(ready.progress).toEqual({ completed: 2, total: 8 });
    expect(ready.revision).toBe(3);
    expect(ready.status).toBe("ready");
    expect(ready.actions).toEqual({
      canCancel: false,
      canRetry: false,
      canMessage: true,
      canUndo: true,
      canDownload: true,
    });
  });

  it("stores artifact summaries and selection but no artifact bodies", () => {
    const initial = createDeckJobState(snapshot());
    const selected = reduceDeckJob(initial, {
      type: "select-artifact",
      artifactId: "slides-content",
    });

    expect(selected.selectedArtifact?.id).toBe("slides-content");
    expect(selected.artifacts).toEqual(snapshot().artifacts);
    expect(JSON.stringify(selected)).not.toContain("markdownBody");

    const refreshed = reduceDeckJob(selected, {
      type: "snapshot",
      job: snapshot({ artifacts: [] }),
    });
    expect(refreshed.selectedArtifact).toBeNull();
  });
});
