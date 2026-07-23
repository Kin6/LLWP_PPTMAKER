import crypto from "node:crypto";
import { z } from "zod";
import { HttpError } from "../shared/errors.mjs";

const REVISION_ID = /^revision-\d{6}$/;
const CANDIDATE_ID = /^\.candidate-[0-9a-f-]+$/;
const SLIDE_ID = /^slide-\d{2}$/;
const ASSET_ID = /^asset-[a-z0-9-]+$/;
const ASSET_FILENAME = /^[a-z0-9-]+\.(?:png|jpe?g|webp)$/;
const CHANGED_FILE = /^(?:manifest\.json|theme\.css|slides\/slide-\d{2}\.(?:html|css)|qa\/[a-z0-9/_-]+\.(?:json|png|html)|dist\/index\.html|assets\/[a-z0-9-]+\.(?:png|jpe?g|webp))$/;

const revisionMetaSchema = z.object({
  revisionId: z.string().refine((value) => REVISION_ID.test(value) || CANDIDATE_ID.test(value)),
  number: z.number().int().positive().max(999_999),
  parentRevision: z.number().int().positive().max(999_999).nullable(),
  instruction: z.string().max(4_000),
  scope: z.enum(["initial", "slides", "theme"]),
  slideIds: z.array(z.string().regex(SLIDE_ID)).max(50),
  changedFiles: z.array(z.string().regex(CHANGED_FILE)).max(160),
  qa: z.unknown().nullable(),
  createdAt: z.string().datetime(),
}).strict();

function conflict(message, options) {
  return new HttpError(409, message, options);
}

function revisionIdFor(number) {
  if (!Number.isSafeInteger(number) || number < 1 || number > 999_999) {
    throw new Error("Revision limit exceeded");
  }
  return `revision-${String(number).padStart(6, "0")}`;
}

function numberFromRevisionId(revisionId) {
  return REVISION_ID.test(revisionId) ? Number(revisionId.slice("revision-".length)) : undefined;
}

function uniqueSlideIds(value) {
  if (!Array.isArray(value) || value.some((slideId) => !SLIDE_ID.test(slideId))) {
    throw new TypeError("Revision slide IDs are invalid");
  }
  return [...new Set(value)];
}

function changedFilesForInitial(slideIds, qaFiles = []) {
  return [
    "manifest.json",
    "theme.css",
    ...slideIds.flatMap((slideId) => [`slides/${slideId}.html`, `slides/${slideId}.css`]),
    ...[...new Set(["report.json", ...qaFiles])].map((filename) => `qa/${filename}`),
    "dist/index.html",
  ];
}

function withJobLock(store, jobId, operation) {
  return typeof store.runExclusive === "function" ? store.runExclusive(jobId, operation) : operation();
}

export function createRevisionStore({
  store,
  now = () => new Date().toISOString(),
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  if (!store?.readJson || !store?.writeJson || !store?.readArtifact || !store?.writeArtifact
    || !store?.readJob || !store?.updateJob) {
    throw new TypeError("Revision store requires an artifact store");
  }

  async function readCurrent(jobId, options = {}) {
    const pointer = await store.readJson(jobId, "current-revision.json", {
      optional: options.optional,
      ...(options.alreadyLocked ? { alreadyLocked: true } : {}),
    });
    if (pointer === undefined) return undefined;
    const number = Number(pointer.number ?? pointer.revision);
    if (!Number.isSafeInteger(number) || number < 1 || pointer.revisionId !== revisionIdFor(number)) {
      throw new Error("Current revision pointer is corrupt");
    }
    return { ...pointer, number, revision: number };
  }

  async function readPublishedMeta(jobId, number) {
    const revisionId = revisionIdFor(number);
    const raw = await store.readJson(jobId, `revisions/${revisionId}/meta.json`);
    const parsed = revisionMetaSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    if (raw?.revisionId === revisionId) {
      return revisionMetaSchema.parse({
        revisionId,
        number,
        parentRevision: number > 1 ? number - 1 : null,
        instruction: "",
        scope: "initial",
        slideIds: [],
        changedFiles: [],
        qa: null,
        createdAt: raw.createdAt || now(),
      });
    }
    throw new Error(`Revision metadata is corrupt for ${revisionId}`);
  }

  async function candidateRecord(jobId, number) {
    if (typeof store.listRevisionIds !== "function") {
      throw new TypeError("Artifact store does not support candidate revisions");
    }
    const matches = [];
    for (const candidateId of (await store.listRevisionIds(jobId)).filter((id) => CANDIDATE_ID.test(id))) {
      const raw = await store.readJson(jobId, `revisions/${candidateId}/meta.json`, { optional: true });
      if (raw?.number === number) matches.push({ candidateId, meta: revisionMetaSchema.parse(raw) });
    }
    if (matches.length !== 1) throw new Error(matches.length ? "Candidate revision number is ambiguous" : "Candidate revision not found");
    return matches[0];
  }

  async function createInitial(jobId, { status = "ready", qa, signal } = {}) {
    return withJobLock(store, jobId, async () => {
      signal?.throwIfAborted();
      if (await readCurrent(jobId, { optional: true, alreadyLocked: true })) {
        throw conflict("An initial revision is already published");
      }
      const job = await store.readJob(jobId, { alreadyLocked: true });
      if (job.revision !== 0) throw conflict("Initial revision requires revision zero");
      const manifest = await store.readJson(jobId, "working/manifest.json", { alreadyLocked: true });
      const slideIds = uniqueSlideIds((manifest?.slides || []).map((slide) => slide?.slideId));
      if (!slideIds.length) throw new Error("Initial revision requires a valid manifest");
      const number = 1;
      const revisionId = revisionIdFor(number);
      const prefix = `revisions/${revisionId}`;
      const report = qa ?? await store.readJson(jobId, "working/qa/report.json", { alreadyLocked: true });

      await store.writeJson(jobId, `${prefix}/manifest.json`, manifest, { alreadyLocked: true, signal });
      await store.writeArtifact(jobId, `${prefix}/theme.css`, await store.readArtifact(jobId, "working/theme.css"), { alreadyLocked: true, signal });
      for (const slideId of slideIds) {
        await store.writeArtifact(jobId, `${prefix}/slides/${slideId}.html`, await store.readArtifact(jobId, `working/slides/${slideId}.html`), { alreadyLocked: true, signal });
        await store.writeArtifact(jobId, `${prefix}/slides/${slideId}.css`, await store.readArtifact(jobId, `working/slides/${slideId}.css`), { alreadyLocked: true, signal });
      }
      const qaFiles = typeof store.copyWorkingQaFiles === "function"
        ? await store.copyWorkingQaFiles(jobId, revisionId, { alreadyLocked: true, signal })
        : [];
      await store.writeJson(jobId, `${prefix}/qa/report.json`, report, { alreadyLocked: true, signal });
      await store.writeArtifact(jobId, `${prefix}/dist/index.html`, await store.readArtifact(jobId, "working/dist/index.html"), { alreadyLocked: true, signal });
      const meta = revisionMetaSchema.parse({
        revisionId,
        number,
        parentRevision: null,
        instruction: "",
        scope: "initial",
        slideIds,
        changedFiles: changedFilesForInitial(slideIds, qaFiles),
        qa: report,
        createdAt: now(),
      });
      await store.writeJson(jobId, `${prefix}/meta.json`, meta, { alreadyLocked: true, signal });
      const pointer = { revision: number, revisionId, status };
      signal?.throwIfAborted();
      await store.writeJson(jobId, "current-revision.json", pointer, { alreadyLocked: true });
      try {
        await store.updateJob(jobId, { revision: number }, { alreadyLocked: true });
      } catch (error) {
        if (typeof store.removeCurrentRevisionPointer !== "function") throw error;
        try {
          await store.removeCurrentRevisionPointer(jobId, { alreadyLocked: true });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Initial revision publication rollback failed");
        }
        throw error;
      }
      return meta;
    });
  }

  async function nextRevisionNumber(jobId) {
    const ids = await store.listRevisionIds(jobId);
    let maximum = 0;
    for (const revisionId of ids) {
      const published = numberFromRevisionId(revisionId);
      if (published) maximum = Math.max(maximum, published);
      else if (CANDIDATE_ID.test(revisionId)) {
        const raw = await store.readJson(jobId, `revisions/${revisionId}/meta.json`, { optional: true });
        if (Number.isSafeInteger(raw?.number)) maximum = Math.max(maximum, raw.number);
      }
    }
    if (maximum >= 999_999) throw new Error("Revision limit exceeded");
    return maximum + 1;
  }

  async function createCandidate(jobId, {
    parentRevision,
    instruction,
    scope = "slides",
    slideIds = [],
  } = {}, options = {}) {
    return withJobLock(store, jobId, async () => {
      const current = await readCurrent(jobId, { alreadyLocked: true });
      if (current.number !== parentRevision) throw conflict("Candidate parent is no longer current");
      if (!["slides", "theme"].includes(scope)) throw new TypeError("Candidate scope is invalid");
      const normalizedSlideIds = uniqueSlideIds(slideIds);
      const number = await nextRevisionNumber(jobId);
      const candidateId = `.candidate-${randomUUID()}`;
      await store.copyRevisionFiles(jobId, current.revisionId, candidateId, {
        alreadyLocked: true,
        signal: options.signal,
      });
      const meta = revisionMetaSchema.parse({
        revisionId: candidateId,
        number,
        parentRevision,
        instruction: String(instruction || "").slice(0, 4_000),
        scope,
        slideIds: normalizedSlideIds,
        changedFiles: [],
        qa: null,
        createdAt: now(),
      });
      await store.writeJson(jobId, `revisions/${candidateId}/meta.json`, meta, {
        alreadyLocked: true,
        signal: options.signal,
      });
      return meta;
    });
  }

  async function recordQa(jobId, number, qa, { changedFiles = [] } = {}) {
    return withJobLock(store, jobId, async () => {
      const { candidateId, meta } = await candidateRecord(jobId, number);
      const updated = revisionMetaSchema.parse({
        ...meta,
        changedFiles: [...new Set(changedFiles)],
        qa,
      });
      await store.writeJson(jobId, `revisions/${candidateId}/meta.json`, updated, { alreadyLocked: true });
      await store.writeJson(jobId, `revisions/${candidateId}/qa/report.json`, qa, { alreadyLocked: true });
      return updated;
    });
  }

  async function publishCandidate(jobId, number, { expectedRevision, signal } = {}) {
    return withJobLock(store, jobId, async () => {
      const current = await readCurrent(jobId, { alreadyLocked: true });
      if (current.number !== expectedRevision) {
        throw conflict(`Expected revision ${expectedRevision}, current is ${current.number}`);
      }
      const { candidateId, meta } = await candidateRecord(jobId, number);
      if (meta.parentRevision !== current.number) throw conflict("Candidate parent is no longer current");
      if (meta.qa?.ok !== true) throw conflict("Candidate revision has not passed QA");
      signal?.throwIfAborted();

      const revisionId = revisionIdFor(number);
      const published = revisionMetaSchema.parse({ ...meta, revisionId });
      await store.writeJson(jobId, `revisions/${candidateId}/meta.json`, published, {
        alreadyLocked: true,
        signal,
      });
      await store.renameRevisionDirectory(jobId, candidateId, revisionId, { alreadyLocked: true, signal });

      const job = await store.readJob(jobId, { alreadyLocked: true });
      const pointer = { revision: number, revisionId, status: current.status || job.status };
      await store.writeJson(jobId, "current-revision.json", pointer, { alreadyLocked: true });
      try {
        await store.updateJob(jobId, { revision: number }, { alreadyLocked: true });
      } catch (error) {
        try {
          await store.writeJson(jobId, "current-revision.json", {
            revision: current.number,
            revisionId: current.revisionId,
            status: current.status || job.status,
          }, { alreadyLocked: true });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Revision publication rollback failed");
        }
        throw error;
      }
      return published;
    });
  }

  async function discardCandidate(jobId, number) {
    const record = await candidateRecord(jobId, number);
    return record.meta;
  }

  async function undo(jobId, { expectedRevision } = {}) {
    return withJobLock(store, jobId, async () => {
      const current = await readCurrent(jobId, { alreadyLocked: true });
      if (current.number !== expectedRevision) throw conflict("Revision changed before undo");
      const currentMeta = await readPublishedMeta(jobId, current.number);
      if (!currentMeta.parentRevision) throw conflict("No parent revision is available");
      const parent = await readPublishedMeta(jobId, currentMeta.parentRevision);
      const job = await store.readJob(jobId, { alreadyLocked: true });
      const pointer = { revision: parent.number, revisionId: parent.revisionId, status: current.status || job.status };
      await store.writeJson(jobId, "current-revision.json", pointer, { alreadyLocked: true });
      try {
        await store.updateJob(jobId, { revision: parent.number }, { alreadyLocked: true });
      } catch (error) {
        try {
          await store.writeJson(jobId, "current-revision.json", {
            revision: current.number,
            revisionId: current.revisionId,
            status: current.status || job.status,
          }, { alreadyLocked: true });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Revision undo rollback failed");
        }
        throw error;
      }
      return parent;
    });
  }

  async function resolveRevisionArtifact(jobId, artifactId) {
    if (artifactId === "slides-content" || artifactId === "design-brief") {
      const relativePath = artifactId === "slides-content" ? "slides-content.md" : "design-brief.md";
      return await store.readArtifact(jobId, relativePath, { optional: true }) === undefined
        ? undefined
        : { id: artifactId, relativePath };
    }
    if (artifactId === "deck-preview") {
      const current = await readCurrent(jobId, { optional: true });
      if (!current) return undefined;
      const relativePath = `revisions/${current.revisionId}/dist/index.html`;
      return await store.readArtifact(jobId, relativePath, { optional: true }) === undefined
        ? undefined
        : { id: artifactId, relativePath, revisionId: current.revisionId, preview: true };
    }
    if (!ASSET_ID.test(artifactId || "")) return undefined;
    const input = await store.readJson(jobId, "job-input.json", { optional: true }) || {};
    const asset = (input.uploadedAssets || []).find((candidate) => candidate?.id === artifactId);
    if (!asset || !ASSET_FILENAME.test(asset.filename || "")) return undefined;
    const relativePath = `assets/${asset.filename}`;
    return await store.readArtifact(jobId, relativePath, { optional: true, encoding: null }) === undefined
      ? undefined
      : { id: artifactId, relativePath };
  }

  return {
    createInitial,
    createCandidate,
    recordQa,
    readCurrent,
    publishCandidate,
    discardCandidate,
    undo,
    resolveRevisionArtifact,
  };
}
