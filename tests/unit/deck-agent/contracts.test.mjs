import { describe, expect, it } from "vitest";
import {
  assertJobTransition,
  assertResumeTransition,
  createJobRequestSchema,
  deckEventSchema,
  nextStageAfter,
} from "../../../server/deck-agent/contracts.mjs";

describe("deck job contracts", () => {
  it("accepts the deterministic happy-path transitions", () => {
    expect(() => assertJobTransition("queued", "outline")).not.toThrow();
    expect(() => assertJobTransition("verifying", "repairing")).not.toThrow();
    expect(() => assertJobTransition("verifying", "ready")).not.toThrow();
    expect(nextStageAfter("calibrating")).toBe("building");
  });

  it("rejects skipped stages and terminal transitions", () => {
    expect(() => assertJobTransition("outline", "building")).toThrow(/outline -> building/);
    expect(() => assertJobTransition("ready", "outline")).toThrow(/ready -> outline/);
    expect(() => assertResumeTransition("failed", "building")).not.toThrow();
    expect(() => assertResumeTransition("ready", "building")).toThrow(/resume/i);
  });

  it("rejects event fields that could expose internals", () => {
    const result = deckEventSchema.safeParse({
      seq: 1,
      jobId: "job-00000000-0000-4000-8000-000000000001",
      stage: "outline",
      type: "stage",
      status: "running",
      title: "整理幻灯片内容大纲并写入 Markdown",
      createdAt: "2026-07-22T00:00:00.000Z",
      prompt: "secret system prompt",
    });
    expect(result.success).toBe(false);
  });

  it("preserves OCR confidence percentages and ignores client-supplied provider credentials", () => {
    const parsed = createJobRequestSchema.parse({
      source: {
        topic: "主题", audience: "管理层", slideCount: 8, textInput: "材料", tableInput: "", imageBrief: "", styleId: "blank", images: [],
        sourceBlocks: [{ id: "block-001", type: "paragraph", text: "OCR 材料", source: { blockId: "block-001", attachmentId: "attachment-001", filename: "scan.pdf", kind: "pdf", extraction: "ocr", page: 1, confidence: 64, lowConfidence: true } }],
      },
      options: { imageEnabled: true, imageCount: 3, imageQuality: "high", imageTimeoutMs: 600000, imageMaxRetries: 1 },
      apiKey: "must-not-survive",
    });
    expect(parsed.source.sourceBlocks[0].source.confidence).toBe(64);
    expect(parsed).not.toHaveProperty("apiKey");
  });

  it("rejects more than one HTML image retry", () => {
    const result = createJobRequestSchema.safeParse({
      source: { topic: "主题", audience: "管理层", slideCount: 8, textInput: "材料", tableInput: "", imageBrief: "", styleId: "blank", images: [], sourceBlocks: [] },
      options: { imageEnabled: true, imageCount: 3, imageQuality: "high", imageTimeoutMs: 600000, imageMaxRetries: 2 },
    });
    expect(result.success).toBe(false);
  });
});
