import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Download,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Undo2,
} from "lucide-react";
import { artifactUrl } from "./api";
import { AgentMessage, requestPageCount, type AgentInitialRequest } from "./AgentMessage";
import { AgentStep, type AgentStepModel } from "./AgentStep";
import { ArtifactPreview } from "./ArtifactPreview";
import { DeckPreview, type DeckPreviewJob } from "./DeckPreview";
import type { DeckArtifactSummary, DeckJobEvent, DeckJobStatus } from "./types";
import { useDeckAgentJob } from "./useDeckAgentJob";
import "./deck-agent.css";

export interface AgentRunViewProps {
  jobId: string | null;
  initialRequest: AgentInitialRequest;
  onExit: () => void;
}

const STAGE_ORDER: DeckJobStatus[] = [
  "outline",
  "design",
  "calibrating",
  "building",
  "generating-assets",
  "verifying",
  "repairing",
  "ready",
  "needs-review",
  "failed",
  "cancelled",
];

const STAGE_TITLES: Partial<Record<DeckJobStatus, string>> = {
  outline: "整理幻灯片内容大纲并写入 Markdown",
  design: "建立单一设计方向",
  calibrating: "校准代表页面",
  building: "生成 HTML 幻灯片页面",
  "generating-assets": "处理页面素材",
  verifying: "检查排版、内容溢出与视觉一致性",
  repairing: "修复未通过检查的页面",
  ready: "交付 HTML 演示文稿",
  "needs-review": "演示文稿需要复核",
  failed: "任务执行失败",
  cancelled: "任务已取消",
};

const TERMINAL_STATUS: Partial<Record<DeckJobStatus, DeckJobEvent["status"]>> = {
  ready: "done",
  "needs-review": "done",
  failed: "failed",
  cancelled: "cancelled",
};

function artifactForTimeline(artifact: DeckArtifactSummary): boolean {
  return artifact.id === "slides-content" && artifact.kind === "markdown" && artifact.stage === "outline";
}

function specialNewJobError(message: string | null): boolean {
  return !!message && /new[- ]job|required|narrative rewrite|whole narrative|整套叙事|叙事重写/i.test(message);
}

function statusLabel(status: DeckJobStatus | null): string {
  if (!status) return "正在连接";
  if (status === "ready") return "已完成";
  if (status === "needs-review") return "需要复核";
  if (status === "failed") return "执行失败";
  if (status === "cancelled") return "已取消";
  return "生成中";
}

function latestEvent(events: DeckJobEvent[]): DeckJobEvent | undefined {
  return events[events.length - 1];
}

export function AgentRunView({ jobId, initialRequest, onExit }: AgentRunViewProps) {
  const {
    state,
    cancel,
    retry,
    sendMessage,
    undo,
    selectArtifact,
    closeArtifact,
    reconnect,
  } = useDeckAgentJob();
  const timelineRef = useRef<HTMLElement>(null);
  const [previewArtifact, setPreviewArtifact] = useState<DeckArtifactSummary | null>(null);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [currentSlideId, setCurrentSlideId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [selectedSlideIds, setSelectedSlideIds] = useState<string[]>([]);
  const job = state.job && (!jobId || state.job.id === jobId) ? state.job : null;
  const effectiveRequest = job?.source ?? initialRequest;
  const pageCount = requestPageCount(effectiveRequest);
  const slideIds = useMemo(() => Array.from(
    { length: pageCount ?? 0 },
    (_, index) => `slide-${String(index + 1).padStart(2, "0")}`,
  ), [pageCount]);

  useEffect(() => {
    if (!slideIds.length) {
      setCurrentSlideId(null);
      return;
    }
    setCurrentSlideId((current) => current && slideIds.includes(current) ? current : slideIds[0]);
    setSelectedSlideIds((selected) => selected.filter((slideId) => slideIds.includes(slideId)));
  }, [slideIds]);

  const timelineArtifacts = state.artifacts.filter(artifactForTimeline);
  const steps = useMemo<AgentStepModel[]>(() => {
    const groups = new Map(state.stageGroups.map((group) => [group.stage, group]));
    const stages = new Set<DeckJobStatus>();
    for (const group of state.stageGroups) {
      const historicalTerminal = TERMINAL_STATUS[group.stage] !== undefined
        && group.stage !== state.status;
      if (group.stage !== "queued" && !historicalTerminal) stages.add(group.stage);
    }
    for (const artifact of timelineArtifacts) stages.add(artifact.stage);
    if (state.status && state.status !== "queued") stages.add(state.status);

    return STAGE_ORDER.filter((stage) => stages.has(stage)).map((stage) => {
      const group = groups.get(stage);
      const last = latestEvent(group?.events ?? []);
      const artifacts = timelineArtifacts.filter((artifact) => artifact.stage === stage);
      const completedBySuccessfulJob = ["ready", "needs-review"].includes(state.status ?? "")
        && TERMINAL_STATUS[stage] === undefined;
      const status = completedBySuccessfulJob
        ? "done"
        : group?.status
        ?? (state.status === stage ? TERMINAL_STATUS[stage] ?? "running" : undefined)
        ?? (artifacts.length ? "done" : "queued");
      const effectiveLast = status === "done" && last?.status !== "done"
        ? [...(group?.events ?? [])].reverse().find((item) => item.status === "done")
        : last;
      const message = effectiveLast?.error?.message ?? effectiveLast?.message
        ?? (stage === "failed" ? state.job?.error : undefined);
      return {
        key: stage,
        title: effectiveLast?.title ?? last?.title ?? STAGE_TITLES[stage] ?? stage,
        status,
        message,
        progress: effectiveLast?.progress,
        artifacts,
        canRetry: status === "failed" && state.actions.canRetry,
        defaultExpanded: stage === "outline" && artifacts.length > 0
          ? true
          : state.status === "failed" && artifacts.length > 0 ? true : undefined,
        eventSeq: effectiveLast?.type === "message" ? undefined : effectiveLast?.seq,
      };
    });
  }, [state.actions.canRetry, state.job?.error, state.stageGroups, state.status, timelineArtifacts]);

  const deckArtifact = state.artifacts.find((artifact) => (
    artifact.id === "deck-preview" && artifact.kind === "html" && artifact.previewable
  ));
  const canShowDeck = !!job && !!deckArtifact
    && (state.status === "ready" || state.status === "needs-review");

  const openArtifact = (artifact: DeckArtifactSummary) => {
    if (!artifact.previewable || artifact.kind !== "markdown") return;
    setPreviewArtifact(artifact);
    setArtifactOpen(true);
    selectArtifact(artifact.id);
  };

  const closePreview = () => {
    setArtifactOpen(false);
    closeArtifact();
  };

  const toggleSlide = (slideId: string) => {
    setSelectedSlideIds((selected) => selected.includes(slideId)
      ? selected.filter((value) => value !== slideId)
      : [...selected, slideId]);
  };

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed || !job || !state.actions.canMessage || state.commandPending || job.revision < 1) return;
    void sendMessage({
      instruction: trimmed,
      ...(currentSlideId ? { currentSlideId } : {}),
      ...(selectedSlideIds.length ? { slideIds: selectedSlideIds } : {}),
      expectedRevision: job.revision,
    });
  };

  const previewJob: DeckPreviewJob | null = job ? {
    id: job.id,
    revision: job.revision,
    slideIds,
  } : null;

  return (
    <main className="deck-agent-shell">
      <header className="deck-agent-topbar">
        <button
          type="button"
          className="deck-agent-icon-button"
          aria-label="返回工作台"
          title="返回工作台"
          onClick={onExit}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <div className="deck-agent-topbar__title">
          <strong>{job?.title ?? "HTML 幻灯片任务"}</strong>
          <span className={`deck-agent-status is-${state.status ?? "loading"}`}>{statusLabel(state.status)}</span>
        </div>
        <div className="deck-agent-topbar__commands">
          {state.actions.canCancel && (
            <button
              type="button"
              className="deck-agent-command"
              aria-label="取消任务"
              disabled={state.commandPending}
              onClick={() => void cancel()}
            >
              <Square size={14} aria-hidden="true" />取消
            </button>
          )}
          {state.actions.canRetry && (
            <button
              type="button"
              className="deck-agent-command"
              aria-label="重试任务"
              disabled={state.commandPending}
              onClick={() => void retry()}
            >
              <RotateCcw size={15} aria-hidden="true" />重试
            </button>
          )}
          {state.actions.canUndo && (
            <button
              type="button"
              className="deck-agent-icon-button"
              aria-label="撤销上一版"
              title="撤销上一版"
              disabled={state.commandPending}
              onClick={() => void undo()}
            >
              <Undo2 size={17} aria-hidden="true" />
            </button>
          )}
          {state.actions.canDownload && job && deckArtifact && (
            <a
              className="deck-agent-icon-button"
              href={artifactUrl(job.id, deckArtifact.id, { download: true })}
              aria-label="下载 HTML 演示"
              title="下载 HTML 演示"
              download={deckArtifact.filename}
            >
              <Download size={17} aria-hidden="true" />
            </a>
          )}
        </div>
      </header>

      <div className="deck-agent-workspace">
        <section className="deck-agent-timeline" ref={timelineRef} aria-label="Agent 任务时间线">
          <div className="deck-agent-timeline__inner">
            <AgentMessage
              initialRequest={effectiveRequest}
              events={state.events}
              fallbackTitle={job?.title}
            />

            {state.loading || !job ? (
              <p className="deck-agent-empty" role="status">正在恢复任务…</p>
            ) : (
              <div className="deck-agent-steps">
                {steps.map((step) => (
                  <AgentStep
                    key={step.key}
                    step={step}
                    onArtifact={openArtifact}
                    onRetry={() => void retry()}
                  />
                ))}
              </div>
            )}

            {state.transportError && (
              <div className="deck-agent-notice is-warning" role="alert">
                <p>{state.transportError}</p>
                <button type="button" className="deck-agent-inline-command" onClick={reconnect}>
                  <RefreshCw size={15} aria-hidden="true" />重新连接
                </button>
              </div>
            )}

            {state.commandError && specialNewJobError(state.commandError) ? (
              <div className="deck-agent-notice is-warning" role="alert">
                <p>这项修改会改变整套叙事，需要新建任务。当前版本和已发布修改会保留。</p>
                <button type="button" className="deck-agent-inline-command" onClick={onExit}>返回新建任务</button>
              </div>
            ) : state.commandError ? (
              <div className="deck-agent-notice is-error" role="alert"><p>{state.commandError}</p></div>
            ) : null}
          </div>
        </section>

        <section className="deck-agent-preview-pane" aria-label="任务产物">
          {canShowDeck && previewJob && deckArtifact ? (
            <>
              <DeckPreview
                job={previewJob}
                artifact={deckArtifact}
                currentSlideId={currentSlideId}
                onSlideChange={setCurrentSlideId}
              />
              {state.actions.canMessage && (
                <form className="deck-agent-edit" onSubmit={submitEdit}>
                  <div className="deck-agent-edit__heading">
                    <strong>修改演示</strong>
                    <span>当前页 {currentSlideId ?? "未识别"}</span>
                  </div>
                  {!!slideIds.length && (
                    <details className="deck-agent-page-selection">
                      <summary>选择明确页面</summary>
                      <fieldset>
                        <legend>修改范围</legend>
                        {slideIds.map((slideId, index) => (
                          <label key={slideId}>
                            <input
                              type="checkbox"
                              checked={selectedSlideIds.includes(slideId)}
                              onChange={() => toggleSlide(slideId)}
                            />
                            第 {index + 1} 页
                          </label>
                        ))}
                      </fieldset>
                    </details>
                  )}
                  <div className="deck-agent-edit__composer">
                    <textarea
                      value={instruction}
                      onChange={(event) => setInstruction(event.target.value)}
                      aria-label="修改要求"
                      placeholder="描述要调整的内容、数据重点或视觉方向"
                      maxLength={4_000}
                      disabled={state.commandPending}
                    />
                    <button
                      type="submit"
                      className="deck-agent-send"
                      aria-label="发送修改"
                      title="发送修改"
                      disabled={!instruction.trim() || state.commandPending || job.revision < 1}
                    >
                      <Send size={17} aria-hidden="true" />
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <div className={`deck-agent-preview-state is-${state.status ?? "loading"}`}>
              <span aria-hidden="true"><RefreshCw className={state.status && !["failed", "cancelled"].includes(state.status) ? "deck-agent-spin" : ""} size={20} /></span>
              <strong>{state.status === "failed" ? "生成未完成" : state.status === "cancelled" ? "任务已取消" : "HTML 演示正在生成"}</strong>
              <p>{state.status === "failed" ? "已完成的内容产物仍可在时间线中查看。" : "当前步骤和产物会在左侧持续更新。"}</p>
            </div>
          )}
        </section>
      </div>

      <ArtifactPreview
        open={artifactOpen}
        jobId={job?.id ?? jobId ?? ""}
        artifact={previewArtifact}
        revision={job?.revision ?? state.revision}
        timelineRef={timelineRef}
        onClose={closePreview}
      />
    </main>
  );
}
