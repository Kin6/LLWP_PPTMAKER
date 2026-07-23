import { z } from "zod";

export const JOB_STAGES = [
  "queued", "outline", "design", "calibrating", "building",
  "generating-assets", "verifying", "repairing",
];
export const TERMINAL_JOB_STATUSES = ["ready", "needs-review", "failed", "cancelled"];
export const JOB_STATUSES = [...JOB_STAGES, ...TERMINAL_JOB_STATUSES];

const jobStatusSchema = z.enum(JOB_STATUSES);
const sourceLocationSchema = z.object({
  blockId: z.string().min(1), attachmentId: z.string().min(1), filename: z.string().min(1),
  kind: z.enum(["docx", "pdf", "pptx", "xlsx", "text", "image"]),
  extraction: z.enum(["native", "ocr"]), page: z.number().int().positive().optional(),
  sectionPath: z.array(z.string()).optional(), paragraphIndex: z.number().int().nonnegative().optional(),
  tableIndex: z.number().int().nonnegative().optional(), imageIndex: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(100).optional(), lowConfidence: z.boolean().optional(),
}).strict();

export const createJobRequestSchema = z.object({
  source: z.object({
    topic: z.string().min(1).max(500), audience: z.string().max(500), slideCount: z.number().int().min(1).max(50),
    textInput: z.string().max(2_000_000), tableInput: z.string().max(1_000_000), imageBrief: z.string().max(10_000),
    styleId: z.string().max(80), images: z.array(z.object({ name: z.string(), dataUrl: z.string(), summary: z.string() }).strict()).max(50),
    sourceBlocks: z.array(z.object({ id: z.string(), type: z.enum(["heading", "paragraph", "table", "image", "notice"]), text: z.string().optional(), level: z.number().optional(), rows: z.array(z.array(z.string())).optional(), assetId: z.string().optional(), source: sourceLocationSchema }).strict()).max(20_000),
  }).strict(),
  options: z.object({ imageEnabled: z.boolean(), imageCount: z.number().int().min(0).max(50), imageQuality: z.enum(["low", "medium", "high"]), imageTimeoutMs: z.number().int().min(240_000).max(900_000), imageMaxRetries: z.number().int().min(0).max(1) }).strict(),
}).strip();

export const deckEventSchema = z.object({
  seq: z.number().int().positive(), jobId: z.string().regex(/^job-[0-9a-f-]{36}$/), stage: jobStatusSchema,
  type: z.enum(["message", "stage", "progress", "artifact", "error", "revision", "job"]),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]), title: z.string().min(1).max(200),
  message: z.string().max(2_000).optional(), artifactId: z.string().regex(/^[a-z0-9-]+$/).optional(),
  error: z.object({ code: z.string().regex(/^[A-Z0-9_]+$/), message: z.string().max(2_000), retryable: z.boolean() }).strict().optional(),
  progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().positive() }).strict().optional(),
  revision: z.number().int().nonnegative().optional(), createdAt: z.string().datetime(),
}).strict();

export const deckJobSchema = z.object({
  id: z.string().regex(/^job-[0-9a-f-]{36}$/), title: z.string(), status: jobStatusSchema,
  failedStage: jobStatusSchema.optional(), error: z.string().optional(), lastSeq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(), attempts: z.record(z.string(), z.number().int().nonnegative()),
  checkpoints: z.array(z.string()), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();

export const deckArtifactSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/), filename: z.string().min(1).max(200), kind: z.enum(["markdown", "html", "image", "json"]), stage: jobStatusSchema, revision: z.number().int().nonnegative().optional(), previewable: z.boolean(), downloadable: z.boolean() }).strict();
export const deckJobSnapshotSchema = z.object({
  id: z.string().regex(/^job-[0-9a-f-]{36}$/), title: z.string(), status: jobStatusSchema, failedStage: jobStatusSchema.optional(),
  source: z.object({ topic: z.string(), audience: z.string(), slideCount: z.number().int().min(1).max(50) }).strict(),
  error: z.string().optional(), lastSeq: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
  artifacts: z.array(deckArtifactSchema), actions: z.object({ canCancel: z.boolean(), canRetry: z.boolean(), canMessage: z.boolean(), canUndo: z.boolean(), canDownload: z.boolean() }).strict(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();

const TRANSITIONS = new Map([
  ["queued", new Set(["outline", "cancelled", "failed"])], ["outline", new Set(["design", "failed", "cancelled"])],
  ["design", new Set(["calibrating", "failed", "cancelled"])], ["calibrating", new Set(["building", "failed", "cancelled"])],
  ["building", new Set(["generating-assets", "failed", "cancelled"])], ["generating-assets", new Set(["verifying", "failed", "cancelled"])],
  ["verifying", new Set(["repairing", "ready", "needs-review", "failed", "cancelled"])],
  ["repairing", new Set(["ready", "needs-review", "failed", "cancelled"])],
]);
const NEXT = new Map([["queued", "outline"], ["outline", "design"], ["design", "calibrating"], ["calibrating", "building"], ["building", "generating-assets"], ["generating-assets", "verifying"]]);

export function assertJobTransition(from, to) {
  if (!TRANSITIONS.get(from)?.has(to)) throw new Error(`Invalid job transition: ${from} -> ${to}`);
}
export function assertResumeTransition(from, to) {
  if (!["failed", "cancelled", "needs-review"].includes(from) || !JOB_STAGES.includes(to) || to === "queued") throw new Error(`Invalid resume transition: ${from} -> ${to}`);
}
export function nextStageAfter(status) { return NEXT.get(status); }
