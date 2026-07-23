import type {
  DeckArtifactSummary,
  DeckJobEvent,
  DeckJobSnapshot,
  DeckJobStatus,
} from "./types";

type DeckJobActions = DeckJobSnapshot["actions"];

export interface DeckJobStageGroup {
  stage: DeckJobStatus;
  status: DeckJobEvent["status"];
  events: DeckJobEvent[];
}

export interface DeckJobState {
  jobId: string | null;
  job: DeckJobSnapshot | null;
  status: DeckJobStatus | null;
  events: DeckJobEvent[];
  stageGroups: DeckJobStageGroup[];
  artifacts: DeckArtifactSummary[];
  selectedArtifact: DeckArtifactSummary | null;
  lastSeq: number;
  revision: number;
  progress: DeckJobSnapshot["progress"];
  actions: DeckJobActions;
  loading: boolean;
  commandPending: boolean;
  commandError: string | null;
  transportError: string | null;
}

export type DeckJobAction =
  | { type: "load-job"; jobId: string }
  | { type: "snapshot"; job: DeckJobSnapshot }
  | { type: "artifacts-refreshed"; jobId: string; artifacts: DeckArtifactSummary[] }
  | { type: "event"; event: DeckJobEvent }
  | { type: "command-start" }
  | { type: "command-error"; error: string }
  | { type: "transport-error"; error: string }
  | { type: "clear-transport-error" }
  | { type: "select-artifact"; artifactId: string }
  | { type: "close-artifact" }
  | { type: "clear" };

const EMPTY_ACTIONS: DeckJobActions = {
  canCancel: false,
  canRetry: false,
  canMessage: false,
  canUndo: false,
  canDownload: false,
};

const TERMINAL_STATUSES = new Set<DeckJobStatus>([
  "ready",
  "needs-review",
  "failed",
  "cancelled",
]);

export function isTerminalDeckJobStatus(
  status: DeckJobStatus | null | undefined,
): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

function copyJob(job: DeckJobSnapshot): DeckJobSnapshot {
  return {
    ...job,
    progress: { ...job.progress },
    artifacts: job.artifacts.map((artifact) => ({ ...artifact })),
    actions: { ...job.actions },
  };
}

export function createDeckJobState(
  job: DeckJobSnapshot | null = null,
  pendingJobId: string | null = null,
): DeckJobState {
  const copied = job ? copyJob(job) : null;
  return {
    jobId: copied?.id ?? pendingJobId,
    job: copied,
    status: copied?.status ?? null,
    events: [],
    stageGroups: [],
    artifacts: copied?.artifacts ?? [],
    selectedArtifact: null,
    // A snapshot carries the server log watermark. The client cursor starts at
    // zero so a fresh or restored view can replay its durable timeline.
    lastSeq: 0,
    revision: copied?.revision ?? 0,
    progress: copied?.progress ?? { completed: 0, total: 0 },
    actions: copied?.actions ?? { ...EMPTY_ACTIONS },
    loading: copied == null && pendingJobId != null,
    commandPending: false,
    commandError: null,
    transportError: null,
  };
}

export const initialDeckJobState = createDeckJobState();

function groupEvents(events: DeckJobEvent[]): DeckJobStageGroup[] {
  const groups = new Map<DeckJobStatus, DeckJobStageGroup>();
  for (const event of events) {
    const existing = groups.get(event.stage);
    if (existing) {
      existing.events.push(event);
      existing.status = event.status;
    } else {
      groups.set(event.stage, {
        stage: event.stage,
        status: event.status,
        events: [event],
      });
    }
  }
  return [...groups.values()];
}

function actionsFor(
  status: DeckJobStatus,
  revision: number,
  artifacts: DeckArtifactSummary[],
): DeckJobActions {
  const editable = status === "ready" || status === "needs-review";
  return {
    canCancel: !isTerminalDeckJobStatus(status),
    canRetry: status === "failed" || status === "cancelled" || status === "needs-review",
    canMessage: editable,
    canUndo: editable && revision > 0,
    canDownload: editable && artifacts.some((artifact) => artifact.downloadable),
  };
}

function withSnapshot(state: DeckJobState, input: DeckJobSnapshot): DeckJobState {
  const job = copyJob(input);
  if (state.jobId !== job.id) return createDeckJobState(job);

  job.lastSeq = Math.max(job.lastSeq, state.job?.lastSeq ?? 0, state.lastSeq);
  const selectedArtifact = state.selectedArtifact
    ? job.artifacts.find((artifact) => artifact.id === state.selectedArtifact?.id) ?? null
    : null;
  return {
    ...state,
    job,
    jobId: job.id,
    status: job.status,
    artifacts: job.artifacts,
    selectedArtifact,
    lastSeq: state.lastSeq,
    revision: job.revision,
    progress: job.progress,
    actions: job.actions,
    loading: false,
    commandPending: false,
    commandError: null,
    transportError: null,
  };
}

function withEvent(state: DeckJobState, event: DeckJobEvent): DeckJobState {
  if (!state.job || event.jobId !== state.job.id || event.seq <= state.lastSeq) return state;

  const events = [...state.events, event].sort((left, right) => left.seq - right.seq);
  const revision = event.revision ?? state.revision;
  const progress = event.progress ? { ...event.progress } : state.progress;
  const actions = actionsFor(event.stage, revision, state.artifacts);
  const job: DeckJobSnapshot = {
    ...state.job,
    status: event.stage,
    lastSeq: Math.max(state.job.lastSeq, event.seq),
    revision,
    progress,
    actions,
    updatedAt: event.createdAt,
    ...(event.error ? { error: event.error.message, failedStage: event.stage } : {}),
  };
  return {
    ...state,
    job,
    status: event.stage,
    events,
    stageGroups: groupEvents(events),
    lastSeq: event.seq,
    revision,
    progress,
    actions,
    loading: false,
    transportError: null,
  };
}

function withRefreshedArtifacts(
  state: DeckJobState,
  jobId: string,
  input: DeckArtifactSummary[],
): DeckJobState {
  if (!state.job || state.job.id !== jobId) return state;
  const artifacts = input.map((artifact) => ({ ...artifact }));
  const canDownload = (state.status === "ready" || state.status === "needs-review")
    && artifacts.some((artifact) => artifact.downloadable);
  const actions = { ...state.actions, canDownload };
  const selectedArtifact = state.selectedArtifact
    ? artifacts.find((artifact) => artifact.id === state.selectedArtifact?.id) ?? null
    : null;
  return {
    ...state,
    job: { ...state.job, artifacts, actions },
    artifacts,
    selectedArtifact,
    actions,
  };
}

export function reduceDeckJob(
  state: DeckJobState,
  action: DeckJobAction,
): DeckJobState {
  switch (action.type) {
    case "load-job":
      return createDeckJobState(null, action.jobId);
    case "snapshot":
      return withSnapshot(state, action.job);
    case "artifacts-refreshed":
      return withRefreshedArtifacts(state, action.jobId, action.artifacts);
    case "event":
      return withEvent(state, action.event);
    case "command-start":
      return { ...state, commandPending: true, commandError: null };
    case "command-error":
      return { ...state, commandPending: false, commandError: action.error };
    case "transport-error":
      return { ...state, transportError: action.error };
    case "clear-transport-error":
      return { ...state, transportError: null };
    case "select-artifact":
      return {
        ...state,
        selectedArtifact: state.artifacts.find((artifact) => artifact.id === action.artifactId) ?? null,
      };
    case "close-artifact":
      return { ...state, selectedArtifact: null };
    case "clear":
      return createDeckJobState();
  }
}

export const deckJobReducer = reduceDeckJob;
