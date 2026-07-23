import { useEffect, useId, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  FileText,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import type { DeckArtifactSummary, DeckJobEvent } from "./types";

export interface AgentStepModel {
  key: string;
  title: string;
  status: DeckJobEvent["status"];
  message?: string;
  progress?: DeckJobEvent["progress"];
  artifacts: DeckArtifactSummary[];
  canRetry: boolean;
  defaultExpanded?: boolean;
  eventSeq?: number;
}

export interface AgentStepProps {
  step: AgentStepModel;
  onArtifact: (artifact: DeckArtifactSummary) => void;
  onRetry: () => void;
}

function StepStatusIcon({ status }: { status: AgentStepModel["status"] }) {
  const props = { size: 15, strokeWidth: 2.2, "aria-hidden": true } as const;
  if (status === "done") return <Check {...props} />;
  if (status === "running") return <LoaderCircle className="deck-agent-spin" {...props} />;
  if (status === "failed") return <CircleAlert {...props} />;
  if (status === "cancelled") return <Ban {...props} />;
  return <Circle {...props} />;
}

export function AgentStep({ step, onArtifact, onRetry }: AgentStepProps) {
  const [expanded, setExpanded] = useState(
    step.defaultExpanded ?? (step.status === "running" || step.status === "failed"),
  );
  const previousStatus = useRef(step.status);
  const reactId = useId();
  const panelId = `deck-agent-step-${reactId.replace(/:/g, "")}`;

  useEffect(() => {
    if (previousStatus.current !== step.status && step.status === "failed") setExpanded(true);
    previousStatus.current = step.status;
  }, [step.status]);

  return (
    <section
      className={`deck-agent-step is-${step.status}`}
      {...(step.eventSeq ? { "data-event-seq": step.eventSeq } : {})}
    >
      <span className="deck-agent-step__status" aria-hidden="true">
        <StepStatusIcon status={step.status} />
      </span>
      <div className="deck-agent-step__content">
        <button
          type="button"
          className="deck-agent-step__toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{step.title}</span>
          <ChevronDown className="deck-agent-step__chevron" size={16} aria-hidden="true" />
        </button>
        {expanded && (
          <div className="deck-agent-step__body" id={panelId}>
            {step.message && <p>{step.message}</p>}
            {step.progress && (
              <span className="deck-agent-step__progress" aria-live="polite">
                {step.progress.completed} / {step.progress.total}
              </span>
            )}
            {!!step.artifacts.length && (
              <div className="deck-agent-step__artifacts">
                {step.artifacts.map((artifact) => (
                  <button
                    type="button"
                    className="deck-agent-artifact"
                    key={`${artifact.id}-${artifact.revision ?? 0}`}
                    onClick={() => onArtifact(artifact)}
                  >
                    <span className="deck-agent-artifact__icon" aria-hidden="true">
                      <FileText size={15} />
                    </span>
                    <span>{artifact.filename}</span>
                  </button>
                ))}
              </div>
            )}
            {step.status === "failed" && step.canRetry && (
              <button type="button" className="deck-agent-inline-command" onClick={onRetry}>
                <RotateCcw size={15} aria-hidden="true" />
                重试此步骤
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
