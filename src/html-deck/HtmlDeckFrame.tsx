import { useEffect, useMemo, useRef } from "react";
import { buildHtmlDeckDocument } from "./document";
import type { HtmlDeckSpec } from "./types";

type HtmlDeckFrameProps = {
  deck: HtmlDeckSpec;
  editMode: boolean;
  activeSlideIndex: number;
  selectedNodeId?: string;
  onSelectNode: (slideId: string, nodeId: string) => void;
  onSlideChange: (index: number, slideId: string) => void;
  onNodeRectChange?: (slideId: string, nodeId: string, rect: { x: number; y: number; w: number; h: number }) => void;
  onVariableChange?: (variableId: string, value: string | number | boolean) => void;
  onReady?: () => void;
  onRuntimeError?: (message: string) => void;
};

export function HtmlDeckFrame({
  deck,
  editMode,
  activeSlideIndex,
  selectedNodeId,
  onSelectNode,
  onSlideChange,
  onNodeRectChange,
  onVariableChange,
  onReady,
  onRuntimeError,
}: HtmlDeckFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const document = useMemo(() => buildHtmlDeckDocument(deck, {
    runtimeOrigin: window.location.origin,
    editMode,
    selectedNodeId,
  }), [deck, editMode, selectedNodeId]);

  const goToActiveSlide = () => {
    frameRef.current?.contentWindow?.postMessage({
      source: "llwp-html-editor",
      type: "go-to-slide",
      index: activeSlideIndex,
    }, "*");
  };

  useEffect(goToActiveSlide, [activeSlideIndex, document]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.source !== "llwp-html-deck" || message.deckId !== deck.id) return;
      if (message.type === "select-node") onSelectNode(String(message.slideId || ""), String(message.nodeId || ""));
      if (message.type === "slide-change") onSlideChange(Number(message.index) || 0, String(message.slideId || ""));
      if (message.type === "update-node-rect" && message.rect && typeof message.rect === "object") {
        onNodeRectChange?.(String(message.slideId || ""), String(message.nodeId || ""), {
          x: Number(message.rect.x),
          y: Number(message.rect.y),
          w: Number(message.rect.w),
          h: Number(message.rect.h),
        });
      }
      if (message.type === "variable-change") onVariableChange?.(String(message.variableId || ""), message.value);
      if (message.type === "ready") onReady?.();
      if (message.type === "runtime-error") onRuntimeError?.(String(message.message || "HTML 演示运行失败"));
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [deck.id, onNodeRectChange, onReady, onRuntimeError, onSelectNode, onSlideChange, onVariableChange]);

  return (
    <iframe
      ref={frameRef}
      className="html-deck-frame"
      title={`${deck.title} 交互演示`}
      sandbox="allow-scripts"
      srcDoc={document}
      onLoad={goToActiveSlide}
    />
  );
}
