// @vitest-environment jsdom

import React, { createRef, useRef, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPreview } from "../../../src/deck-agent-ui/ArtifactPreview";

const jobId = "job-00000000-0000-4000-8000-000000000001";
const artifact = {
  id: "slides-content",
  filename: "slides-content.md",
  kind: "markdown" as const,
  stage: "outline" as const,
  previewable: true,
  downloadable: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ArtifactPreview", () => {
  it("renders safe read-only Markdown and fetches it once per revision", async () => {
    const markdown = [
      "# 智能制造转型方案",
      "",
      "[外部材料](https://evil.invalid)",
      "",
      "![不应加载](https://evil.invalid/tracker.png)",
      "",
      "<input aria-label=\"恶意输入\" value=\"x\">",
    ].join("\n");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(markdown, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    }));
    const timelineRef = createRef<HTMLElement>();
    const onClose = vi.fn();
    const view = render(
      <ArtifactPreview
        open
        jobId={jobId}
        artifact={artifact}
        revision={1}
        timelineRef={timelineRef}
        onClose={onClose}
      />,
    );

    expect(await screen.findByRole("heading", { name: "智能制造转型方案" })).toBeVisible();
    expect(screen.getByText("外部材料")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "不应加载" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "恶意输入" })).not.toBeInTheDocument();
    expect(document.querySelector("textarea, input, [contenteditable='true']")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    view.rerender(
      <ArtifactPreview
        open
        jobId={jobId}
        artifact={artifact}
        revision={1}
        timelineRef={timelineRef}
        onClose={onClose}
      />,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    view.rerender(
      <ArtifactPreview
        open
        jobId={jobId}
        artifact={artifact}
        revision={2}
        timelineRef={timelineRef}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it("restores the timeline scroll position and the artifact trigger after closing", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("# 大纲", {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    }));

    function Harness() {
      const [open, setOpen] = useState(false);
      const timelineRef = useRef<HTMLElement>(null);
      return (
        <section ref={timelineRef} data-testid="timeline">
          <button type="button" onClick={() => setOpen(true)}>slides-content.md</button>
          <ArtifactPreview
            open={open}
            jobId={jobId}
            artifact={artifact}
            revision={1}
            timelineRef={timelineRef}
            onClose={() => setOpen(false)}
          />
        </section>
      );
    }

    render(<Harness />);
    const timeline = screen.getByTestId("timeline");
    const trigger = screen.getByRole("button", { name: "slides-content.md" });
    Object.defineProperty(timeline, "scrollTop", { value: 146, writable: true });

    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Markdown 文件预览" })).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭预览" })).toHaveFocus();

    timeline.scrollTop = 0;
    await user.click(screen.getByRole("button", { name: "关闭预览" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(timeline.scrollTop).toBe(146);
  });

  it("rejects non-Markdown responses and bodies over the byte limit", async () => {
    const timelineRef = createRef<HTMLElement>();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<h1>not markdown</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }))
      .mockResolvedValueOnce(new Response("too large", {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Length": String(2 * 1024 * 1024 + 1),
        },
      }));
    const view = render(
      <ArtifactPreview
        open
        jobId={jobId}
        artifact={artifact}
        revision={11}
        timelineRef={timelineRef}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/markdown 文件/i);

    view.rerender(
      <ArtifactPreview
        open
        jobId={jobId}
        artifact={artifact}
        revision={12}
        timelineRef={timelineRef}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(/过大/);
  });
});
