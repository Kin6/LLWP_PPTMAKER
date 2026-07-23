import { Bot, UserRound } from "lucide-react";
import type { DeckJobEvent } from "./types";

export interface AgentInitialRequestDetails {
  topic?: string;
  audience?: string;
  slideCount?: number;
  pageCount?: number;
  summary?: string;
  text?: string;
  [key: string]: unknown;
}

export type AgentInitialRequest = string | AgentInitialRequestDetails;

export interface AgentMessageProps {
  initialRequest: AgentInitialRequest;
  events: DeckJobEvent[];
  fallbackTitle?: string;
}

function finitePageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 50
    ? value
    : undefined;
}

export function requestPageCount(request: AgentInitialRequest): number | undefined {
  if (typeof request === "string") {
    const match = /(?:^|\D)(\d{1,2})\s*页/.exec(request);
    return match ? finitePageCount(Number(match[1])) : undefined;
  }
  return finitePageCount(request.slideCount) ?? finitePageCount(request.pageCount);
}

function requestText(request: AgentInitialRequest): string {
  if (typeof request === "string") return request.trim() || "创建 HTML 幻灯片";
  if (typeof request.summary === "string" && request.summary.trim()) return request.summary.trim();
  if (typeof request.text === "string" && request.text.trim()) return request.text.trim();
  const details = [
    typeof request.topic === "string" && request.topic.trim() ? request.topic.trim() : undefined,
    typeof request.audience === "string" && request.audience.trim() ? `受众：${request.audience.trim()}` : undefined,
    requestPageCount(request) ? `${requestPageCount(request)} 页` : undefined,
  ].filter(Boolean);
  return details.join(" · ") || "创建 HTML 幻灯片";
}

function fallbackMessage(request: AgentInitialRequest, fallbackTitle?: string): string {
  const details = typeof request === "string" ? {} : request;
  const topic = typeof details.topic === "string" && details.topic.trim()
    ? `“${details.topic.trim()}”`
    : fallbackTitle ? `“${fallbackTitle}”` : "这份材料";
  const audience = typeof details.audience === "string" && details.audience.trim()
    ? details.audience.trim()
    : "目标听众";
  const count = requestPageCount(request);
  return `收到。我会把${topic}整理成面向${audience}的${count ? ` ${count} 页` : ""} HTML 演示，先生成可查看的 Markdown 内容大纲，然后自动继续设计和检查。`;
}

export function AgentMessage({ initialRequest, events, fallbackTitle }: AgentMessageProps) {
  const messages = events.filter((event) => event.type === "message" && event.message);

  return (
    <div className="deck-agent-conversation" aria-label="任务对话">
      <article className="deck-agent-message is-user">
        <span className="deck-agent-message__avatar" aria-hidden="true"><UserRound size={15} /></span>
        <div>
          <span className="deck-agent-message__author">你</span>
          <p>{requestText(initialRequest)}</p>
        </div>
      </article>
      {messages.length ? messages.map((event) => (
        <article className="deck-agent-message is-agent" key={event.seq}>
          <span className="deck-agent-message__avatar" aria-hidden="true"><Bot size={15} /></span>
          <div>
            <span className="deck-agent-message__author">LLWP Agent</span>
            <p>{event.message}</p>
          </div>
        </article>
      )) : (
        <article className="deck-agent-message is-agent">
          <span className="deck-agent-message__avatar" aria-hidden="true"><Bot size={15} /></span>
          <div>
            <span className="deck-agent-message__author">LLWP Agent</span>
            <p>{fallbackMessage(initialRequest, fallbackTitle)}</p>
          </div>
        </article>
      )}
    </div>
  );
}
