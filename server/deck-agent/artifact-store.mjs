import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deckArtifactSchema, deckJobSchema, TERMINAL_JOB_STATUSES } from "./contracts.mjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const REVISION_ID = /^revision-\d{6}$/;
const CANDIDATE_ID = /^\.candidate-[0-9a-f-]+$/;
const ENCODED_OR_WINDOWS_ESCAPE = /%|\\|\0/;
export const DEFAULT_QUOTAS = Object.freeze({ job: 512 * 1024 * 1024, markdown: 2 * 1024 * 1024, slideHtml: 200 * 1024, slideCss: 120 * 1024, json: 10 * 1024 * 1024, image: 12 * 1024 * 1024, standaloneHtml: 256 * 1024 * 1024 });
const ALLOWED_ARTIFACT_PATH = /^(job\.json|job-input\.json|events\.ndjson|source-blocks\.json|slides-content\.md|design-brief\.md|current-revision\.json|working\/(manifest\.json|theme\.css|slides\/slide-\d{2}\.(html|css)|qa\/[a-z0-9/_-]+\.(json|png|html)|dist\/index\.html)|assets\/[a-z0-9-]+\.(png|jpe?g|webp)|revisions\/(revision-\d{6}|\.candidate-[0-9a-f-]+)\/(meta\.json|manifest\.json|theme\.css|slides\/slide-\d{2}\.(html|css)|qa\/[a-z0-9/_-]+\.(json|png|html)|dist\/index\.html))$/;
const INPUT_SOURCE_FIELDS = ["topic", "audience", "slideCount", "textInput", "tableInput", "imageBrief", "styleId"];
const INPUT_OPTION_FIELDS = ["imageEnabled", "imageCount", "imageQuality", "imageTimeoutMs", "imageMaxRetries"];
const IMAGE_TYPES = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });

export function resolveJobPath(rootDir, jobId, relativePath) {
  if (typeof rootDir !== "string" || !rootDir || !JOB_ID.test(jobId) || typeof relativePath !== "string" || path.isAbsolute(relativePath) || ENCODED_OR_WINDOWS_ESCAPE.test(relativePath) || !ALLOWED_ARTIFACT_PATH.test(relativePath)) throw new Error("Invalid artifact path");
  const jobRoot = path.resolve(rootDir, jobId);
  const target = path.resolve(jobRoot, relativePath);
  const relation = path.relative(jobRoot, target);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`)) throw new Error("Artifact path escapes job workspace");
  return { jobRoot, target };
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function lstatOptional(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function assertNoSymlink(jobRoot, target) {
  let cursor = target;
  while (true) {
    const stat = await lstatOptional(cursor);
    if (stat?.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
    if (cursor === jobRoot) return;
    const parent = path.dirname(cursor);
    const relation = path.relative(jobRoot, parent);
    if (relation === ".." || relation.startsWith(`..${path.sep}`)) throw new Error("Artifact path escapes job workspace");
    cursor = parent;
  }
}

async function atomicWrite(target, data, { fsHooks, jobRoot, signal, bypassHook = false }) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  signal?.throwIfAborted();
  await assertNoSymlink(jobRoot, target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertNoSymlink(jobRoot, target);
  try {
    await fs.writeFile(temporary, data, { flag: "wx" });
    signal?.throwIfAborted();
    if (!bypassHook) await fsHooks?.beforeRename?.(temporary, target);
    await assertNoSymlink(jobRoot, target);
    signal?.throwIfAborted();
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function toBuffer(data) {
  if (typeof data === "string") {
    const byteLength = Buffer.byteLength(data, "utf8");
    const bytes = Buffer.from(data, "utf8");
    if (bytes.length !== byteLength) throw new Error("Unable to encode artifact as UTF-8");
    return bytes;
  }
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("Artifact data must be a string, Buffer, or Uint8Array");
}

function artifactQuota(relativePath, quotas) {
  if (/\/dist\/index\.html$/.test(`/${relativePath}`)) return ["standaloneHtml", quotas.standaloneHtml];
  if (/\.(png|jpe?g|webp)$/.test(relativePath)) return ["image", quotas.image];
  if (/\.md$/.test(relativePath)) return ["markdown", quotas.markdown];
  if (/\.css$/.test(relativePath)) return ["slideCss", quotas.slideCss];
  if (/\.html$/.test(relativePath)) return ["slideHtml", quotas.slideHtml];
  return ["json", quotas.json];
}

async function workspaceBytes(directory) {
  const stat = await lstatOptional(directory);
  if (!stat) return 0;
  if (stat.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error("Unsupported workspace entry");
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
    if (entry.isDirectory()) total += await workspaceBytes(child);
    else if (entry.isFile()) total += (await fs.lstat(child)).size;
    else throw new Error("Unsupported workspace entry");
  }
  return total;
}

function copyDefined(source, fields) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(fields.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
}

function sanitizeJobInput(input) {
  return {
    source: copyDefined(input?.source, INPUT_SOURCE_FIELDS),
    options: copyDefined(input?.options, INPUT_OPTION_FIELDS),
  };
}

function stringifyJson(value) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("Artifact value is not JSON serializable");
  return `${serialized}\n`;
}

function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("Image data URL must be normalized");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw new Error("Image data URL must be normalized base64");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.toString("base64") !== match[2]) throw new Error("Image data URL must be normalized base64");
  const mimeType = match[1];
  const validSignature = mimeType === "image/png"
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : mimeType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!validSignature) throw new Error(`Image signature does not match ${mimeType}`);
  return { bytes, mimeType, extension: IMAGE_TYPES[mimeType] };
}

function cleanProvenanceText(value, field, maxLength) {
  if (typeof value !== "string") throw new TypeError(`Uploaded image ${field} must be a string`);
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maxLength);
}

function descriptorFor(relativePath, uploadedByFilename) {
  if (relativePath.startsWith("revisions/.candidate-")) return undefined;
  if (["job.json", "job-input.json", "events.ndjson", "source-blocks.json", "current-revision.json"].includes(relativePath)) return undefined;
  if (/(^|\/)manifest\.json$/.test(relativePath) || /(^|\/)meta\.json$/.test(relativePath) || relativePath.endsWith(".css")) return undefined;
  const uploaded = relativePath.startsWith("assets/") ? uploadedByFilename.get(path.basename(relativePath)) : undefined;
  const revisionMatch = /^revisions\/revision-(\d{6})\//.exec(relativePath);
  const revision = revisionMatch ? Number(revisionMatch[1]) : undefined;
  const extension = path.extname(relativePath).toLowerCase();
  const kind = extension === ".md" ? "markdown" : extension === ".html" ? "html" : [".png", ".jpg", ".jpeg", ".webp"].includes(extension) ? "image" : extension === ".json" ? "json" : undefined;
  if (!kind) return undefined;
  const rawId = uploaded?.id || relativePath.slice(0, -extension.length).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const stage = relativePath === "slides-content.md" ? "outline"
    : relativePath === "design-brief.md" ? "design"
      : relativePath.startsWith("assets/") ? (uploaded ? "queued" : "generating-assets")
        : relativePath.includes("/qa/") ? "verifying"
          : revision === undefined ? "building" : "repairing";
  return deckArtifactSchema.parse({
    id: rawId,
    filename: path.basename(relativePath),
    kind,
    stage,
    ...(revision === undefined ? {} : { revision }),
    previewable: kind !== "json",
    downloadable: true,
  });
}

export function createArtifactStore({ rootDir, quotas = DEFAULT_QUOTAS, fsHooks } = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new TypeError("Artifact rootDir is required");
  const resolvedRoot = path.resolve(rootDir);
  const effectiveQuotas = Object.freeze({ ...DEFAULT_QUOTAS, ...quotas });
  for (const [name, limit] of Object.entries(effectiveQuotas)) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError(`Invalid ${name} quota`);
  }
  const locks = new Map();

  async function ensureRoot() {
    await fs.mkdir(resolvedRoot, { recursive: true });
    const stat = await fs.lstat(resolvedRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Artifact root must be a real directory");
  }

  async function runExclusive(jobId, callback) {
    if (typeof callback !== "function") throw new TypeError("Exclusive callback is required");
    resolveJobPath(resolvedRoot, jobId, "job.json");
    const previous = locks.get(jobId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    locks.set(jobId, queued);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (locks.get(jobId) === queued) locks.delete(jobId);
    }
  }

  async function assertJobWorkspace(jobRoot) {
    const stat = await lstatOptional(jobRoot);
    if (stat?.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
    if (!stat || !stat.isDirectory()) throw new Error("Deck job not found");
  }

  async function checkQuota(jobRoot, target, relativePath, bytes) {
    const [quotaName, artifactLimit] = artifactQuota(relativePath, effectiveQuotas);
    if (bytes.length > artifactLimit) throw new Error(`${quotaName} quota limit exceeded`);
    const existing = await lstatOptional(target);
    if (existing?.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
    if (existing && !existing.isFile()) throw new Error("Artifact target must be a file");
    const projected = (await workspaceBytes(jobRoot)) - (existing?.size || 0) + bytes.length;
    if (projected > effectiveQuotas.job) throw new Error("Job quota limit exceeded");
  }

  async function writeUnlocked(jobId, relativePath, data, options = {}) {
    const { jobRoot, target } = resolveJobPath(resolvedRoot, jobId, relativePath);
    await assertJobWorkspace(jobRoot);
    await assertNoSymlink(jobRoot, target);
    const bytes = toBuffer(data);
    await checkQuota(jobRoot, target, relativePath, bytes);
    await atomicWrite(target, bytes, { fsHooks, jobRoot, signal: options.signal, bypassHook: options.bypassHook });
  }

  async function writeArtifact(jobId, relativePath, data, options = {}) {
    if (options.alreadyLocked) return writeUnlocked(jobId, relativePath, data, options);
    return runExclusive(jobId, () => writeUnlocked(jobId, relativePath, data, options));
  }

  async function readArtifact(jobId, relativePath, options = {}) {
    const { jobRoot, target } = resolveJobPath(resolvedRoot, jobId, relativePath);
    await assertJobWorkspace(jobRoot);
    await assertNoSymlink(jobRoot, target);
    try {
      if (options.encoding === null || options.encoding === "buffer") return await fs.readFile(target);
      return await fs.readFile(target, options.encoding || "utf8");
    } catch (error) {
      if (options.optional && isMissing(error)) return undefined;
      throw error;
    }
  }

  async function writeJson(jobId, relativePath, value, options = {}) {
    return writeArtifact(jobId, relativePath, stringifyJson(value), options);
  }

  async function readJson(jobId, relativePath, options = {}) {
    const raw = await readArtifact(jobId, relativePath, options);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Corrupt persisted JSON at ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function removeCurrentRevisionPointer(jobId, options = {}) {
    const remove = async () => {
      const { jobRoot, target } = resolveJobPath(resolvedRoot, jobId, "current-revision.json");
      await assertJobWorkspace(jobRoot);
      await assertNoSymlink(jobRoot, target);
      await fs.rm(target, { force: true });
    };
    return options.alreadyLocked ? remove() : runExclusive(jobId, remove);
  }

  async function readJob(jobId, options = {}) {
    return deckJobSchema.parse(await readJson(jobId, "job.json", options));
  }

  async function createJob({ jobId, title, input, sourceBlocks }) {
    return runExclusive(jobId, async () => {
      await ensureRoot();
      const { jobRoot } = resolveJobPath(resolvedRoot, jobId, "job.json");
      if (await lstatOptional(jobRoot)) throw new Error("Deck job already exists");
      await fs.mkdir(jobRoot);
      try {
        const timestamp = new Date().toISOString();
        const job = deckJobSchema.parse({
          id: jobId,
          title,
          status: "queued",
          lastSeq: 0,
          revision: 0,
          attempts: {},
          checkpoints: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await writeUnlocked(jobId, "job.json", stringifyJson(job));
        await writeUnlocked(jobId, "job-input.json", stringifyJson(sanitizeJobInput(input)));
        await writeUnlocked(jobId, "source-blocks.json", stringifyJson(Array.isArray(sourceBlocks) ? sourceBlocks : []));
        return job;
      } catch (error) {
        await fs.rm(jobRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async function updateJob(jobId, patch, options = {}) {
    const update = async () => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Job update must be an object");
      const current = await readJob(jobId, { alreadyLocked: true });
      if (patch.id !== undefined && patch.id !== current.id) throw new Error("Job id cannot be changed");
      const next = deckJobSchema.parse({
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: patch.updatedAt || new Date().toISOString(),
      });
      await writeUnlocked(jobId, "job.json", stringifyJson(next), options);
      return next;
    };
    return options.alreadyLocked ? update() : runExclusive(jobId, update);
  }

  async function appendLine(jobId, relativePath, line, options = {}) {
    if (relativePath !== "events.ndjson") throw new Error("appendLine is restricted to events.ndjson");
    if (typeof line !== "string" || !line.endsWith("\n") || line.slice(0, -1).includes("\n")) throw new Error("appendLine requires one complete UTF-8 JSON line");
    try {
      JSON.parse(line.slice(0, -1));
    } catch {
      throw new Error("appendLine requires one complete UTF-8 JSON line");
    }
    const append = async () => {
      const existing = await readArtifact(jobId, relativePath, { optional: true });
      if (existing && !existing.endsWith("\n")) throw new Error("Persisted event log has an incomplete final line");
      await writeUnlocked(jobId, relativePath, `${existing || ""}${line}`, options);
    };
    return options.alreadyLocked ? append() : runExclusive(jobId, append);
  }

  async function persistUploadedAssets(jobId, images, options = {}) {
    const persist = async () => {
      if (!Array.isArray(images) || images.length > 50) throw new TypeError("Uploaded images must be an array of at most 50 items");
      const prepared = images.map((image) => {
        if (!image || typeof image !== "object" || Array.isArray(image)) throw new TypeError("Uploaded image must be an object");
        const decoded = decodeImageDataUrl(image.dataUrl);
        const [, imageLimit] = artifactQuota(`assets/file.${decoded.extension}`, effectiveQuotas);
        if (decoded.bytes.length > imageLimit) throw new Error("image quota limit exceeded");
        const id = `asset-${crypto.randomBytes(16).toString("hex")}`;
        const filename = `${id}.${decoded.extension}`;
        return {
          bytes: decoded.bytes,
          relativePath: `assets/${filename}`,
          provenance: {
            id,
            filename,
            kind: "image",
            mimeType: decoded.mimeType,
            byteLength: decoded.bytes.length,
            sha256: crypto.createHash("sha256").update(decoded.bytes).digest("hex"),
            originalName: cleanProvenanceText(image.name, "name", 200),
            summary: cleanProvenanceText(image.summary, "summary", 2_000),
          },
        };
      });
      const jobInput = await readJson(jobId, "job-input.json");
      const previous = Array.isArray(jobInput.uploadedAssets) ? jobInput.uploadedAssets : [];
      const nextInput = { ...jobInput, uploadedAssets: [...previous, ...prepared.map((item) => item.provenance)] };

      const { jobRoot } = resolveJobPath(resolvedRoot, jobId, "job.json");
      const currentTotal = await workspaceBytes(jobRoot);
      const inputTarget = resolveJobPath(resolvedRoot, jobId, "job-input.json").target;
      const inputStat = await lstatOptional(inputTarget);
      const inputBytes = toBuffer(stringifyJson(nextInput));
      const [, jsonLimit] = artifactQuota("job-input.json", effectiveQuotas);
      if (inputBytes.length > jsonLimit) throw new Error("json quota limit exceeded");
      const projectedTotal = currentTotal - (inputStat?.size || 0) + inputBytes.length + prepared.reduce((sum, item) => sum + item.bytes.length, 0);
      if (projectedTotal > effectiveQuotas.job) throw new Error("Job quota limit exceeded");

      for (const item of prepared) {
        const { target } = resolveJobPath(resolvedRoot, jobId, item.relativePath);
        if (await lstatOptional(target)) throw new Error("Generated asset id collision");
      }
      const committedAssets = [];
      try {
        for (const item of prepared) {
          await writeUnlocked(jobId, item.relativePath, item.bytes, options);
          committedAssets.push(item.relativePath);
        }
        await writeUnlocked(jobId, "job-input.json", inputBytes, options);
      } catch (error) {
        const rollbackErrors = [];
        for (const relativePath of committedAssets) {
          const { jobRoot: rollbackRoot, target } = resolveJobPath(resolvedRoot, jobId, relativePath);
          try {
            await assertNoSymlink(rollbackRoot, target);
            await fs.rm(target, { force: true });
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Uploaded asset rollback failed");
        throw error;
      }
      return prepared.map((item) => item.provenance);
    };
    return options.alreadyLocked ? persist() : runExclusive(jobId, persist);
  }

  async function listFiles(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await listFiles(absolute, relative));
      else if (entry.isFile()) files.push(relative);
      else throw new Error("Unsupported workspace entry");
    }
    return files;
  }

  function revisionDirectory(jobId, revisionId, kind) {
    const valid = kind === "candidate" ? CANDIDATE_ID.test(revisionId) : REVISION_ID.test(revisionId);
    if (!valid) throw new Error(`Invalid ${kind} revision identity`);
    const { jobRoot, target } = resolveJobPath(resolvedRoot, jobId, `revisions/${revisionId}/meta.json`);
    return { jobRoot, directory: path.dirname(target) };
  }

  async function copyRevisionFiles(jobId, sourceRevisionId, candidateId, options = {}) {
    const copy = async () => {
      const source = revisionDirectory(jobId, sourceRevisionId, "published");
      const target = revisionDirectory(jobId, candidateId, "candidate");
      await assertJobWorkspace(source.jobRoot);
      await assertNoSymlink(source.jobRoot, source.directory);
      await assertNoSymlink(target.jobRoot, target.directory);
      const sourceStat = await lstatOptional(source.directory);
      if (!sourceStat?.isDirectory()) throw new Error("Published revision directory is missing");
      if (await lstatOptional(target.directory)) throw new Error("Candidate revision already exists");

      const files = (await listFiles(source.directory)).filter((relativePath) => (
        relativePath !== "meta.json" && !relativePath.endsWith(".png")
      ));
      try {
        for (const relativePath of files) {
          options.signal?.throwIfAborted();
          const sourcePath = `revisions/${sourceRevisionId}/${relativePath}`;
          const targetPath = `revisions/${candidateId}/${relativePath}`;
          const bytes = await readArtifact(jobId, sourcePath, { encoding: null });
          await writeUnlocked(jobId, targetPath, bytes, options);
        }
      } catch (error) {
        await assertNoSymlink(target.jobRoot, target.directory).catch(() => {});
        await fs.rm(target.directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return files;
    };
    return options.alreadyLocked ? copy() : runExclusive(jobId, copy);
  }

  async function copyWorkingQaFiles(jobId, revisionId, options = {}) {
    const copy = async () => {
      const { jobRoot, target } = resolveJobPath(resolvedRoot, jobId, "working/qa/report.json");
      const sourceDirectory = path.dirname(target);
      const published = revisionDirectory(jobId, revisionId, "published");
      await assertJobWorkspace(jobRoot);
      await assertNoSymlink(jobRoot, sourceDirectory);
      const sourceStat = await lstatOptional(sourceDirectory);
      if (!sourceStat) return [];
      if (!sourceStat.isDirectory()) throw new Error("Working QA workspace is invalid");
      const files = await listFiles(sourceDirectory);
      for (const relativePath of files) {
        options.signal?.throwIfAborted();
        const sourcePath = `working/qa/${relativePath}`;
        const targetPath = `revisions/${revisionId}/qa/${relativePath}`;
        const bytes = await readArtifact(jobId, sourcePath, { encoding: null });
        await writeUnlocked(jobId, targetPath, bytes, options);
      }
      await assertNoSymlink(published.jobRoot, published.directory);
      return files;
    };
    return options.alreadyLocked ? copy() : runExclusive(jobId, copy);
  }

  async function renameRevisionDirectory(jobId, candidateId, revisionId, options = {}) {
    const rename = async () => {
      const source = revisionDirectory(jobId, candidateId, "candidate");
      const target = revisionDirectory(jobId, revisionId, "published");
      await assertJobWorkspace(source.jobRoot);
      await assertNoSymlink(source.jobRoot, source.directory);
      await assertNoSymlink(target.jobRoot, target.directory);
      const sourceStat = await lstatOptional(source.directory);
      if (!sourceStat?.isDirectory()) throw new Error("Candidate revision directory is missing");
      if (await lstatOptional(target.directory)) throw new Error("Published revision already exists");
      options.signal?.throwIfAborted();
      await fsHooks?.beforeRename?.(source.directory, target.directory);
      options.signal?.throwIfAborted();
      await fs.rename(source.directory, target.directory);
    };
    return options.alreadyLocked ? rename() : runExclusive(jobId, rename);
  }

  async function listRevisionIds(jobId) {
    const { jobRoot, target } = resolveJobPath(resolvedRoot, jobId, "current-revision.json");
    await assertJobWorkspace(jobRoot);
    const revisionsDirectory = path.join(path.dirname(target), "revisions");
    await assertNoSymlink(jobRoot, revisionsDirectory);
    const stat = await lstatOptional(revisionsDirectory);
    if (!stat) return [];
    if (!stat.isDirectory()) throw new Error("Revision workspace is invalid");
    const revisionIds = [];
    for (const entry of await fs.readdir(revisionsDirectory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Symbolic link escapes are forbidden");
      if (!entry.isDirectory()) continue;
      if (REVISION_ID.test(entry.name) || CANDIDATE_ID.test(entry.name)) revisionIds.push(entry.name);
    }
    return revisionIds.sort();
  }

  async function listArtifacts(jobId) {
    const { jobRoot } = resolveJobPath(resolvedRoot, jobId, "job.json");
    await assertJobWorkspace(jobRoot);
    await assertNoSymlink(jobRoot, jobRoot);
    const jobInput = await readJson(jobId, "job-input.json", { optional: true }) || {};
    const uploadedByFilename = new Map((Array.isArray(jobInput.uploadedAssets) ? jobInput.uploadedAssets : []).map((item) => [item.filename, item]));
    const descriptors = (await listFiles(jobRoot)).map((relativePath) => descriptorFor(relativePath, uploadedByFilename)).filter(Boolean);
    return descriptors.sort((left, right) => left.id.localeCompare(right.id));
  }

  async function listRecoverableJobs() {
    await ensureRoot();
    const recoverable = [];
    for (const entry of await fs.readdir(resolvedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !JOB_ID.test(entry.name)) continue;
      try {
        const job = await readJob(entry.name);
        if (!TERMINAL_JOB_STATUSES.includes(job.status)) recoverable.push(job);
      } catch {
        // Invalid persisted jobs are never resumed automatically.
      }
    }
    return recoverable.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  return {
    createJob,
    readJob,
    updateJob,
    writeArtifact,
    readArtifact,
    appendLine,
    writeJson,
    readJson,
    removeCurrentRevisionPointer,
    persistUploadedAssets,
    listArtifacts,
    listRecoverableJobs,
    copyRevisionFiles,
    copyWorkingQaFiles,
    renameRevisionDirectory,
    listRevisionIds,
    runExclusive,
  };
}
