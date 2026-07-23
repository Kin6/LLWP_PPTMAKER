import { assertJobTransition, JOB_STAGES, TERMINAL_JOB_STATUSES } from "./contracts.mjs";
import { publishDeck as publishDeckArtifact } from "./stages/publish-stage.mjs";

const PIPELINE = JOB_STAGES.filter((stage) => stage !== "queued" && stage !== "repairing");

async function loadDefaultHandlers() {
  const [outline, design, calibration, build, assets, verification] = await Promise.all([
    import("./stages/outline-stage.mjs"),
    import("./stages/design-stage.mjs"),
    import("./stages/calibration-stage.mjs"),
    import("./stages/build-stage.mjs"),
    import("./stages/asset-stage.mjs"),
    import("./stages/verify-stage.mjs"),
  ]);
  return {
    outline: outline.runOutlineStage,
    design: design.runDesignStage,
    calibrating: calibration.runCalibrationStage,
    building: build.runBuildStage,
    "generating-assets": assets.runAssetStage,
    verifying: verification.runVerificationStage,
  };
}
function nextIncompleteStage(job) {
  const completed = new Set(job.checkpoints || []);
  return PIPELINE.find((stage) => !completed.has(stage));
}

function aborted(signal, error) {
  return signal?.aborted || error?.name === "AbortError";
}

export function createDeckJobOrchestrator(deps) {
  if (!deps?.store?.readJob) throw new TypeError("Deck orchestrator requires a job store");

  async function transition(jobId, status) {
    if (deps.transition) return deps.transition(jobId, status);
    const job = await deps.store.readJob(jobId);
    assertJobTransition(job.status, status);
    return deps.store.updateJob(jobId, { status });
  }

  async function checkpoint(jobId, stage, result) {
    if (deps.checkpoint) return deps.checkpoint(jobId, stage, result);
    const job = await deps.store.readJob(jobId);
    const checkpoints = [...new Set([...(job.checkpoints || []), stage])];
    return deps.store.updateJob(jobId, { checkpoints });
  }

  return {
    async run(jobId, { signal } = {}) {
      const handlers = deps.handlers || await loadDefaultHandlers();
      let job = await deps.store.readJob(jobId);

      while (!TERMINAL_JOB_STATUSES.includes(job.status)) {
        signal?.throwIfAborted();
        const stage = deps.nextIncompleteStage?.(job) || nextIncompleteStage(job);
        if (!stage) throw new Error("Deck job has no incomplete stage but is not terminal");
        if (job.status !== stage) await transition(jobId, stage);

        try {
          const handler = handlers[stage];
          if (typeof handler !== "function") throw new Error(`No deck handler for stage ${stage}`);
          const result = await handler({
            ...deps,
            jobId,
            revisionId: "working",
            signal,
            transition,
          });
          await checkpoint(jobId, stage, result);

          if (stage === "verifying") {
            const publisher = deps.publishDeck || publishDeckArtifact;
            await publisher({ ...deps, jobId, renderer: deps.renderer, signal, result });
            await transition(jobId, result.status);
          }
        } catch (error) {
          if (aborted(signal, error)) {
            await transition(jobId, "cancelled");
          } else if (deps.fail) {
            await deps.fail(jobId, stage, error);
          } else {
            const current = await deps.store.readJob(jobId);
            if (!TERMINAL_JOB_STATUSES.includes(current.status)) {
              await deps.store.updateJob(jobId, { status: "failed", failedStage: stage, error: error instanceof Error ? error.message : String(error) });
            }
          }
          break;
        }
        job = await deps.store.readJob(jobId);
      }

      return deps.store.readJob(jobId);
    },
  };
}
