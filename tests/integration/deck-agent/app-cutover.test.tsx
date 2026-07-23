// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckJobSnapshot } from "../../../src/deck-agent-ui/types";

vi.mock("../../../src/app/pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/pipeline")>();
  return {
    ...actual,
    inspectImage: vi.fn(async (file: File, index: number, brief: string) => ({
      id: "upload-001",
      filename: file.name,
      url: "blob:source-image",
      prompt: brief,
      index,
      kind: "upload" as const,
      width: 1_200,
      height: 800,
      summary: "1200x800 landscape source image",
    })),
    assetToApiImage: vi.fn(async () => ({
      name: "source.png",
      dataUrl: "data:image/jpeg;base64,c291cmNl",
      summary: "1200x800 landscape source image",
    })),
  };
});

vi.mock("../../../src/deck-agent-ui/AgentRunView", () => ({
  AgentRunView: ({
    jobId,
    initialRequest,
    onExit,
  }: {
    jobId: string;
    initialRequest: { topic: string; audience: string; slideCount: number };
    onExit: () => void;
  }) => (
    <main aria-label="Deck Agent run">
      <h1>Deck Agent</h1>
      <p>{jobId}</p>
      <p>{initialRequest.topic} / {initialRequest.audience} / {initialRequest.slideCount}</p>
      <button onClick={onExit}>返回工作台</button>
    </main>
  ),
}));

import App from "../../../src/App";

const jobId = "job-00000000-0000-4000-8000-000000000001";
const queuedJob: DeckJobSnapshot = {
  id: jobId,
  title: "可信 AI 决策",
  source: { topic: "可信 AI 决策", audience: "管理层", slideCount: 11 },
  status: "queued",
  lastSeq: 1,
  revision: 0,
  progress: { completed: 0, total: 11 },
  artifacts: [],
  actions: {
    canCancel: true,
    canRetry: false,
    canMessage: false,
    canUndo: false,
    canDownload: false,
  },
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  sessionStorage.setItem("llwp-ppt-api-config", JSON.stringify({
    configVersion: 6,
    imageEnabled: false,
    imageCount: 4,
    imageQuality: "medium",
    imageTextMode: "native",
    imageTimeoutSeconds: 321,
    imageMaxRetries: 2,
  }));
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("App HTML cutover", () => {
  it("submits parsed source blocks and uploads to one Deck Agent job", async () => {
    const requestBodies: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/health") {
        return new Response(JSON.stringify({ ok: true, envKeyConfigured: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/html-deck/jobs" && init?.method === "POST") {
        requestBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true, job: queuedJob }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    const { container } = render(<App />);

    expect(screen.getByRole("button", { name: "交互网页" })).toBeVisible();
    await user.type(screen.getByLabelText("描述演示主题和核心材料"), "可信 AI 决策");
    await user.type(screen.getByLabelText(/目标受众/), "管理层");
    fireEvent.change(screen.getByLabelText(/精确页数/), { target: { value: "11" } });

    const imageInput = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/png,image/jpeg,image/webp"]',
    );
    expect(imageInput).not.toBeNull();
    await user.upload(imageInput!, new File(["source"], "source.png", { type: "image/png" }));
    expect(await screen.findByText("source.png")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "生成演示文稿" }));
    await waitFor(() => {
      const legacyCalls = fetchSpy.mock.calls.filter(([input]) => (
        /\/api\/ai\/(?:generate-deck|generate-html-deck|patch-html-deck)/.test(String(input))
      ));
      expect(legacyCalls, "legacy HTML endpoint calls").toHaveLength(0);
      expect(requestBodies).toHaveLength(1);
    });

    const body = requestBodies[0] as {
      source: Record<string, unknown> & {
        sourceBlocks: Array<{ id: string; source: { blockId: string } }>;
      };
      options: Record<string, unknown>;
    };
    expect(body.source).toMatchObject({
      topic: "可信 AI 决策",
      audience: "管理层",
      slideCount: 11,
      textInput: "可信 AI 决策",
      images: [{
        name: "source.png",
        dataUrl: "data:image/jpeg;base64,c291cmNl",
        summary: "1200x800 landscape source image",
      }],
      sourceBlocks: [{
        type: "image",
        assetId: "upload-001",
        source: {
          filename: "source.png",
          kind: "image",
          extraction: "native",
          imageIndex: 1,
        },
      }],
    });
    expect(body.source.sourceBlocks[0].id).toBe(body.source.sourceBlocks[0].source.blockId);
    expect(body.options).toEqual({
      imageEnabled: false,
      imageCount: 4,
      imageQuality: "medium",
      imageTimeoutMs: 321_000,
      imageMaxRetries: 1,
    });
    expect(body.source).not.toHaveProperty("deck");
    expect(body).not.toHaveProperty("draft");

    const jobPosts = fetchSpy.mock.calls.filter(([input, init]) => (
      String(input) === "/api/html-deck/jobs" && init?.method === "POST"
    ));
    const legacyCalls = fetchSpy.mock.calls.filter(([input]) => (
      /\/api\/ai\/(?:generate-deck|generate-html-deck|patch-html-deck)/.test(String(input))
    ));
    expect(jobPosts).toHaveLength(1);
    expect(legacyCalls).toHaveLength(0);
    expect(window.location.search).toBe(`?job=${jobId}`);
    expect(await screen.findByRole("main", { name: "Deck Agent run" })).toBeVisible();
    expect(screen.getByText(`${jobId}`)).toBeVisible();
    expect(screen.getByRole("button", { name: "返回工作台" })).toBeVisible();
  });
});
