// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeckPreview } from "../../../src/deck-agent-ui/DeckPreview";

const jobId = "job-00000000-0000-4000-8000-000000000001";
const job = {
  id: jobId,
  revision: 2,
  slideIds: ["slide-01", "slide-02", "slide-03", "slide-04", "slide-05"],
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

function channelFrom(frame: HTMLIFrameElement): string {
  return new URL(frame.src).hash.replace(/^#channel=/, "");
}

function dispatchMessage({
  source,
  origin,
  data,
}: {
  source: MessageEventSource | null;
  origin: string;
  data: unknown;
}) {
  window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeckPreview", () => {
  it("accepts only the exact opaque-origin channel envelope", () => {
    const onSlideChange = vi.fn();
    render(<DeckPreview job={job} artifact={previewArtifact} onSlideChange={onSlideChange} />);
    const frame = screen.getByTitle("HTML 幻灯片预览") as HTMLIFrameElement;
    const channelToken = channelFrom(frame);

    expect(channelToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    dispatchMessage({
      source: frame.contentWindow,
      origin: "null",
      data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-03" },
    });
    expect(onSlideChange).toHaveBeenCalledWith("slide-03");

    dispatchMessage({
      source: frame.contentWindow,
      origin: "https://evil.invalid",
      data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-04" },
    });
    dispatchMessage({
      source: window,
      origin: "null",
      data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-05" },
    });
    dispatchMessage({
      source: frame.contentWindow,
      origin: "null",
      data: { type: "deck-slide-changed", channelToken: "wrong", jobId, revision: 2, slideId: "slide-04" },
    });
    dispatchMessage({
      source: frame.contentWindow,
      origin: "null",
      data: { type: "deck-slide-changed", channelToken, jobId, revision: 3, slideId: "slide-04" },
    });
    dispatchMessage({
      source: frame.contentWindow,
      origin: "null",
      data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-99" },
    });
    dispatchMessage({
      source: frame.contentWindow,
      origin: "null",
      data: { type: "deck-slide-changed", channelToken, jobId, revision: 2, slideId: "slide-04", extra: true },
    });
    expect(onSlideChange).toHaveBeenCalledTimes(1);
  });

  it("uses the strict sandbox and keeps the channel token in the fragment", () => {
    render(<DeckPreview job={job} artifact={previewArtifact} onSlideChange={vi.fn()} />);
    const frame = screen.getByTitle("HTML 幻灯片预览") as HTMLIFrameElement;
    const url = new URL(frame.src);

    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.getAttribute("sandbox")).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-downloads|allow-top-navigation/);
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#channel=[A-Za-z0-9_-]{22}$/);
  });

  it("posts navigation commands to the opaque frame with the exact envelope and wildcard target", async () => {
    const user = userEvent.setup();
    render(
      <DeckPreview
        job={job}
        artifact={previewArtifact}
        currentSlideId="slide-01"
        onSlideChange={vi.fn()}
      />,
    );
    const frame = screen.getByTitle("HTML 幻灯片预览") as HTMLIFrameElement;
    const channelToken = channelFrom(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(postMessage).toHaveBeenCalledWith({
      type: "deck-command",
      command: "go-to-slide",
      channelToken,
      jobId,
      revision: 2,
      slideId: "slide-02",
      index: 1,
    }, "*");
  });
});
