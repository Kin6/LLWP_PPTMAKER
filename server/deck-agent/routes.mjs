import path from "node:path";
import express from "express";
import { parse } from "parse5";
import { z } from "zod";
import { HttpError } from "../shared/errors.mjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const ARTIFACT_ID = /^[a-z0-9-]+$/;
const SLIDE_ID = /^slide-\d{2}$/;
const MIME_TYPES = Object.freeze({
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
});
const FALLBACK_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'none'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const editRequestSchema = z.object({
  instruction: z.string().trim().min(1).max(4_000),
  currentSlideId: z.string().regex(SLIDE_ID).optional(),
  slideIds: z.array(z.string().regex(SLIDE_ID)).max(50).refine(
    (slideIds) => new Set(slideIds).size === slideIds.length,
    "slideIds must be unique",
  ).optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export const undoRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

function validateJobId(value) {
  if (!JOB_ID.test(value)) throw new HttpError(400, "Invalid job id");
  return value;
}

function parseSequence(value) {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new HttpError(400, "Event sequence must be a nonnegative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, "Event sequence is too large");
  return parsed;
}

function errorStatus(error) {
  const explicit = Number(error?.status ?? error?.statusCode);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError) return 400;
  if (/not found|enoent/i.test(String(error?.message || ""))) return 404;
  if (/quota|too large|limit exceeded/i.test(String(error?.message || ""))) return 413;
  if (/conflict|not (?:cancellable|retryable|available)|revision changed|invalid .*transition/i.test(String(error?.message || ""))) return 409;
  if (/invalid .*path|path-like|sequence|unknown artifact/i.test(String(error?.message || ""))) return 400;
  return 500;
}

function errorBody(error) {
  const message = error instanceof z.ZodError
    ? "Request validation failed"
    : error instanceof Error ? error.message : "Unknown server error";
  return { ok: false, error: String(message).slice(0, 2_000) };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

function accepted(operation) {
  return asyncRoute(async (req, res) => {
    noStore(res);
    res.status(202).json({ ok: true, job: await operation(req) });
  });
}

function contentTypeFor(relativePath) {
  return MIME_TYPES[path.extname(relativePath).toLowerCase()] || "application/octet-stream";
}

function safeFilename(relativePath) {
  return path.basename(relativePath).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "artifact";
}

function cspFromHtml(html) {
  if (typeof html !== "string") return FALLBACK_PREVIEW_CSP;
  const document = parse(html);
  const pending = [document];
  while (pending.length) {
    const node = pending.pop();
    if (node?.tagName === "meta") {
      const attributes = new Map((node.attrs || []).map((attribute) => [
        attribute.name.toLowerCase(),
        attribute.value,
      ]));
      if (attributes.get("http-equiv")?.toLowerCase() === "content-security-policy") {
        const policy = attributes.get("content") || "";
        if (policy.length <= 8_192
          && !/[\u0000-\u001f\u007f]/.test(policy)
          && /(?:^|;)\s*default-src\s+'none'(?:\s*;|$)/i.test(policy)) return policy;
        return FALLBACK_PREVIEW_CSP;
      }
    }
    pending.push(...(node?.childNodes || []));
  }
  return FALLBACK_PREVIEW_CSP;
}

async function sendManifestArtifact(req, res, { store, revisions }) {
  const jobId = validateJobId(req.params.jobId);
  const artifactId = req.params.artifactId;
  if (!ARTIFACT_ID.test(artifactId)) throw new HttpError(400, "Invalid artifact id");
  await store.readJob(jobId);
  if (!revisions?.resolveRevisionArtifact) throw new HttpError(503, "Artifact manifest resolver is unavailable");
  const resolved = await revisions.resolveRevisionArtifact(jobId, artifactId);
  if (!resolved || resolved.id !== artifactId || typeof resolved.relativePath !== "string") {
    throw new HttpError(404, "Deck artifact not found");
  }

  let body = resolved.body;
  if (body === undefined && resolved.preview && req.query.download !== "1" && revisions.renderPreview) {
    body = await revisions.renderPreview(jobId, resolved);
  }
  if (body === undefined) {
    body = await store.readArtifact(jobId, resolved.relativePath, {
      encoding: [".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(resolved.relativePath).toLowerCase())
        ? null
        : "utf8",
    });
  }

  const contentType = resolved.contentType || contentTypeFor(resolved.relativePath);
  res.setHeader("Content-Type", contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (resolved.preview || contentType.startsWith("text/html")) {
    noStore(res);
    res.setHeader("Content-Security-Policy", cspFromHtml(body));
  }
  if (req.query.download === "1") {
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(resolved.relativePath)}"`);
  }
  res.status(200).send(body);
}

export function createDeckJobRouter({ manager, events, store, revisions, parentOrigin } = {}) {
  if (!manager?.create || !manager?.get || !manager?.cancel || !manager?.retry || !manager?.message || !manager?.undo) {
    throw new TypeError("Deck job router requires a job manager");
  }
  if (!events?.pipeNdjson) throw new TypeError("Deck job router requires an event store");
  if (!store?.readArtifact || !store?.readJob) throw new TypeError("Deck job router requires an artifact store");
  const origin = new URL(parentOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== parentOrigin) {
    throw new TypeError("Deck job router requires an exact HTTP parent origin");
  }

  const router = express.Router();
  router.post("/jobs", accepted((req) => manager.create(req.body)));
  router.get("/jobs/:jobId", asyncRoute(async (req, res) => {
    noStore(res);
    res.json({ ok: true, job: await manager.get(validateJobId(req.params.jobId)) });
  }));
  router.get("/jobs/:jobId/events", asyncRoute(async (req, res) => {
    const jobId = validateJobId(req.params.jobId);
    const after = parseSequence(req.query.after);
    await manager.get(jobId);
    noStore(res);
    await events.pipeNdjson(req, res, { jobId, after });
  }));
  router.get("/jobs/:jobId/artifacts/:artifactId", asyncRoute((req, res) => (
    sendManifestArtifact(req, res, { store, revisions })
  )));
  router.post("/jobs/:jobId/cancel", accepted((req) => manager.cancel(validateJobId(req.params.jobId))));
  router.post("/jobs/:jobId/retry", accepted((req) => manager.retry(validateJobId(req.params.jobId))));
  router.post("/jobs/:jobId/messages", accepted((req) => manager.message(
    validateJobId(req.params.jobId),
    editRequestSchema.parse(req.body),
  )));
  router.post("/jobs/:jobId/undo", accepted((req) => manager.undo(
    validateJobId(req.params.jobId),
    undoRequestSchema.parse(req.body),
  )));

  router.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    noStore(res);
    res.status(errorStatus(error)).json(errorBody(error));
  });
  return router;
}
