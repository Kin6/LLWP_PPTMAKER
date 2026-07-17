import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  Copy,
  Download,
  Edit3,
  MessageSquare,
  MonitorPlay,
  MousePointer2,
  Pencil,
  Play,
  PanelRight,
  Redo2,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { HtmlDeckFrame } from "./HtmlDeckFrame";
import type { HtmlChartNode, HtmlDeckDrawing, HtmlDeckSpec, HtmlNode, HtmlTextNode } from "./types";

type InspectorTab = "edit" | "comments" | "tweaks";

type HtmlDeckWorkspaceProps = {
  deck: HtmlDeckSpec;
  onChange: (deck: HtmlDeckSpec) => void;
  onExportHtml: () => void;
  onExportPptx: () => void;
  exporting: boolean;
  onRequestAiEdit?: (instruction: string, slideId: string, nodeId?: string) => Promise<void>;
  aiEditing?: boolean;
};

export function HtmlDeckWorkspace({
  deck,
  onChange,
  onExportHtml,
  onExportPptx,
  exporting,
  onRequestAiEdit,
  aiEditing = false,
}: HtmlDeckWorkspaceProps) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [editMode, setEditMode] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("edit");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [aiInstruction, setAiInstruction] = useState("");
  const [drawMode, setDrawMode] = useState(false);
  const [activeStroke, setActiveStroke] = useState<HtmlDeckDrawing | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  const pastRef = useRef<HtmlDeckSpec[]>([]);
  const futureRef = useRef<HtmlDeckSpec[]>([]);
  const currentRef = useRef(deck);

  useEffect(() => {
    currentRef.current = deck;
    setSlideIndex((current) => Math.min(current, deck.slides.length - 1));
  }, [deck]);

  useEffect(() => {
    pastRef.current = [];
    futureRef.current = [];
    setSelectedNodeId("");
    setSlideIndex(0);
  }, [deck.id]);

  const currentSlide = deck.slides[slideIndex] || deck.slides[0];
  const selectedNode = currentSlide?.nodes.find((node) => node.id === selectedNodeId);
  const visibleComments = deck.comments.filter((comment) => comment.slideId === currentSlide?.id && (!selectedNodeId || !comment.nodeId || comment.nodeId === selectedNodeId));

  function commit(next: HtmlDeckSpec) {
    pastRef.current = [...pastRef.current.slice(-99), currentRef.current];
    futureRef.current = [];
    currentRef.current = next;
    onChange(next);
  }

  function undo() {
    const previous = pastRef.current.at(-1);
    if (!previous) return;
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [currentRef.current, ...futureRef.current.slice(0, 99)];
    currentRef.current = previous;
    onChange(previous);
  }

  function redo() {
    const next = futureRef.current[0];
    if (!next) return;
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current.slice(-99), currentRef.current];
    currentRef.current = next;
    onChange(next);
  }

  function updateNode(changes: Partial<HtmlNode>) {
    if (!currentSlide || !selectedNodeId) return;
    commit({
      ...deck,
      revision: deck.revision + 1,
      slides: deck.slides.map((slide) => slide.id === currentSlide.id
        ? { ...slide, nodes: slide.nodes.map((node) => node.id === selectedNodeId ? { ...node, ...changes } as HtmlNode : node) }
        : slide),
    });
  }

  function updateTextStyle(changes: Partial<HtmlTextNode["style"]>) {
    if (selectedNode?.type !== "text") return;
    updateNode({ style: { ...selectedNode.style, ...changes } } as Partial<HtmlTextNode>);
  }

  function updateChart(changes: Partial<HtmlChartNode>) {
    if (selectedNode?.type !== "chart") return;
    updateNode(changes as Partial<HtmlChartNode>);
  }

  function duplicateSlide() {
    if (!currentSlide) return;
    const cloneId = `${currentSlide.id}-copy-${Date.now()}`;
    const clone = {
      ...structuredClone(currentSlide),
      id: cloneId,
      title: `${currentSlide.title} 副本`,
      nodes: currentSlide.nodes.map((node) => ({ ...structuredClone(node), id: `${node.id}-copy-${Date.now()}-${Math.random().toString(16).slice(2)}` })),
    };
    const slides = [...deck.slides];
    slides.splice(slideIndex + 1, 0, clone);
    commit({ ...deck, revision: deck.revision + 1, slides });
    setSlideIndex(slideIndex + 1);
  }

  function removeSlide() {
    if (deck.slides.length <= 1 || !currentSlide) return;
    commit({
      ...deck,
      revision: deck.revision + 1,
      slides: deck.slides.filter((slide) => slide.id !== currentSlide.id),
      comments: deck.comments.filter((comment) => comment.slideId !== currentSlide.id),
      drawings: deck.drawings.filter((drawing) => drawing.slideId !== currentSlide.id),
    });
    setSlideIndex(Math.max(0, slideIndex - 1));
    setSelectedNodeId("");
  }

  function removeNode() {
    if (!selectedNode || !currentSlide) return;
    commit({
      ...deck,
      revision: deck.revision + 1,
      slides: deck.slides.map((slide) => slide.id === currentSlide.id ? { ...slide, nodes: slide.nodes.filter((node) => node.id !== selectedNode.id) } : slide),
      comments: deck.comments.filter((comment) => comment.nodeId !== selectedNode.id),
    });
    setSelectedNodeId("");
  }

  function addComment() {
    const text = commentText.trim();
    if (!text || !currentSlide) return;
    commit({
      ...deck,
      revision: deck.revision + 1,
      comments: [...deck.comments, {
        id: makeId("comment"),
        slideId: currentSlide.id,
        nodeId: selectedNodeId || undefined,
        text,
        createdAt: new Date().toISOString(),
        resolved: false,
      }],
    });
    setCommentText("");
  }

  function updateVariable(id: string, value: string | number | boolean) {
    const nextTheme = id === "primary-color" && typeof value === "string"
      ? { ...deck.theme, primary: value }
      : id === "accent-color" && typeof value === "string"
        ? { ...deck.theme, accent: value }
        : deck.theme;
    commit({
      ...deck,
      revision: deck.revision + 1,
      theme: nextTheme,
      variables: deck.variables.map((variable) => variable.id === id ? { ...variable, value } : variable),
    });
  }

  function beginStroke(event: PointerEvent<SVGSVGElement>) {
    if (!drawMode || !currentSlide) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = relativePoint(event);
    setActiveStroke({ id: makeId("drawing"), slideId: currentSlide.id, color: deck.theme.accent, width: 5, points: [point] });
  }

  function extendStroke(event: PointerEvent<SVGSVGElement>) {
    if (!activeStroke || !drawMode) return;
    const point = relativePoint(event);
    setActiveStroke((current) => current ? { ...current, points: [...current.points, point] } : null);
  }

  function finishStroke(event: PointerEvent<SVGSVGElement>) {
    if (!activeStroke) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (activeStroke.points.length > 1) commit({ ...deck, revision: deck.revision + 1, drawings: [...deck.drawings, activeStroke] });
    setActiveStroke(null);
  }

  async function requestAiEdit() {
    const instruction = aiInstruction.trim();
    if (!instruction || !currentSlide || !onRequestAiEdit) return;
    await onRequestAiEdit(instruction, currentSlide.id, selectedNodeId || undefined);
    setAiInstruction("");
  }

  function openInspector(tab: InspectorTab) {
    setInspectorTab(tab);
    setInspectorOpen(true);
  }

  const activeStrokePoints = useMemo(() => activeStroke?.points.map((point) => `${point.x * 1000},${point.y * 562.5}`).join(" ") || "", [activeStroke]);

  return (
    <div className="html-deck-workspace">
      <div className="html-deck-toolbar">
        <div className="html-mode-control" aria-label="预览模式">
          <button className={editMode ? "active" : ""} onClick={() => setEditMode(true)} title="编辑"><MousePointer2 size={15} />编辑</button>
          <button className={!editMode ? "active" : ""} onClick={() => { setEditMode(false); setDrawMode(false); }} title="放映"><Play size={15} />放映</button>
          <button className={drawMode ? "active" : ""} onClick={() => { setDrawMode((value) => !value); setEditMode(true); }} title="手绘标注"><Pencil size={15} />手绘</button>
        </div>
        <div className="html-history-actions">
          <button onClick={undo} title="撤销" aria-label="撤销"><Undo2 size={16} /></button>
          <button onClick={redo} title="重做" aria-label="重做"><Redo2 size={16} /></button>
          <button onClick={duplicateSlide} title="复制当前页" aria-label="复制当前页"><Copy size={16} /></button>
          <button onClick={removeSlide} disabled={deck.slides.length <= 1} title="删除当前页" aria-label="删除当前页"><Trash2 size={16} /></button>
        </div>
        <div className="html-inspector-actions" aria-label="编辑面板">
          <button className={inspectorOpen && inspectorTab === "edit" ? "active" : ""} onClick={() => openInspector("edit")} title="打开属性面板"><PanelRight size={15} />属性</button>
          <button className={inspectorOpen && inspectorTab === "comments" ? "active" : ""} onClick={() => openInspector("comments")} title="打开评论面板"><MessageSquare size={15} />评论</button>
          <button className={inspectorOpen && inspectorTab === "tweaks" ? "active" : ""} onClick={() => openInspector("tweaks")} title="打开微调面板"><SlidersHorizontal size={15} />微调</button>
        </div>
        <div className="html-export-actions">
          <button onClick={onExportPptx} disabled={exporting}><MonitorPlay size={15} />静态 PPTX</button>
          <button className="primary" onClick={onExportHtml} disabled={exporting}><Download size={15} />导出 HTML</button>
        </div>
      </div>

      <div className="html-editor-layout">
        <aside className="html-slide-rail" aria-label="页面导航">
          {deck.slides.map((slide, index) => (
            <button key={slide.id} className={index === slideIndex ? "active" : ""} onClick={() => { setSlideIndex(index); setSelectedNodeId(""); }}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{slide.title}</strong>
              <small>{slide.nodes.length} 个对象</small>
            </button>
          ))}
        </aside>

        <div className={`html-frame-shell ${drawMode ? "drawing" : ""}`}>
          <HtmlDeckFrame
            deck={deck}
            editMode={editMode && !drawMode}
            activeSlideIndex={slideIndex}
            selectedNodeId={selectedNodeId}
            onSelectNode={(slideId, nodeId) => {
              const index = deck.slides.findIndex((slide) => slide.id === slideId);
              if (index >= 0) setSlideIndex(index);
              setSelectedNodeId(nodeId);
              setInspectorTab("edit");
              setInspectorOpen(true);
            }}
            onSlideChange={(index) => setSlideIndex(index)}
            onNodeRectChange={(slideId, nodeId, rect) => {
              commit({
                ...deck,
                revision: deck.revision + 1,
                slides: deck.slides.map((slide) => slide.id === slideId
                  ? { ...slide, nodes: slide.nodes.map((node) => node.id === nodeId ? { ...node, ...rect } : node) }
                  : slide),
              });
            }}
            onVariableChange={updateVariable}
            onReady={() => setRuntimeError("")}
            onRuntimeError={setRuntimeError}
          />
          {drawMode && (
            <svg
              className="html-draw-overlay"
              viewBox="0 0 1000 562.5"
              onPointerDown={beginStroke}
              onPointerMove={extendStroke}
              onPointerUp={finishStroke}
              onPointerCancel={() => setActiveStroke(null)}
            >
              {activeStrokePoints && <polyline points={activeStrokePoints} fill="none" stroke={deck.theme.accent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          )}
          {runtimeError && <div className="html-runtime-error">{runtimeError}</div>}
        </div>

        {inspectorOpen && <aside className="html-inspector">
          <div className="html-inspector-header">
            <div className="html-inspector-tabs" role="tablist">
              <button className={inspectorTab === "edit" ? "active" : ""} onClick={() => setInspectorTab("edit")}><Edit3 size={14} />属性</button>
              <button className={inspectorTab === "comments" ? "active" : ""} onClick={() => setInspectorTab("comments")}><MessageSquare size={14} />评论</button>
              <button className={inspectorTab === "tweaks" ? "active" : ""} onClick={() => setInspectorTab("tweaks")}><SlidersHorizontal size={14} />微调</button>
            </div>
            <button className="html-inspector-close" onClick={() => setInspectorOpen(false)} title="关闭面板" aria-label="关闭面板"><X size={15} /></button>
          </div>

          {inspectorTab === "edit" && (
            <div className="html-inspector-body">
              <div className="inspector-heading"><span>{selectedNode ? selectedNode.type.toUpperCase() : "SLIDE"}</span><strong>{selectedNode?.name || currentSlide?.title}</strong></div>
              {selectedNode ? (
                <>
                  {selectedNode.type === "text" && <label className="wide"><span>文字</span><textarea value={selectedNode.text} onChange={(event) => updateNode({ text: event.target.value } as Partial<HtmlTextNode>)} /></label>}
                  <div className="html-field-grid">
                    {(["x", "y", "w", "h"] as const).map((key) => <label key={key}><span>{key.toUpperCase()} (%)</span><input type="number" min={0} max={100} step={0.5} value={Math.round(selectedNode[key] * 1000) / 10} onChange={(event) => updateNode({ [key]: clamp(Number(event.target.value) / 100, 0, 1) })} /></label>)}
                  </div>
                  {selectedNode.type === "text" && (
                    <div className="html-field-grid">
                      <label><span>字号</span><input type="number" min={8} max={160} value={selectedNode.style.fontSize} onChange={(event) => updateTextStyle({ fontSize: Number(event.target.value) })} /></label>
                      <label><span>字重</span><input type="number" min={100} max={900} step={50} value={selectedNode.style.fontWeight} onChange={(event) => updateTextStyle({ fontWeight: Number(event.target.value) })} /></label>
                      <label><span>颜色</span><input type="color" value={normalizeColor(selectedNode.style.color)} onChange={(event) => updateTextStyle({ color: event.target.value })} /></label>
                      <label><span>对齐</span><select value={selectedNode.style.align} onChange={(event) => updateTextStyle({ align: event.target.value as HtmlTextNode["style"]["align"] })}><option value="left">左</option><option value="center">中</option><option value="right">右</option></select></label>
                    </div>
                  )}
                  {selectedNode.type === "chart" && (
                    <>
                      <label><span>图表类型</span><select value={selectedNode.chartType} onChange={(event) => updateChart({ chartType: event.target.value as HtmlChartNode["chartType"] })}><option value="bar">柱状图</option><option value="line">折线图</option><option value="pie">饼图</option><option value="scatter">散点图</option><option value="radar">雷达图</option></select></label>
                      <label><span>分类标签（逗号分隔）</span><textarea value={selectedNode.labels.join(", ")} onChange={(event) => updateChart({ labels: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label>
                      <label><span>第一组数据（逗号分隔）</span><textarea value={selectedNode.series[0]?.values.join(", ") || ""} onChange={(event) => updateChart({ series: selectedNode.series.map((series, index) => index ? series : { ...series, values: event.target.value.split(/[,，]/).map(Number).filter(Number.isFinite) }) })} /></label>
                    </>
                  )}
                  <button className="danger-command" onClick={removeNode}><Trash2 size={14} />删除对象</button>
                </>
              ) : (
                <>
                  <label><span>页面背景</span><input type="color" value={normalizeColor(currentSlide?.background || deck.theme.background)} onChange={(event) => currentSlide && commit({ ...deck, revision: deck.revision + 1, slides: deck.slides.map((slide) => slide.id === currentSlide.id ? { ...slide, background: event.target.value } : slide) })} /></label>
                  <label><span>转场</span><select value={currentSlide?.transition || "fade"} onChange={(event) => currentSlide && commit({ ...deck, revision: deck.revision + 1, slides: deck.slides.map((slide) => slide.id === currentSlide.id ? { ...slide, transition: event.target.value as typeof slide.transition } : slide) })}><option value="none">无</option><option value="fade">淡入</option><option value="slide">滑动</option><option value="zoom">缩放</option></select></label>
                </>
              )}
            </div>
          )}

          {inspectorTab === "comments" && (
            <div className="html-inspector-body">
              <div className="inspector-heading"><span>COMMENT</span><strong>{selectedNode ? `针对“${selectedNode.name}”` : "针对当前页"}</strong></div>
              <textarea className="comment-input" value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="描述需要修改的具体内容…" />
              <button className="inspector-command" onClick={addComment}>添加评论</button>
              {onRequestAiEdit && (
                <>
                  <textarea className="comment-input" value={aiInstruction} onChange={(event) => setAiInstruction(event.target.value)} placeholder="让 AI 只修改选中对象…" />
                  <button className="inspector-command primary" disabled={aiEditing || !aiInstruction.trim()} onClick={() => void requestAiEdit()}>{aiEditing ? "正在修改…" : "应用 AI 修改"}</button>
                </>
              )}
              <div className="comment-list">
                {visibleComments.map((comment) => <div key={comment.id} className={comment.resolved ? "resolved" : ""}><p>{comment.text}</p><button onClick={() => commit({ ...deck, revision: deck.revision + 1, comments: deck.comments.map((item) => item.id === comment.id ? { ...item, resolved: !item.resolved } : item) })}>{comment.resolved ? "重新打开" : "解决"}</button></div>)}
              </div>
            </div>
          )}

          {inspectorTab === "tweaks" && (
            <div className="html-inspector-body">
              <div className="inspector-heading"><span>TWEAKS</span><strong>实时参数</strong></div>
              {deck.variables.map((variable) => (
                <label key={variable.id} className="tweak-field">
                  <span>{variable.label}</span>
                  {variable.type === "number" && <input type="range" min={variable.min} max={variable.max} step={variable.step} value={Number(variable.value)} onChange={(event) => updateVariable(variable.id, Number(event.target.value))} />}
                  {variable.type === "color" && <input type="color" value={normalizeColor(String(variable.value))} onChange={(event) => updateVariable(variable.id, event.target.value)} />}
                  {variable.type === "boolean" && <input type="checkbox" checked={Boolean(variable.value)} onChange={(event) => updateVariable(variable.id, event.target.checked)} />}
                  {variable.type === "select" && <select value={String(variable.value)} onChange={(event) => updateVariable(variable.id, event.target.value)}>{variable.options?.map((option) => <option key={option}>{option}</option>)}</select>}
                  <output>{String(variable.value)}</output>
                </label>
              ))}
            </div>
          )}
        </aside>}
      </div>
    </div>
  );
}

function relativePoint(event: PointerEvent<SVGSVGElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1),
    y: clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1),
  };
}

function normalizeColor(value: string) {
  return /^#[\da-f]{6}$/i.test(value) ? value : "#0e6cff";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
