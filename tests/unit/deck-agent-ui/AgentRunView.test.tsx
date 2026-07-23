// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  artifactUrl: vi.fn(),
  fetchArtifact: vi.fn(),
}));

vi.mock("../../../src/deck-agent-ui/api", () => api);

import { AgentRunView } from "../../../src/deck-agent-ui/AgentRunView";

const jobId = "job-00000000-0000-4000-8000-000000000001";
const request = {
  topic: "智能制造转型方案",
  audience: "管理层",
  slideCount: 8,
};

const outlineArtifact = {
  id: "slides-content",
  filename: "slides-content.md",
  kind: "markdown" as const,
  stage: "outline" as const,
  previewable: true,
  downloadable: true,
};

const previewArtifact = {
  id: "deck-preview",
  filename: "index.html",
  kind: "html" as const,
  stage: "verifying" as const,
  revision: 2,
  previewable: true,
  downloadable: true,
};

function snapshot(overrides: Partial<DeckJobSnapshot> = {}): DeckJobSnapshot {
  return {
    id: jobId,
    title: request.topic,
    source: request,
    status: "building",
    lastSeq: 0,
    revision: 0,
    progress: { completed: 2, total: 8 },
    artifacts: [outlineArtifact],
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
    stage: "queued",
    type: "message",
    status: "done",
    title: "开始制作演示文稿",
    message: "我会把“智能制造转型方案”整理成面向管理层的 8 页演示，先生成 Markdown 内容大纲，然后自动进入设计。",
    createdAt: "2026-07-22T00:00:01.000Z",
    ...overrides,
  };
}

function pendingUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

let emitEvent: ((value: DeckJobEvent) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  emitEvent = undefined;
  window.history.replaceState(null, "", `/?job=${jobId}`);
  api.getDeckJob.mockResolvedValue(snapshot());
  api.streamDeckJobEvents.mockImplementation((
    _id: string,
    _after: number,
    signal: AbortSignal,
    onEvent: (value: DeckJobEvent) => void,
  ) => {
    emitEvent = onEvent;
    return pendingUntilAbort(signal);
  });
  api.fetchArtifact.mockResolvedValue(new Response(
    "# 智能制造转型方案\n\n## 幻灯片 1：封面\n\n**核心结论：** 从单点自动化走向数据闭环。",
    { headers: { "Content-Type": "text/markdown; charset=utf-8" } },
  ));
  api.artifactUrl.mockImplementation((id: string, artifactId: string, options?: { download?: boolean }) => (
    `/api/html-deck/jobs/${id}/artifacts/${artifactId}${options?.download ? "?download=1" : ""}`
  ));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AgentRunView", () => {
  it("expands a step title and opens Markdown while later events continue", async () => {
    const user = userEvent.setup();
    render(<AgentRunView jobId={jobId} initialRequest={request} onExit={vi.fn()} />);

    await waitFor(() => expect(emitEvent).toBeTypeOf("function"));
    act(() => {
      emitEvent?.(event());
      emitEvent?.(event({
        seq: 2,
        stage: "outline",
        type: "stage",
        status: "done",
        title: "整理幻灯片内容大纲并写入 Markdown",
        message: "大纲已写入文件，下一步已经自动开始。",
        progress: { completed: 1, total: 1 },
      }));
      emitEvent?.(event({
        seq: 3,
        stage: "design",
        type: "progress",
        status: "running",
        title: "建立单一设计方向",
        message: "正在请求模型生成设计方向",
        progress: { completed: 0, total: 1 },
      }));
      emitEvent?.(event({
        seq: 4,
        stage: "building",
        type: "stage",
        status: "running",
        title: "生成 HTML 页面",
        message: "正在按已校准的设计方向生成页面。",
        progress: { completed: 2, total: 8 },
      }));
    });

    const heading = await screen.findByRole("button", { name: "整理幻灯片内容大纲并写入 Markdown" });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    await user.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    await user.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("正在请求模型生成设计方向")).toBeVisible();
    expect(Array.from(document.querySelectorAll("[data-event-seq]"), (node) => (
      node.getAttribute("data-event-seq")
    ))).toEqual(["1", "2", "3", "4"]);

    await user.click(screen.getByRole("button", { name: "slides-content.md" }));
    expect(await screen.findByRole("heading", { name: "智能制造转型方案" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /markdown/i })).not.toBeInTheDocument();

    act(() => {
      emitEvent?.(event({
        seq: 8,
        stage: "building",
        type: "progress",
        status: "running",
        title: "生成 HTML 页面",
        message: "正在生成第 3 页。",
        progress: { completed: 3, total: 8 },
      }));
    });
    expect(await screen.findByText("3 / 8")).toBeVisible();
  });

  it("sends current-page edits, explicit selections, undo, and download from server command state", async () => {
    const user = userEvent.setup();
    const ready = snapshot({
      status: "ready",
      lastSeq: 8,
      revision: 2,
      progress: { completed: 8, total: 8 },
      artifacts: [outlineArtifact, previewArtifact],
      actions: {
        canCancel: false,
        canRetry: false,
        canMessage: true,
        canUndo: true,
        canDownload: true,
      },
    });
    api.getDeckJob.mockResolvedValue(ready);
    api.sendDeckMessage.mockResolvedValue(snapshot({ ...ready, revision: 3 }));
    api.undoDeckRevision.mockResolvedValue(snapshot({ ...ready, revision: 1 }));

    render(<AgentRunView jobId={jobId} initialRequest={request} onExit={vi.fn()} />);

    expect(await screen.findByTitle("HTML 幻灯片预览")).toHaveAttribute("sandbox", "allow-scripts");
    expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 HTML 演示" })).toHaveAttribute(
      "href",
      `/api/html-deck/jobs/${jobId}/artifacts/deck-preview?download=1`,
    );

    await user.click(screen.getByRole("checkbox", { name: "第 2 页" }));
    await user.type(screen.getByRole("textbox", { name: "修改要求" }), "突出第二页的成本数据");
    await user.click(screen.getByRole("button", { name: "发送修改" }));

    await waitFor(() => expect(api.sendDeckMessage).toHaveBeenCalledWith(
      jobId,
      {
        instruction: "突出第二页的成本数据",
        currentSlideId: "slide-01",
        slideIds: ["slide-02"],
        expectedRevision: 2,
      },
      expect.any(AbortSignal),
    ));

    await user.click(screen.getByRole("button", { name: "撤销上一版" }));
    await waitFor(() => expect(api.undoDeckRevision).toHaveBeenCalledWith(
      jobId,
      3,
      expect.any(AbortSignal),
    ));
  });

  it("uses the persisted source summary when restoring a job URL", async () => {
    const user = userEvent.setup();
    const ready = snapshot({
      source: { topic: "恢复后的演示", audience: "董事会", slideCount: 11 },
      status: "ready",
      lastSeq: 8,
      revision: 2,
      progress: { completed: 8, total: 8 },
      artifacts: [outlineArtifact, previewArtifact],
      actions: {
        canCancel: false,
        canRetry: false,
        canMessage: true,
        canUndo: true,
        canDownload: true,
      },
    });
    api.getDeckJob.mockResolvedValue(ready);

    render(
      <AgentRunView
        jobId={jobId}
        initialRequest={{ topic: "页面默认值", audience: "", slideCount: 7 }}
        onExit={vi.fn()}
      />,
    );

    expect(await screen.findByText("1 / 11")).toBeVisible();
    await user.click(screen.getByText("选择明确页面"));
    expect(screen.getByRole("checkbox", { name: "第 11 页" })).toBeVisible();
  });

  it("keeps preview and retry available for needs-review, but withholds preview after failure", async () => {
    const user = userEvent.setup();
    const needsReview = snapshot({
      status: "needs-review",
      revision: 2,
      artifacts: [outlineArtifact, previewArtifact],
      actions: {
        canCancel: false,
        canRetry: true,
        canMessage: true,
        canUndo: true,
        canDownload: true,
      },
    });
    api.getDeckJob.mockResolvedValue(needsReview);
    api.retryDeckJob.mockResolvedValue(needsReview);

    const view = render(<AgentRunView jobId={jobId} initialRequest={request} onExit={vi.fn()} />);
    expect(await screen.findByTitle("HTML 幻灯片预览")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试任务" }));
    expect(api.retryDeckJob).toHaveBeenCalledWith(jobId, expect.any(AbortSignal));
    view.unmount();

    api.getDeckJob.mockResolvedValue(snapshot({
      status: "failed",
      revision: 2,
      artifacts: [outlineArtifact, previewArtifact],
      actions: {
        canCancel: false,
        canRetry: true,
        canMessage: false,
        canUndo: false,
        canDownload: false,
      },
    }));
    render(<AgentRunView jobId={jobId} initialRequest={request} onExit={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "重试任务" })).toBeVisible();
    expect(screen.queryByTitle("HTML 幻灯片预览")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "slides-content.md" })).toBeVisible();
  });
});
