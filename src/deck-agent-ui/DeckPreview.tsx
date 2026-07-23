import { useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { artifactUrl } from "./api";
import type { DeckArtifactSummary, DeckJobSnapshot } from "./types";

const SLIDE_ID = /^slide-\d{2}$/;
const SLIDE_EVENT_KEYS = ["channelToken", "jobId", "revision", "slideId", "type"];

export interface DeckPreviewJob extends Pick<DeckJobSnapshot, "id" | "revision"> {
  slideIds: readonly string[];
}

export interface DeckPreviewProps {
  job: DeckPreviewJob;
  artifact: DeckArtifactSummary;
  currentSlideId?: string | null;
  onSlideChange: (slideId: string) => void;
}

function createChannelToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function hasExactSlideEnvelope(value: unknown): value is {
  type: "deck-slide-changed";
  channelToken: string;
  jobId: string;
  revision: number;
  slideId: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join("|") === SLIDE_EVENT_KEYS.join("|");
}

export function DeckPreview({ job, artifact, currentSlideId, onSlideChange }: DeckPreviewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const channelToken = useMemo(createChannelToken, [job.id, job.revision]);
  const slideIds = useMemo(() => (
    [...new Set(job.slideIds)].filter((slideId) => SLIDE_ID.test(slideId))
  ), [job.slideIds]);
  const allowedSlideIds = useMemo(() => new Set(slideIds), [slideIds]);
  const previewSrc = useMemo(() => (
    `${artifactUrl(job.id, artifact.id)}#channel=${channelToken}`
  ), [artifact.id, channelToken, job.id]);
  const currentIndex = Math.max(0, currentSlideId ? slideIds.indexOf(currentSlideId) : 0);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== "null") return;
      const message = event.data;
      if (!hasExactSlideEnvelope(message)
        || message.type !== "deck-slide-changed"
        || message.channelToken !== channelToken
        || message.jobId !== job.id
        || message.revision !== job.revision
        || !allowedSlideIds.has(message.slideId)) return;
      onSlideChange(message.slideId);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [allowedSlideIds, channelToken, job.id, job.revision, onSlideChange]);

  const goToSlide = (index: number) => {
    const slideId = slideIds[index];
    if (!slideId) return;
    frameRef.current?.contentWindow?.postMessage({
      type: "deck-command",
      command: "go-to-slide",
      channelToken,
      jobId: job.id,
      revision: job.revision,
      slideId,
      index,
    }, "*");
  };

  return (
    <section className="deck-agent-deck-preview" aria-label="演示文稿预览">
      <div className="deck-agent-deck-preview__toolbar">
        <strong>HTML 演示</strong>
        <div className="deck-agent-deck-preview__navigation">
          <button
            type="button"
            className="deck-agent-icon-button"
            aria-label="上一页"
            title="上一页"
            disabled={!slideIds.length || currentIndex <= 0}
            onClick={() => goToSlide(currentIndex - 1)}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <span aria-live="polite">{slideIds.length ? currentIndex + 1 : 0} / {slideIds.length}</span>
          <button
            type="button"
            className="deck-agent-icon-button"
            aria-label="下一页"
            title="下一页"
            disabled={!slideIds.length || currentIndex >= slideIds.length - 1}
            onClick={() => goToSlide(currentIndex + 1)}
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="deck-agent-deck-preview__frame">
        <iframe
          key={`${job.id}-${job.revision}-${channelToken}`}
          ref={frameRef}
          src={previewSrc}
          title="HTML 幻灯片预览"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
      </div>
    </section>
  );
}
