import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  assertResumeTransition,
  createJobRequestSchema,
  deckJobSnapshotSchema,
  JOB_STAGES,
  TERMINAL_JOB_STATUSES,
} from "./contracts.mjs";
import { DEFAULT_QUOTAS } from "./artifact-store.mjs";
import { HttpError } from "../shared/errors.mjs";

const PIPELINE = JOB_STAGES.filter((stage) => stage !== "queued" && stage !== "repairing");
const RETRYABLE = new Set(["failed", "cancelled", "needs-review"]);
const SOURCE_KINDS = new Set(["docx", "pdf", "pptx", "xlsx", "text", "image"]);
const EXTRACTION_METHODS = new Set(["native", "ocr"]);
const BLOCK_TYPES = new Set(["heading", "paragraph", "table", "image", "notice"]);
const STYLE_IDS = new Set(["blank", "product-calm", "consulting-grid", "editorial-tech", "cinematic-dark"]);
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;

function httpError(status, message, options) {
  return new HttpError(status, message, options);
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function defined(value, key, normalized) {
  return value === undefined ? {} : { [key]: normalized };
}

function normalizeIndex(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function normalizedImage(image, index) {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    throw httpError(400, "Uploaded images must be objects");
  }
  const match = IMAGE_DATA_URL.exec(String(image.dataUrl || ""));
  if (!match || match[2].length % 4 !== 0) {
    throw httpError(400, "Uploaded images must use normalized PNG, JPEG, or WebP data URLs");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.toString("base64") !== match[2]) {
    throw httpError(400, "Uploaded image base64 is invalid");
  }
  if (bytes.length > DEFAULT_QUOTAS.image) {
    throw httpError(413, "Uploaded image quota limit exceeded");
  }
  return {
    name: cleanText(image.name, 200) || `image-${index + 1}`,
    dataUrl: `data:${match[1].toLowerCase()};base64,${match[2]}`,
    summary: cleanText(image.summary, 2_000),
  };
}

function normalizedBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw httpError(400, "Source blocks must be objects");
  }
  const source = block.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw httpError(400, "Source block provenance is required");
  }
  if (typeof block.id !== "string" || typeof source.blockId !== "string" || block.id !== source.blockId) {
    throw httpError(400, "Source block id must match its provenance blockId");
  }
  const id = cleanText(block.id, 160);
  const sourceBlockId = cleanText(source.blockId, 160);
  if (!id) {
    throw httpError(400, "Source block id must match its provenance blockId");
  }
  if (!BLOCK_TYPES.has(block.type)) throw httpError(400, "Unsupported source block type");
  if (!SOURCE_KINDS.has(source.kind)) throw httpError(400, "Unsupported source kind");
  if (!EXTRACTION_METHODS.has(source.extraction)) throw httpError(400, "Unsupported source extraction method");

  const rows = block.rows === undefined ? undefined : Array.isArray(block.rows)
    ? block.rows.map((row) => {
        if (!Array.isArray(row)) throw httpError(400, "Source table rows must be arrays");
        return row.map((cell) => cleanText(cell, 10_000));
      })
    : (() => { throw httpError(400, "Source table rows must be arrays"); })();
  const sectionPath = source.sectionPath === undefined ? undefined : Array.isArray(source.sectionPath)
    ? source.sectionPath.map((item) => cleanText(item, 500)).filter(Boolean)
    : (() => { throw httpError(400, "Source sectionPath must be an array"); })();

  return {
    id,
    type: block.type,
    ...defined(block.text, "text", cleanText(block.text, 100_000)),
    ...defined(block.level, "level", Number(block.level)),
    ...defined(rows, "rows", rows),
    ...defined(block.assetId, "assetId", cleanText(block.assetId, 160)),
    source: {
      blockId: sourceBlockId,
      attachmentId: cleanText(source.attachmentId, 160),
      filename: cleanText(source.filename, 500),
      kind: source.kind,
      extraction: source.extraction,
      ...defined(normalizeIndex(source.page), "page", normalizeIndex(source.page)),
      ...defined(sectionPath, "sectionPath", sectionPath),
      ...defined(normalizeIndex(source.paragraphIndex), "paragraphIndex", normalizeIndex(source.paragraphIndex)),
      ...defined(normalizeIndex(source.tableIndex), "tableIndex", normalizeIndex(source.tableIndex)),
      ...defined(normalizeIndex(source.imageIndex), "imageIndex", normalizeIndex(source.imageIndex)),
      ...defined(source.confidence, "confidence", Number(source.confidence)),
      ...defined(source.lowConfidence, "lowConfidence", Boolean(source.lowConfidence)),
    },
  };
}

function requestSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw httpError(400, "Deck job input must be JSON serializable");
  }
}

export function normalizeDeckJobInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(400, "Deck job input must be an object");
  }
  const rawSource = raw.source;
  if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) {
    throw httpError(400, "Deck source is required");
  }
  for (const [name, value, limit] of [
    ["textInput", rawSource.textInput, 2_000_000],
    ["tableInput", rawSource.tableInput, 1_000_000],
    ["imageBrief", rawSource.imageBrief, 10_000],
  ]) {
    if (String(value ?? "").length > limit) throw httpError(413, `${name} quota limit exceeded`);
  }

  const rawBlocks = rawSource.sourceBlocks ?? [];
  if (!Array.isArray(rawBlocks)) throw httpError(400, "sourceBlocks must be an array");
  if (rawBlocks.length > 20_000 || requestSize(rawBlocks) > DEFAULT_QUOTAS.json) {
    throw httpError(413, "Source block quota limit exceeded");
  }
  const sourceBlocks = rawBlocks.map(normalizedBlock);
  const ids = sourceBlocks.map((block) => block.id);
  if (new Set(ids).size !== ids.length) throw httpError(400, "Source block IDs must be unique");

  const rawImages = rawSource.images ?? [];
  if (!Array.isArray(rawImages)) throw httpError(400, "images must be an array");
  if (rawImages.length > 50) throw httpError(413, "Uploaded image count quota exceeded");
  const images = rawImages.map(normalizedImage);

  const rawOptions = raw.options || {};
  const imageEnabled = Boolean(rawOptions.imageEnabled);
  const rawImageCount = Number(rawOptions.imageCount);
  const slideCount = Number(rawSource.slideCount);
  const normalized = {
    source: {
      topic: cleanText(rawSource.topic, 500) || "未命名演示文稿",
      audience: cleanText(rawSource.audience, 500),
      slideCount,
      textInput: cleanText(rawSource.textInput, 2_000_000),
      tableInput: cleanText(rawSource.tableInput, 1_000_000),
      imageBrief: cleanText(rawSource.imageBrief, 10_000),
      styleId: STYLE_IDS.has(rawSource.styleId) ? rawSource.styleId : "product-calm",
      images,
      sourceBlocks,
    },
    options: {
      imageEnabled,
      imageCount: imageEnabled && rawImageCount === 0 ? slideCount : rawImageCount,
      imageQuality: rawOptions.imageQuality,
      imageTimeoutMs: Number(rawOptions.imageTimeoutMs),
      imageMaxRetries: Number(rawOptions.imageMaxRetries),
    },
  };
  try {
    return createJobRequestSchema.parse(normalized);
  } catch (error) {
    if (error instanceof z.ZodError) throw httpError(400, "Deck job input is invalid", { cause: error });
    throw error;
  }
}

function earliestIncomplete(job) {
  const completed = new Set(job.checkpoints || []);
  return PIPELINE.find((stage) => !completed.has(stage));
}

function retryStage(job) {
  if (job.status === "needs-review") return "verifying";
  if (PIPELINE.includes(job.failedStage)) return job.failedStage;
  return earliestIncomplete(job) || "verifying";
}

function checkpointsBefore(job, stage) {
  const resumeIndex = PIPELINE.indexOf(stage);
  if (resumeIndex < 0) return [...(job.checkpoints || [])];
  const completed = new Set(job.checkpoints || []);
  return PIPELINE.slice(0, resumeIndex).filter((checkpoint) => completed.has(checkpoint));
}

function currentPreviewArtifact(job, artifacts) {
  if (job.revision < 1) return artifacts;
  const current = artifacts.find((artifact) => (
    artifact.kind === "html"
    && artifact.filename === "index.html"
    && artifact.revision === job.revision
  ));
  if (!current) return artifacts;
  return [
    ...artifacts.filter((artifact) => artifact !== current),
    { ...current, id: "deck-preview", stage: job.status === "needs-review" ? "repairing" : "verifying" },
  ].sort((left, right) => left.id.localeCompare(right.id));
}

export function createJobManager({
  store,
  events,
  executor,
  revisions,
  normalizeInput = normalizeDeckJobInput,
  now = () => new Date().toISOString(),
} = {}) {
  if (!store?.createJob || !store?.readJob || !store?.listArtifacts || !store?.listRecoverableJobs) {
    throw new TypeError("Job manager requires an artifact store");
  }
  if (!events?.append || !events?.readAfter) throw new TypeError("Job manager requires an event store");
  if (!executor?.start || !executor?.cancel) throw new TypeError("Job manager requires a worker executor");
  if (typeof normalizeInput !== "function") throw new TypeError("Job manager normalizeInput must be a function");
  const active = new Map();
  const activeModes = new Map();
  const cancelling = new Set();
  const lifecycleOperations = new Set();
  const startupOperations = new Set();
  let started = false;
  let startPromise;
  let accepting = true;

  async function effectiveJob(job) {
    if (!revisions?.readCurrent) return job;
    const current = await revisions.readCurrent(job.id, { optional: true });
    return current && current.number !== job.revision
      ? { ...job, revision: current.number }
      : job;
  }

  async function sourceSummary(job) {
    const input = await store.readJson?.(job.id, "job-input.json", { optional: true });
    const source = input?.source;
    const slideCount = Number(source?.slideCount);
    return {
      topic: typeof source?.topic === "string" ? source.topic : job.title,
      audience: typeof source?.audience === "string" ? source.audience : "",
      slideCount: Number.isInteger(slideCount) && slideCount >= 1 && slideCount <= 50 ? slideCount : 1,
    };
  }

  async function publicJob(job) {
    let effective = await effectiveJob(job);
    const [rawArtifacts, source] = await Promise.all([
      store.listArtifacts(effective.id),
      sourceSummary(effective),
    ]);
    const activeRun = activeModes.get(effective.id) === "run"
      ? active.get(effective.id)
      : undefined;
    if (activeRun && TERMINAL_JOB_STATUSES.includes(effective.status)) {
      await Promise.allSettled([activeRun]);
      effective = await effectiveJob(await store.readJob(effective.id));
    }
    const artifacts = currentPreviewArtifact(effective, rawArtifacts);
    const completed = TERMINAL_JOB_STATUSES.includes(effective.status)
      && !["failed", "cancelled"].includes(effective.status)
      ? PIPELINE.length
      : Math.min(PIPELINE.length, new Set(effective.checkpoints || []).size);
    const activeRevision = active.has(effective.id) && activeModes.get(effective.id) === "revision";
    return deckJobSnapshotSchema.parse({
      id: effective.id,
      title: effective.title,
      source,
      status: effective.status,
      ...(effective.failedStage ? { failedStage: effective.failedStage } : {}),
      ...(effective.error ? { error: effective.error } : {}),
      lastSeq: effective.lastSeq,
      revision: effective.revision,
      progress: { completed, total: PIPELINE.length },
      artifacts,
      actions: {
        canCancel: !TERMINAL_JOB_STATUSES.includes(effective.status)
          || (["ready", "needs-review"].includes(effective.status) && activeRevision),
        canRetry: RETRYABLE.has(effective.status) && !active.has(effective.id),
        canMessage: ["ready", "needs-review"].includes(effective.status) && !active.has(effective.id),
        canUndo: ["ready", "needs-review"].includes(effective.status) && effective.revision > 1 && !active.has(effective.id),
        canDownload: ["ready", "needs-review"].includes(effective.status) && effective.revision > 0,
      },
      createdAt: effective.createdAt,
      updatedAt: effective.updatedAt,
    });
  }

  async function recordUnexpectedFailure(jobId, error, mode) {
    if (cancelling.has(jobId)) return;
    const job = await store.readJob(jobId).catch(() => undefined);
    if (!job) return;
    const message = error instanceof Error ? error.message : String(error);
    if (mode === "revision") {
      await events.append(jobId, {
        stage: job.status,
        type: "error",
        status: "failed",
        title: "修改未能发布",
        error: { code: "REVISION_FAILED", message: message.slice(0, 2_000), retryable: false },
      });
      return;
    }
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return;
    const failedStage = PIPELINE.includes(job.status) ? job.status : retryStage(job);
    await store.updateJob(jobId, { status: "failed", failedStage, error: message.slice(0, 2_000) });
    await events.append(jobId, {
      stage: "failed",
      type: "error",
      status: "failed",
      title: "任务执行失败",
      error: { code: "JOB_EXECUTION_FAILED", message: message.slice(0, 2_000), retryable: true },
    });
    await events.append(jobId, {
      stage: "failed",
      type: "job",
      status: "failed",
      title: "任务执行失败",
    });
  }

  function launch(jobId, options, { mode = "run" } = {}) {
    if (active.has(jobId)) throw httpError(409, "Job already has an active worker");
    let pending;
    try {
      pending = Promise.resolve(executor.start(jobId, options));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const completed = pending.then(async (value) => {
      if (mode === "run") {
        const job = await store.readJob(jobId);
        if (["ready", "needs-review"].includes(job.status) && (job.failedStage || job.error)) {
          await store.updateJob(jobId, { failedStage: undefined, error: undefined });
        }
      }
      return value;
    });
    const tracked = completed.catch(async (error) => {
      await recordUnexpectedFailure(jobId, error, mode);
      throw error;
    }).finally(() => {
      if (active.get(jobId) === tracked) {
        active.delete(jobId);
        activeModes.delete(jobId);
      }
    });
    active.set(jobId, tracked);
    activeModes.set(jobId, mode);
    tracked.catch(() => {});
    return tracked;
  }

  async function start() {
    if (started) return;
    if (startPromise) return startPromise;
    accepting = true;
    startPromise = (async () => {
      for (const job of await store.listRecoverableJobs()) {
        if (!accepting) break;
        await events.readAfter(job.id, 0);
        if (active.has(job.id)) continue;
        const reconciled = await store.readJob(job.id);
        const incomplete = earliestIncomplete(reconciled);
        const resumeFrom = incomplete || "verifying";
        if (!incomplete) {
          await store.updateJob(job.id, {
            checkpoints: checkpointsBefore(reconciled, resumeFrom),
          });
        }
        if (!accepting) break;
        launch(job.id, { resumeFrom });
      }
      if (accepting) started = true;
    })();
    try {
      await startPromise;
    } finally {
      startPromise = undefined;
    }
  }

  function runLifecycleOperation(jobId, operation) {
    if (lifecycleOperations.has(jobId)) throw httpError(409, "Job already has a lifecycle operation in progress");
    lifecycleOperations.add(jobId);
    return Promise.resolve().then(operation).finally(() => lifecycleOperations.delete(jobId));
  }

  function runStartupOperation(operation) {
    let tracked;
    tracked = Promise.resolve().then(operation).finally(() => startupOperations.delete(tracked));
    startupOperations.add(tracked);
    return tracked;
  }

  async function create(raw) {
    if (!accepting) throw httpError(503, "Job manager is shutting down");
    return runStartupOperation(async () => {
      const input = normalizeInput(raw);
      const jobId = `job-${crypto.randomUUID()}`;
      const job = await store.createJob({
        jobId,
        title: input.source.topic,
        input: {
          source: {
            topic: input.source.topic,
            audience: input.source.audience,
            slideCount: input.source.slideCount,
            textInput: input.source.textInput,
            tableInput: input.source.tableInput,
            imageBrief: input.source.imageBrief,
            styleId: input.source.styleId,
          },
          options: input.options,
        },
        sourceBlocks: input.source.sourceBlocks,
      });
      await store.persistUploadedAssets(jobId, input.source.images);
      await events.append(jobId, {
        stage: "queued",
        type: "job",
        status: "queued",
        title: "已创建 HTML 幻灯片任务",
      });
      await events.append(jobId, {
        stage: "queued",
        type: "message",
        status: "done",
        title: "开始制作演示文稿",
        message: `我会把“${input.source.topic}”整理成面向${input.source.audience || "目标听众"}的 ${input.source.slideCount} 页演示，先生成可查看的 Markdown 内容大纲，然后自动进入设计。`,
      });
      if (!accepting) throw httpError(503, "Job manager is shutting down");
      launch(jobId, { resumeFrom: "outline" });
      return publicJob(await store.readJob(job.id));
    });
  }

  async function get(jobId) {
    return publicJob(await store.readJob(jobId));
  }

  async function cancel(jobId) {
    return runLifecycleOperation(jobId, async () => {
      const before = await store.readJob(jobId);
      const activeRevision = active.has(jobId) && activeModes.get(jobId) === "revision";
      if (TERMINAL_JOB_STATUSES.includes(before.status)
        && !(["ready", "needs-review"].includes(before.status) && activeRevision)) {
        throw httpError(409, "Job is not cancellable");
      }
      cancelling.add(jobId);
      try {
        await executor.cancel(jobId);
        const running = active.get(jobId);
        if (running) await Promise.allSettled([running]);
        let stopped = await store.readJob(jobId);
        if (!TERMINAL_JOB_STATUSES.includes(stopped.status)) {
          stopped = await store.updateJob(jobId, {
            status: "cancelled",
            ...(PIPELINE.includes(before.status) ? { failedStage: before.status } : {}),
            updatedAt: now(),
          });
          await events.append(jobId, {
            stage: "cancelled",
            type: "job",
            status: "cancelled",
            title: "任务已取消",
          });
          stopped = await store.readJob(jobId);
        }
        return publicJob(stopped);
      } finally {
        cancelling.delete(jobId);
      }
    });
  }

  async function retry(jobId) {
    return runLifecycleOperation(jobId, async () => {
      if (!accepting) throw httpError(503, "Job manager is shutting down");
      const job = await store.readJob(jobId);
      if (active.has(jobId)) throw httpError(409, "Job already has an active worker");
      if (!RETRYABLE.has(job.status)) throw httpError(409, "Job is not retryable");
      const resumeFrom = retryStage(job);
      try {
        assertResumeTransition(job.status, resumeFrom);
      } catch (error) {
        throw httpError(409, error.message, { cause: error });
      }
      const attempts = { ...job.attempts, [resumeFrom]: (job.attempts[resumeFrom] || 0) + 1 };
      await store.updateJob(jobId, {
        status: resumeFrom,
        failedStage: resumeFrom,
        error: undefined,
        attempts,
        checkpoints: checkpointsBefore(job, resumeFrom),
      });
      await events.append(jobId, {
        stage: resumeFrom,
        type: "job",
        status: "queued",
        title: "任务已重新排队",
      });
      launch(jobId, { resumeFrom });
      return get(jobId);
    });
  }

  async function message(jobId, request) {
    const { before, running } = await runLifecycleOperation(jobId, async () => {
      if (!accepting) throw httpError(503, "Job manager is shutting down");
      const before = await effectiveJob(await store.readJob(jobId));
      if (!["ready", "needs-review"].includes(before.status) || active.has(jobId)) {
        throw httpError(409, "Job is not available for revision");
      }
      return {
        before,
        running: launch(jobId, { type: "revision", request }, { mode: "revision" }),
      };
    });
    try {
      await running;
    } catch (error) {
      if (Number(error?.status || error?.statusCode) >= 400) throw error;
      throw httpError(409, error instanceof Error ? error.message : "Revision failed", { cause: error });
    }
    const updated = await effectiveJob(await store.readJob(jobId));
    if (updated.revision <= before.revision) {
      throw httpError(409, "Revision worker did not publish a new revision");
    }
    await events.append(jobId, {
      stage: updated.status,
      type: "revision",
      status: "done",
      title: "修改已发布",
      revision: updated.revision,
    });
    return publicJob(await store.readJob(jobId));
  }

  async function undo(jobId, request) {
    return runLifecycleOperation(jobId, async () => {
      if (!accepting) throw httpError(503, "Job manager is shutting down");
      const before = await effectiveJob(await store.readJob(jobId));
      if (!["ready", "needs-review"].includes(before.status) || active.has(jobId)) {
        throw httpError(409, "Job is not available for undo");
      }
      if (!revisions?.undo) throw httpError(503, "Revision support is unavailable");
      await revisions.undo(jobId, request);
      const updated = await effectiveJob(await store.readJob(jobId));
      if (updated.revision >= before.revision) throw httpError(409, "Undo did not select an earlier revision");
      await events.append(jobId, {
        stage: updated.status,
        type: "revision",
        status: "done",
        title: "已撤销上一版修改",
        revision: updated.revision,
      });
      return publicJob(await store.readJob(jobId));
    });
  }

  async function shutdown() {
    accepting = false;
    await Promise.allSettled([
      ...(startPromise ? [startPromise] : []),
      ...startupOperations,
    ]);
    const jobIds = [...active.keys()];
    jobIds.forEach((jobId) => cancelling.add(jobId));
    await Promise.allSettled(jobIds.map((jobId) => executor.cancel(jobId)));
    await Promise.allSettled([...active.values()]);
    jobIds.forEach((jobId) => cancelling.delete(jobId));
    await executor.shutdown?.();
    started = false;
  }

  return { start, create, get, cancel, retry, message, undo, shutdown };
}
