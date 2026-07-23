import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  cancelDeckJob,
  createDeckJob,
  getDeckJob,
  retryDeckJob,
  sendDeckMessage,
  streamDeckJobEvents,
  undoDeckRevision,
} from "./api";
import {
  createDeckJobState,
  isTerminalDeckJobStatus,
  reduceDeckJob,
  type DeckJobState,
} from "./jobReducer";
import { readDeckJobId, replaceDeckJobId } from "./jobLocation";
import type { DeckEditRequest, DeckJobSnapshot } from "./types";

export interface UseDeckAgentJobResult {
  state: DeckJobState;
  create: (request: unknown) => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
  sendMessage: (request: DeckEditRequest) => Promise<void>;
  undo: () => Promise<void>;
  selectArtifact: (artifactId: string) => void;
  closeArtifact: () => void;
  reconnect: () => void;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = window.setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

export function useDeckAgentJob(): UseDeckAgentJobResult {
  const [initialJobId] = useState(() => readDeckJobId());
  const [state, dispatch] = useReducer(
    reduceDeckJob,
    initialJobId,
    (jobId) => createDeckJobState(null, jobId),
  );
  const [reconnectVersion, setReconnectVersion] = useState(0);
  const lastSeqRef = useRef(0);
  const cursorJobIdRef = useRef<string | null>(null);
  const transportControllerRef = useRef<AbortController | null>(null);
  const restorationControllerRef = useRef<AbortController | null>(null);
  const artifactRefreshControllerRef = useRef<AbortController | null>(null);
  const commandControllersRef = useRef(new Set<AbortController>());

  if (cursorJobIdRef.current !== state.jobId) {
    cursorJobIdRef.current = state.jobId;
    lastSeqRef.current = state.lastSeq;
  } else {
    lastSeqRef.current = Math.max(lastSeqRef.current, state.lastSeq);
  }

  useEffect(() => {
    if (!initialJobId) return;
    const controller = new AbortController();
    restorationControllerRef.current = controller;
    dispatch({ type: "load-job", jobId: initialJobId });
    void getDeckJob(initialJobId, controller.signal)
      .then((job) => {
        if (!controller.signal.aborted) dispatch({ type: "snapshot", job });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({ type: "command-error", error: toMessage(error) });
        }
      });
    return () => {
      controller.abort();
      if (restorationControllerRef.current === controller) {
        restorationControllerRef.current = null;
      }
    };
  }, [initialJobId]);

  const jobId = state.job?.id ?? null;
  const terminal = isTerminalDeckJobStatus(state.status);
  const terminalHistoryComplete = terminal
    && state.lastSeq >= (state.job?.lastSeq ?? 0);

  useEffect(() => {
    if (!jobId || terminalHistoryComplete) return;
    const controller = new AbortController();
    let stopped = false;
    transportControllerRef.current = controller;

    const refreshSnapshot = () => {
      artifactRefreshControllerRef.current?.abort();
      const refreshController = new AbortController();
      artifactRefreshControllerRef.current = refreshController;
      void getDeckJob(jobId, refreshController.signal)
        .then((job) => {
          if (refreshController.signal.aborted || cursorJobIdRef.current !== jobId) return;
          dispatch({ type: "server-refreshed", job });
        })
        .catch((error: unknown) => {
          if (!refreshController.signal.aborted && cursorJobIdRef.current === jobId) {
            dispatch({ type: "transport-error", error: toMessage(error) });
          }
        })
        .finally(() => {
          if (artifactRefreshControllerRef.current === refreshController) {
            artifactRefreshControllerRef.current = null;
          }
        });
    };

    void (async () => {
      let delayMs = 250;
      while (!stopped && !controller.signal.aborted) {
        try {
          let reachedTerminal = false;
          await streamDeckJobEvents(
            jobId,
            lastSeqRef.current,
            controller.signal,
            (event) => {
              if (event.jobId !== jobId || event.seq <= lastSeqRef.current) return;
              lastSeqRef.current = event.seq;
              reachedTerminal ||= isTerminalDeckJobStatus(event.stage);
              dispatch({ type: "event", event });
              if (event.type === "artifact"
                || event.type === "revision"
                || isTerminalDeckJobStatus(event.stage)) refreshSnapshot();
            },
          );
          if (reachedTerminal || stopped || controller.signal.aborted) break;
          await abortableDelay(delayMs, controller.signal);
          delayMs = 250;
        } catch (error: unknown) {
          if (stopped || controller.signal.aborted) break;
          dispatch({ type: "transport-error", error: toMessage(error) });
          try {
            await abortableDelay(delayMs, controller.signal);
          } catch {
            break;
          }
          delayMs = Math.min(delayMs * 2, 3_000);
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
      if (transportControllerRef.current === controller) {
        transportControllerRef.current = null;
      }
    };
  }, [jobId, terminalHistoryComplete, reconnectVersion]);

  useEffect(() => () => {
    artifactRefreshControllerRef.current?.abort();
    artifactRefreshControllerRef.current = null;
  }, [jobId]);

  useEffect(() => () => {
    restorationControllerRef.current?.abort();
    transportControllerRef.current?.abort();
    artifactRefreshControllerRef.current?.abort();
    for (const controller of commandControllersRef.current) controller.abort();
    commandControllersRef.current.clear();
  }, []);

  const runCommand = useCallback(async (
    operation: (signal: AbortSignal) => Promise<DeckJobSnapshot>,
    afterSuccess?: (job: DeckJobSnapshot) => void,
  ): Promise<void> => {
    const controller = new AbortController();
    commandControllersRef.current.add(controller);
    dispatch({ type: "command-start" });
    try {
      const job = await operation(controller.signal);
      if (controller.signal.aborted) return;
      afterSuccess?.(job);
      dispatch({ type: "snapshot", job });
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        dispatch({ type: "command-error", error: toMessage(error) });
      }
    } finally {
      commandControllersRef.current.delete(controller);
    }
  }, []);

  const create = useCallback((request: unknown) => runCommand(
    (signal) => createDeckJob(request, signal),
    (job) => {
      restorationControllerRef.current?.abort();
      transportControllerRef.current?.abort();
      replaceDeckJobId(job.id);
    },
  ), [runCommand]);

  const cancel = useCallback(async () => {
    if (!jobId) {
      dispatch({ type: "command-error", error: "No deck job is selected" });
      return;
    }
    await runCommand(
      (signal) => cancelDeckJob(jobId, signal),
      () => transportControllerRef.current?.abort(),
    );
  }, [jobId, runCommand]);

  const retry = useCallback(async () => {
    if (!jobId) {
      dispatch({ type: "command-error", error: "No deck job is selected" });
      return;
    }
    await runCommand((signal) => retryDeckJob(jobId, signal));
  }, [jobId, runCommand]);

  const sendMessage = useCallback(async (request: DeckEditRequest) => {
    if (!jobId) {
      dispatch({ type: "command-error", error: "No deck job is selected" });
      return;
    }
    await runCommand((signal) => sendDeckMessage(jobId, request, signal));
  }, [jobId, runCommand]);

  const undo = useCallback(async () => {
    if (!jobId) {
      dispatch({ type: "command-error", error: "No deck job is selected" });
      return;
    }
    await runCommand((signal) => undoDeckRevision(jobId, state.revision, signal));
  }, [jobId, runCommand, state.revision]);

  const selectArtifact = useCallback((artifactId: string) => {
    dispatch({ type: "select-artifact", artifactId });
  }, []);

  const closeArtifact = useCallback(() => {
    dispatch({ type: "close-artifact" });
  }, []);

  const reconnect = useCallback(() => {
    dispatch({ type: "clear-transport-error" });
    setReconnectVersion((version) => version + 1);
  }, []);

  return {
    state,
    create,
    cancel,
    retry,
    sendMessage,
    undo,
    selectArtifact,
    closeArtifact,
    reconnect,
  };
}
