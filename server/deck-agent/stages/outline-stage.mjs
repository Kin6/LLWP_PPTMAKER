import { parseOutline } from "../outline.mjs";

const MAX_SOURCE_CONTEXT_CHARS = 120_000;
const MAX_BLOCK_CONTENT_CHARS = 8_000;

function blockContent(block) {
  if (typeof block?.text === "string") return block.text;
  if (Array.isArray(block?.rows)) return block.rows.map((row) => row.join(" | ")).join("\n");
  return "";
}

function sourceContext(blocks) {
  const packed = [];
  let used = 2;
  for (const block of blocks || []) {
    const content = blockContent(block);
    const entry = {
      id: block.id,
      type: block.type,
      content: content.slice(0, MAX_BLOCK_CONTENT_CHARS),
      truncated: content.length > MAX_BLOCK_CONTENT_CHARS,
      ...(block.level === undefined ? {} : { level: block.level }),
      ...(block.assetId === undefined ? {} : { assetId: block.assetId }),
      ...(block.source === undefined ? {} : { source: block.source }),
    };
    const size = JSON.stringify(entry).length + 1;
    if (used + size > MAX_SOURCE_CONTEXT_CHARS) break;
    packed.push(entry);
    used += size;
  }
  return {
    blocks: packed,
    omittedBlockCount: Math.max(0, (blocks?.length || 0) - packed.length),
  };
}

function initialManifest(outline) {
  return {
    title: outline.title,
    narrative: outline.narrative,
    designRulesLocked: false,
    slides: outline.slides.map((slide) => ({
      slideId: slide.slideId,
      number: slide.number,
      title: slide.title,
      claim: slide.claim,
      speakerNotes: slide.speakerNotes,
      sourceRefs: [...slide.sourceBlockIds],
      sourceBlockIds: [...slide.sourceBlockIds],
      densityScore: slide.densityScore,
      assetSlots: [],
      charts: [],
      status: "pending",
    })),
  };
}

function buildOutlineMessages(context, skill, attempt) {
  return [
    { role: "system", content: skill.instructions },
    {
      role: "user",
      content: JSON.stringify({
        task: attempt === 0 ? "Write slides-content.md" : "Repair slides-content.md after validation failure",
        topic: context.input.source.topic,
        audience: context.input.source.audience,
        slideCount: context.input.source.slideCount,
        sourceBlockIds: context.sourceBlocks.map((block) => block.id),
        sourceMaterial: sourceContext(context.sourceBlocks),
        requirements: [
          "narrative structure", "slide titles", "core conclusions", "key points",
          "speaker-note hints", "human-readable material sources with source comments",
          "no visual directives", "no confirmation gate",
        ],
      }),
    },
  ];
}

export async function runOutlineStage(context) {
  const skill = await context.skillLoader.load("outline");
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await context.runner.runStage({
        jobId: context.jobId,
        stage: "outline",
        messages: buildOutlineMessages(context, skill, attempt),
        allowedTools: context.tools.forStage("outline", context),
        maxTurns: 2,
        maxUpstreamCalls: 2,
        timeoutMs: 120_000,
        signal: context.signal,
        emit: context.emit,
      });
      const markdown = await context.store.readArtifact(context.jobId, "slides-content.md", { optional: true });
      const outline = parseOutline(markdown || "", {
        expectedSlideCount: context.input.source.slideCount,
        sourceBlockIds: new Set(context.sourceBlocks.map((block) => block.id)),
      });
      await context.store.writeJson(context.jobId, "working/manifest.json", initialManifest(outline), { signal: context.signal });
      await context.emit({
        stage: "outline",
        type: "artifact",
        status: "done",
        title: "整理幻灯片内容大纲并写入 Markdown",
        artifactId: "slides-content",
        progress: { completed: 1, total: 1 },
      });
      return outline;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Outline validation failed after one repair: ${lastError?.message || "unknown error"}`);
}
