import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FileText, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchArtifact } from "./api";
import type { DeckArtifactSummary } from "./types";

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export interface ArtifactPreviewProps {
  open: boolean;
  jobId: string;
  artifact: DeckArtifactSummary | null;
  revision: number;
  timelineRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

type PreviewState =
  | { status: "idle" | "loading"; key: string }
  | { status: "ready"; key: string; markdown: string }
  | { status: "error"; key: string; message: string };

async function responseMarkdown(response: Response): Promise<string> {
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/markdown") {
    throw new Error("无法预览：服务器未返回 Markdown 文件。");
  }
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MARKDOWN_BYTES) {
    throw new Error("Markdown 文件过大，无法在浏览器中安全预览。");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
    throw new Error("Markdown 文件过大，无法在浏览器中安全预览。");
  }
  return new TextDecoder().decode(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Markdown 文件加载失败。";
}

export function ArtifactPreview({
  open,
  jobId,
  artifact,
  revision,
  timelineRef,
  onClose,
}: ArtifactPreviewProps) {
  const cacheRef = useRef(new Map<string, string>());
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const timelineScrollRef = useRef(0);
  const wasOpenRef = useRef(false);
  const key = artifact ? `${jobId}:${artifact.id}:${revision}` : "";
  const [preview, setPreview] = useState<PreviewState>({ status: "idle", key: "" });

  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      timelineScrollRef.current = timelineRef.current?.scrollTop ?? 0;
      closeButtonRef.current?.focus({ preventScroll: true });
    } else if (!open && wasOpenRef.current) {
      if (timelineRef.current) timelineRef.current.scrollTop = timelineScrollRef.current;
      returnFocusRef.current?.focus({ preventScroll: true });
    }
    wasOpenRef.current = open;
  }, [open, timelineRef]);

  useEffect(() => {
    if (!open || !artifact) return;
    if (artifact.kind !== "markdown") {
      setPreview({ status: "error", key, message: "该产物不是可预览的 Markdown 文件。" });
      return;
    }
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      setPreview({ status: "ready", key, markdown: cached });
      return;
    }

    const controller = new AbortController();
    setPreview({ status: "loading", key });
    void fetchArtifact(jobId, artifact.id, { signal: controller.signal })
      .then(responseMarkdown)
      .then((markdown) => {
        if (controller.signal.aborted) return;
        cacheRef.current.set(key, markdown);
        setPreview({ status: "ready", key, markdown });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPreview({ status: "error", key, message: errorMessage(error) });
        }
      });
    return () => controller.abort();
  }, [artifact, jobId, key, open]);

  if (!open || !artifact) return null;
  const currentPreview = preview.key === key ? preview : { status: "loading" as const, key };

  return (
    <aside className="deck-agent-artifact-preview" role="dialog" aria-label="Markdown 文件预览">
      <header className="deck-agent-artifact-preview__header">
        <div>
          <span className="deck-agent-artifact-preview__file" aria-hidden="true"><FileText size={16} /></span>
          <strong>{artifact.filename}</strong>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className="deck-agent-icon-button"
          aria-label="关闭预览"
          title="关闭预览"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="deck-agent-artifact-preview__meta">只读 · Markdown</div>
      <div
        className="deck-agent-markdown"
        aria-busy={currentPreview.status === "loading"}
      >
        {currentPreview.status === "loading" && <p role="status">正在加载文件…</p>}
        {currentPreview.status === "error" && <p role="alert">{currentPreview.message}</p>}
        {currentPreview.status === "ready" && (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ children }) => <span>{children}</span>,
              img: () => null,
            }}
          >
            {currentPreview.markdown}
          </ReactMarkdown>
        )}
      </div>
    </aside>
  );
}
