import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFragment, serialize } from "parse5";
import {
  isMainThread,
  parentPort,
  Worker,
} from "node:worker_threads";
import { deckEventSchema } from "./contracts.mjs";
import { validateStoredSlideHtml } from "./html-policy.mjs";
import { HttpError, JobCancelledError } from "../shared/errors.mjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const STAGE_TITLES = Object.freeze({
  outline: "整理幻灯片内容大纲并写入 Markdown",
  design: "建立单一设计方向",
  calibrating: "校准代表页面",
  building: "生成幻灯片页面",
  "generating-assets": "处理页面素材",
  verifying: "检查并发布演示文稿",
  repairing: "修复未通过检查的页面",
  ready: "演示文稿已完成",
  "needs-review": "演示文稿需要复核",
  failed: "任务执行失败",
  cancelled: "任务已取消",
});
const RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8,
});
const WORKER_EVENT_SCHEMA = deckEventSchema.omit({ seq: true, jobId: true, createdAt: true });
const ASSET_ID = /^asset-[a-z0-9-]+$/;
const ASSET_FILENAME = /^asset-[a-z0-9-]+\.(?:png|jpe?g|webp)$/;
const SLIDE_ID = /^slide-\d{2}$/;
const SLOT_ID = /^[a-z0-9-]+$/;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VISUAL_REVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["failedSlides", "designChanges"],
  properties: {
    failedSlides: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slideId", "reasons"],
        properties: {
          slideId: { type: "string" },
          reasons: { type: "array", maxItems: 8, items: { type: "string" } },
        },
      },
    },
    designChanges: { type: "array", maxItems: 12, items: { type: "string" } },
  },
});

function workerError(input) {
  const error = new Error(String(input?.message || "Deck worker failed"));
  error.name = String(input?.name || "Error");
  if (Number.isInteger(input?.status)) error.status = input.status;
  if (typeof input?.code === "string") error.code = input.code;
  return error;
}

function serializedError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
  };
}

function validateStart(jobId, options) {
  if (!JOB_ID.test(jobId)) throw new TypeError("Invalid deck worker job id");
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Deck worker options are required");
  }
  if (options.type === "revision") {
    return { type: "revision", jobId, request: options.request };
  }
  if (typeof options.resumeFrom !== "string") throw new TypeError("Deck worker resumeFrom is required");
  return { type: "run", jobId, resumeFrom: options.resumeFrom };
}

export function createWorkerExecutor({
  WorkerClass = Worker,
  workerUrl = new URL(import.meta.url),
  cancelTimeoutMs = 5_000,
  onEvent,
} = {}) {
  if (typeof WorkerClass !== "function") throw new TypeError("WorkerClass is required");
  if (!Number.isSafeInteger(cancelTimeoutMs) || cancelTimeoutMs < 1) {
    throw new TypeError("cancelTimeoutMs must be a positive integer");
  }
  if (onEvent !== undefined && typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
  const active = new Map();

  function settle(record, outcome, value) {
    if (record.settled) return;
    record.settled = true;
    active.delete(record.jobId);
    if (outcome === "resolve") record.resolve(value);
    else record.reject(value);
  }

  function finish(record, outcome, value) {
    if (record.finishPromise) return record.finishPromise;
    record.acceptingEvents = false;
    record.finishPromise = Promise.allSettled([...record.pendingEvents]).then(() => {
      settle(record, outcome, value);
    });
    return record.finishPromise;
  }

  function start(jobId, options) {
    const command = validateStart(jobId, options);
    if (active.has(jobId)) throw new HttpError(409, "Job already has an active worker");
    const worker = new WorkerClass(workerUrl, { resourceLimits: { ...RESOURCE_LIMITS } });
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const record = {
      jobId,
      worker,
      promise,
      resolve,
      reject,
      settled: false,
      cancelling: false,
      acceptingEvents: true,
      pendingEvents: new Set(),
      finishPromise: undefined,
    };
    active.set(jobId, record);

    worker.on("message", (message) => {
      if (!message || message.jobId !== jobId) return;
      if (message.type === "event") {
        const parsed = WORKER_EVENT_SCHEMA.safeParse(message.event);
        if (!parsed.success || !record.acceptingEvents) {
          worker.postMessage({ type: "event-result", jobId, requestId: message.requestId, ok: true });
          return;
        }
        let persisted;
        try {
          persisted = onEvent?.(jobId, parsed.data);
        } catch (error) {
          persisted = Promise.reject(error);
        }
        const delivery = Promise.resolve(persisted).then(
          () => worker.postMessage({ type: "event-result", jobId, requestId: message.requestId, ok: true }),
          (error) => worker.postMessage({
            type: "event-result",
            jobId,
            requestId: message.requestId,
            ok: false,
            error: serializedError(error),
          }),
        ).catch(() => {});
        record.pendingEvents.add(delivery);
        delivery.then(() => record.pendingEvents.delete(delivery));
        return;
      }
      if (message.type === "stopped") {
        finish(record, "resolve", message.result).then(
          () => Promise.resolve(worker.terminate?.()).catch(() => {}),
        );
      } else if (message.type === "error") {
        finish(record, "reject", workerError(message.error)).then(
          () => Promise.resolve(worker.terminate?.()).catch(() => {}),
        );
      }
    });
    worker.once("error", (error) => { finish(record, "reject", error); });
    worker.once("exit", (code) => {
      if (!record.settled) {
        const error = record.cancelling
          ? new JobCancelledError("Deck worker stopped during cancellation")
          : new Error(`Deck worker exited before acknowledgement (${code})`);
        finish(record, "reject", error);
      }
    });
    worker.postMessage(command);
    return promise;
  }

  async function cancel(jobId) {
    const record = active.get(jobId);
    if (!record) return;
    record.cancelling = true;
    record.acceptingEvents = false;
    record.worker.postMessage({ type: "cancel", jobId });
    let timer;
    const acknowledged = await Promise.race([
      record.promise.then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), cancelTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!acknowledged && !record.settled) {
      await record.worker.terminate();
      await finish(record, "reject", new JobCancelledError("Deck worker cancellation timed out"));
    }
    await Promise.allSettled([record.promise]);
  }

  async function shutdown() {
    await Promise.all([...active.keys()].map((jobId) => cancel(jobId)));
  }

  return { start, cancel, shutdown };
}

function cleanAssetText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function attributeValue(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function setAttribute(node, name, value) {
  const existing = node.attrs?.find((attribute) => attribute.name === name);
  if (existing) existing.value = value;
  else node.attrs = [...(node.attrs || []), { name, value }];
}

function walkFragment(node, visitor) {
  visitor(node);
  for (const child of node.childNodes || []) walkFragment(child, visitor);
  if (node.content) walkFragment(node.content, visitor);
}

function validatedAssetMetadata(asset) {
  if (!asset || !ASSET_ID.test(asset.id || "") || !ASSET_FILENAME.test(asset.filename || "")
    || !IMAGE_MIME_TYPES.has(asset.mimeType)) {
    throw new Error("Asset metadata is invalid");
  }
  return asset;
}

export function createAssetPublicationAdapter({
  store,
  jobId,
  uploads = [],
  sourceBlocks = [],
  signal,
} = {}) {
  if (!store?.readArtifact || !store?.readJson || !store?.writeArtifact || !store?.persistUploadedAssets) {
    throw new TypeError("Asset publication requires an artifact store");
  }
  if (!JOB_ID.test(jobId || "")) throw new TypeError("Asset publication requires a valid job id");
  if (!Array.isArray(uploads) || !Array.isArray(sourceBlocks)) {
    throw new TypeError("Asset publication inputs must be arrays");
  }
  const localUploads = uploads;
  const knownSources = new Set(sourceBlocks.map((block) => block?.id).filter(Boolean));

  async function verifyLocalAsset(asset, writeSignal) {
    const metadata = validatedAssetMetadata(asset);
    if (!localUploads.some((candidate) => candidate?.id === metadata.id)) {
      throw new Error("Asset is not in the job-local publication set");
    }
    writeSignal?.throwIfAborted();
    const bytes = await store.readArtifact(jobId, `assets/${metadata.filename}`, { encoding: null });
    if (Number.isSafeInteger(metadata.byteLength) && bytes.length !== metadata.byteLength) {
      throw new Error("Asset byte length does not match provenance");
    }
    if (typeof metadata.sha256 === "string"
      && crypto.createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
      throw new Error("Asset hash does not match provenance");
    }
    return metadata;
  }

  async function writeResolvedSlot(asset, slideId, slotId, writeSignal) {
    if (!SLIDE_ID.test(slideId || "") || !SLOT_ID.test(slotId || "")) {
      throw new Error("Invalid asset slot target");
    }
    writeSignal?.throwIfAborted();
    const manifest = await store.readJson(jobId, "working/manifest.json");
    const slide = manifest?.slides?.find((candidate) => candidate?.slideId === slideId);
    if (!slide || !Array.isArray(slide.assetSlots)) throw new Error("Asset slot slide is missing from the manifest");
    const slot = slide.assetSlots.find((candidate) => candidate?.slotId === slotId);
    if (!slot) throw new Error("Asset slot is missing from the manifest");

    const relativePath = `working/slides/${slideId}.html`;
    const rawHtml = await store.readArtifact(jobId, relativePath);
    const parseErrors = [];
    const fragment = parseFragment(rawHtml, { onParseError: (error) => parseErrors.push(error) });
    if (parseErrors.length) throw new Error(`Invalid stored HTML syntax: ${parseErrors[0].code}`);
    const matches = [];
    walkFragment(fragment, (node) => {
      if (node.tagName && attributeValue(node, "data-asset-slot") === slotId) matches.push(node);
    });
    if (matches.length !== 1) throw new Error(`Expected one exact asset slot ${slotId} in ${slideId}`);

    const target = matches[0];
    const image = parseFragment("<img>").childNodes[0];
    image.attrs = [
      { name: "src", value: `asset://${asset.id}` },
      { name: "alt", value: cleanAssetText(asset.summary || slot.purpose, 300) || "Presentation image" },
    ];
    image.parentNode = target;
    target.childNodes = [image];
    setAttribute(target, "data-asset-state", "resolved");

    const jobInput = await store.readJson(jobId, "job-input.json");
    const assetIds = new Set([
      ...(jobInput?.uploadedAssets || []).map((candidate) => candidate?.id),
      ...(manifest.assets || []).map((candidate) => candidate?.id),
      asset.id,
    ].filter(Boolean));
    const validated = validateStoredSlideHtml({
      html: serialize(fragment),
      slideId,
      sourceRefs: Array.isArray(slide.sourceRefs) ? slide.sourceRefs : slide.sourceBlockIds || [],
      sourceBlockIds: knownSources,
      assetIds,
    });
    writeSignal?.throwIfAborted();
    await store.writeArtifact(jobId, relativePath, validated.html, { signal: writeSignal });
  }

  async function publishAsset(asset, slideId, slotId, options = {}) {
    const writeSignal = options.signal || signal;
    const metadata = await verifyLocalAsset(asset, writeSignal);
    await writeResolvedSlot(metadata, slideId, slotId, writeSignal);
    return { assetId: metadata.id };
  }

  async function publishGeneratedAsset(generated, slideId, slotId, options = {}) {
    const writeSignal = options.signal || signal;
    if (typeof generated?.dataUrl !== "string") throw new Error("Generated asset has no image data");
    const [metadata] = await store.persistUploadedAssets(jobId, [{
      name: `generated-${slideId}-${slotId}`,
      summary: cleanAssetText(generated.revisedPrompt || "Generated presentation image", 2_000),
      dataUrl: generated.dataUrl,
    }], { signal: writeSignal });
    localUploads.push(metadata);
    await publishAsset(metadata, slideId, slotId, { signal: writeSignal });
    return { assetId: metadata.id };
  }

  return { uploads: localUploads, publishAsset, publishGeneratedAsset };
}

function qaArtifactPath(artifactId) {
  if (artifactId === "working-qa-contact-sheet") return "working/qa/contact-sheet.png";
  const slide = /^working-qa-slides-(slide-\d{2})$/.exec(artifactId || "");
  return slide ? `working/qa/slides/${slide[1]}.png` : undefined;
}

async function createProductionRuntime({ command, signal, emit }) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const [
    { loadServerConfig },
    { createHttpClient },
    { createModelClient },
    { createImageClient },
    { createArtifactStore },
    { createAgentRunner },
    { createSkillLoader },
    { createToolRegistry },
    { createRenderer },
    { createVerifier, mergeQaEvidence },
    { createDeckJobOrchestrator },
    { parseOutline },
    { runBuildStage },
    { assertJobTransition, TERMINAL_JOB_STATUSES },
  ] = await Promise.all([
    import("../config.mjs"),
    import("../shared/http.mjs"),
    import("../model/client.mjs"),
    import("../images/client.mjs"),
    import("./artifact-store.mjs"),
    import("./agent-runner.mjs"),
    import("./skill-loader.mjs"),
    import("./tool-registry.mjs"),
    import("./renderer.mjs"),
    import("./verifier.mjs"),
    import("./orchestrator.mjs"),
    import("./outline.mjs"),
    import("./stages/build-stage.mjs"),
    import("./contracts.mjs"),
  ]);

  const config = loadServerConfig({ env: process.env, argv: process.argv.slice(2), rootDir });
  const store = createArtifactStore({ rootDir: config.deckJobRoot });
  const http = createHttpClient({ proxyUrl: config.proxyUrl });
  const modelClient = createModelClient({ config, http });
  const imageClient = createImageClient({ config, http });
  const runner = createAgentRunner({ modelClient });
  const skillLoader = createSkillLoader({ skillRoot: path.join(rootDir, "skills/generate-html-deck") });
  const parentOrigin = process.env.DECK_PARENT_ORIGIN || `http://${config.host}:${config.port}`;
  const renderer = createRenderer({
    store,
    runtimeRoot: path.join(rootDir, "skills/generate-html-deck/assets/runtime"),
    appOrigin: parentOrigin,
  });

  async function readOutline() {
    const [markdown, input, sourceBlocks] = await Promise.all([
      store.readArtifact(command.jobId, "slides-content.md"),
      store.readJson(command.jobId, "job-input.json"),
      store.readJson(command.jobId, "source-blocks.json"),
    ]);
    return parseOutline(markdown, {
      expectedSlideCount: input.source.slideCount,
      sourceBlockIds: new Set(sourceBlocks.map((block) => block.id)),
    });
  }

  const verifier = createVerifier({ renderer, outlineReader: readOutline });
  const tools = createToolRegistry();
  const [input, sourceBlocks] = await Promise.all([
    store.readJson(command.jobId, "job-input.json"),
    store.readJson(command.jobId, "source-blocks.json"),
  ]);
  const assetPublication = createAssetPublicationAdapter({
    store,
    jobId: command.jobId,
    uploads: Array.isArray(input.uploadedAssets) ? input.uploadedAssets : [],
    sourceBlocks,
    signal,
  });

  async function reviewVisual({ slideIds, artifactIds, label }) {
    const images = [];
    for (const artifactId of artifactIds.filter(Boolean)) {
      const relativePath = qaArtifactPath(artifactId);
      if (!relativePath) continue;
      const bytes = await store.readArtifact(command.jobId, relativePath, { encoding: null });
      images.push({
        name: `${artifactId}.png`,
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        summary: label,
      });
    }
    const skill = await skillLoader.load("verifying");
    const result = await modelClient.completeStructured({
      messages: [
        { role: "system", content: skill.instructions },
        { role: "user", content: JSON.stringify({ task: label, slideIds }) },
      ],
      schema: VISUAL_REVIEW_SCHEMA,
      schemaName: "deck_visual_review",
      images,
      timeoutMs: 120_000,
      signal,
    });
    return result.value;
  }

  const base = {
    store,
    input,
    sourceBlocks,
    runner,
    skillLoader,
    tools,
    renderer,
    verifier,
    imageClient,
    signal,
    emit,
    readOutline,
    mergeQaEvidence,
    uploads: assetPublication.uploads,
    library: [],
    publishAsset: assetPublication.publishAsset,
    publishGeneratedAsset: assetPublication.publishGeneratedAsset,
  };

  base.generateSlides = async (slideIds) => runBuildStage({
    ...base,
    jobId: command.jobId,
    revisionId: "working",
    remainingSlideIds: slideIds,
    calibrationSlideIds: [],
  });
  base.reviewCalibration = ({ slideIds, contactSheetArtifactId }) => reviewVisual({
    slideIds,
    artifactIds: [contactSheetArtifactId],
    label: "Review calibration slides for hierarchy, density, balance, and consistency",
  });
  base.reviseCalibration = ({ slideIds }) => base.generateSlides(slideIds);
  base.writeDefaultTheme = async () => {
    const css = await fs.readFile(path.join(rootDir, "skills/generate-html-deck/assets/themes/minimal-white.css"), "utf8");
    await store.writeArtifact(command.jobId, "working/theme.css", css, { signal });
  };
  base.lockDesignRules = async ({ slideIds, report }) => {
    const manifest = await store.readJson(command.jobId, "working/manifest.json");
    await store.writeJson(command.jobId, "working/manifest.json", {
      ...manifest,
      designRulesLocked: true,
      calibrationSlideIds: slideIds,
      calibrationOk: report.ok === true,
    }, { signal });
  };
  base.reviewContactSheet = ({ slideIds, contactSheetArtifactId }) => reviewVisual({
    slideIds,
    artifactIds: [contactSheetArtifactId],
    label: "Review the complete deck once for hierarchy, repetition, density, balance, and consistency",
  });
  base.reviewRepairedSlides = ({ slideIds, screenshotArtifactIds }) => reviewVisual({
    slideIds,
    artifactIds: screenshotArtifactIds,
    label: "Recheck only the repaired slides",
  });
  base.repairSlides = (slideIds) => base.generateSlides(slideIds);
  base.emitAssetFallback = (slideId, slotId, error) => emit({
    stage: "generating-assets",
    type: "message",
    status: "done",
    title: "素材已切换为无图片布局",
    message: `${slideId}/${slotId}: ${String(error?.message || error).slice(0, 500)}`,
  });

  async function transition(jobId, status) {
    const current = await store.readJob(jobId);
    if (current.status === status) return current;
    if (status === "cancelled" && signal.aborted) return current;
    const recovering = status === command.resumeFrom
      && !TERMINAL_JOB_STATUSES.includes(current.status)
      && current.status !== "queued";
    if (!recovering) assertJobTransition(current.status, status);
    const updated = await store.updateJob(jobId, { status }, { signal });
    await emit({
      stage: status,
      type: TERMINAL_JOB_STATUSES.includes(status) ? "job" : "stage",
      status: TERMINAL_JOB_STATUSES.includes(status) ? (status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "done") : "running",
      title: STAGE_TITLES[status] || status,
      ...(TERMINAL_JOB_STATUSES.includes(status) ? {} : { progress: { completed: 0, total: 1 } }),
    });
    return updated;
  }

  async function checkpoint(jobId, stage) {
    const job = await store.readJob(jobId);
    const checkpoints = [...new Set([...(job.checkpoints || []), stage])];
    const updated = await store.updateJob(jobId, { checkpoints }, { signal });
    await emit({
      stage,
      type: "stage",
      status: "done",
      title: STAGE_TITLES[stage] || stage,
      progress: { completed: 1, total: 1 },
    });
    return updated;
  }

  async function fail(jobId, stage, error) {
    if (signal.aborted) return;
    const message = String(error instanceof Error ? error.message : error).slice(0, 2_000);
    await store.updateJob(jobId, { status: "failed", failedStage: stage, error: message }, { signal });
    await emit({
      stage: "failed",
      type: "error",
      status: "failed",
      title: STAGE_TITLES.failed,
      error: { code: "JOB_EXECUTION_FAILED", message, retryable: true },
    });
    await emit({ stage: "failed", type: "job", status: "failed", title: STAGE_TITLES.failed });
  }

  const orchestrator = createDeckJobOrchestrator({
    ...base,
    transition,
    checkpoint,
    fail,
  });
  return { orchestrator, store };
}

export async function runWorkerCommand(command, {
  signal,
  emit = async () => {},
  runtimeFactory = createProductionRuntime,
} = {}) {
  if (!command || !JOB_ID.test(command.jobId)) throw new TypeError("Invalid deck worker command");
  const runtime = await runtimeFactory({ command, signal, emit });
  if (command.type === "run") {
    const job = await runtime.store.readJob(command.jobId);
    if (job.status === command.resumeFrom) {
      await emit({
        stage: command.resumeFrom,
        type: "stage",
        status: "running",
        title: STAGE_TITLES[command.resumeFrom] || command.resumeFrom,
        progress: { completed: 0, total: 1 },
      });
    }
    return runtime.orchestrator.run(command.jobId, { signal });
  }
  if (command.type === "revision") {
    if (typeof runtime.orchestrator.applyMessage !== "function") {
      const error = new HttpError(503, "Revision worker support is not installed");
      error.code = "REVISION_UNAVAILABLE";
      throw error;
    }
    return runtime.orchestrator.applyMessage(command.jobId, command.request, { signal });
  }
  throw new TypeError("Unsupported deck worker command");
}

function startWorkerThread(port) {
  const acknowledgements = new Map();
  let active;

  function emit(jobId, event) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      acknowledgements.set(requestId, { resolve, reject });
      port.postMessage({ type: "event", jobId, requestId, event });
    });
  }

  port.on("message", (message) => {
    if (message?.type === "event-result") {
      const pending = acknowledgements.get(message.requestId);
      if (!pending) return;
      acknowledgements.delete(message.requestId);
      if (message.ok) pending.resolve();
      else pending.reject(workerError(message.error));
      return;
    }
    if (message?.type === "cancel" && active?.jobId === message.jobId) {
      active.controller.abort(new JobCancelledError());
      return;
    }
    if (!message || !["run", "revision"].includes(message.type) || !JOB_ID.test(message.jobId) || active) {
      port.postMessage({
        type: "error",
        jobId: message?.jobId,
        error: serializedError(new TypeError("Invalid or concurrent deck worker command")),
      });
      return;
    }
    const controller = new AbortController();
    active = { jobId: message.jobId, controller };
    runWorkerCommand(message, {
      signal: controller.signal,
      emit: (event) => emit(message.jobId, event),
    }).then(
      (result) => port.postMessage({ type: "stopped", jobId: message.jobId, result }),
      (error) => {
        if (controller.signal.aborted) {
          port.postMessage({ type: "stopped", jobId: message.jobId, result: { status: "cancelled" } });
        } else {
          port.postMessage({ type: "error", jobId: message.jobId, error: serializedError(error) });
        }
      },
    ).finally(() => {
      active = undefined;
    });
  });
}

if (!isMainThread && parentPort) startWorkerThread(parentPort);
