import { z } from "zod";

export const deckJobStatusSchema = z.enum([
  "queued",
  "outline",
  "design",
  "calibrating",
  "building",
  "generating-assets",
  "verifying",
  "repairing",
  "ready",
  "needs-review",
  "failed",
  "cancelled",
]);

export const deckJobIdSchema = z.string().regex(
  /^job-[0-9a-f-]{36}$/,
  "Invalid deck job ID",
);

export const deckArtifactIdSchema = z.string().regex(
  /^[a-z0-9-]+$/,
  "Invalid deck artifact ID",
);

export const deckJobEventSchema = z.object({
  seq: z.number().int().positive(),
  jobId: deckJobIdSchema,
  stage: deckJobStatusSchema,
  type: z.enum(["message", "stage", "progress", "artifact", "error", "revision", "job"]),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  title: z.string().min(1).max(200),
  message: z.string().max(2_000).optional(),
  artifactId: deckArtifactIdSchema.optional(),
  error: z.object({
    code: z.string().regex(/^[A-Z0-9_]+$/),
    message: z.string().max(2_000),
    retryable: z.boolean(),
  }).strict().optional(),
  progress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  }).strict().optional(),
  revision: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
}).strict();

export const deckArtifactSchema = z.object({
  id: deckArtifactIdSchema,
  filename: z.string().min(1).max(200),
  kind: z.enum(["markdown", "html", "image", "json"]),
  stage: deckJobStatusSchema,
  revision: z.number().int().nonnegative().optional(),
  previewable: z.boolean(),
  downloadable: z.boolean(),
}).strict();

export const deckJobSnapshotSchema = z.object({
  id: deckJobIdSchema,
  title: z.string(),
  status: deckJobStatusSchema,
  failedStage: deckJobStatusSchema.optional(),
  error: z.string().optional(),
  lastSeq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  progress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  artifacts: z.array(deckArtifactSchema),
  actions: z.object({
    canCancel: z.boolean(),
    canRetry: z.boolean(),
    canMessage: z.boolean(),
    canUndo: z.boolean(),
    canDownload: z.boolean(),
  }).strict(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const slideIdSchema = z.string().regex(/^slide-\d{2}$/);

export const deckEditRequestSchema = z.object({
  instruction: z.string().trim().min(1).max(4_000),
  currentSlideId: slideIdSchema.optional(),
  slideIds: z.array(slideIdSchema).max(50)
    .refine((values) => new Set(values).size === values.length, "Slide IDs must be unique")
    .optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export type DeckJobStatus = z.infer<typeof deckJobStatusSchema>;
export type DeckJobEvent = z.infer<typeof deckJobEventSchema>;
export type DeckJobSnapshot = z.infer<typeof deckJobSnapshotSchema>;
export type DeckArtifactSummary = z.infer<typeof deckArtifactSchema>;
export type DeckEditRequest = z.infer<typeof deckEditRequestSchema>;
