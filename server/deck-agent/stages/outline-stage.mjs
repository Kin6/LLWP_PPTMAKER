import { NO_EXTERNAL_MATERIALS, parseOutline } from "../outline.mjs";
import { upstreamCallBudget } from "../upstream-budget.mjs";

const MAX_SOURCE_CONTEXT_CHARS = 120_000;
const MAX_BLOCK_CONTENT_CHARS = 8_000;
const MAX_REPAIR_DRAFT_CHARS = 120_000;
const SAFE_SOURCE_ID = /^[A-Za-z0-9._-]+$/;
const OUTLINE_MAX_TURNS = 2;

function outlineMarkdownContract({ sourceBlocks, slideCount }) {
  const hasSourceBlocks = sourceBlocks.length > 0;
  const exampleSourceId = sourceBlocks.find((block) => SAFE_SOURCE_ID.test(block?.id))?.id || "SOURCE_BLOCK_ID";
  const sourceExample = hasSourceBlocks
    ? `- 已提供材料 <!-- source:${exampleSourceId} -->`
    : `- ${NO_EXTERNAL_MATERIALS}`;
  const sourceRules = hasSourceBlocks
    ? [
        "每页至少引用一个已提供的 sourceBlockId。",
        "来源必须同时包含人类可读说明和紧随其后的 <!-- source:SOURCE_BLOCK_ID --> 注释。",
        "只能使用 sourceBlockIds 中真实存在的 ID，不得编造来源 ID、文件名、页码或 URL。",
      ]
    : [
        `每页的材料来源固定写为“${NO_EXTERNAL_MATERIALS}”`,
        "不得添加 source 注释，不得编造来源 ID、文件名、页码、引用或 URL。",
      ];

  return [
    "SLIDES-CONTENT.MD 完整格式契约",
    "必须调用 write_outline，并把完整 Markdown 放进 markdown 参数；不要只在回答文字中给出大纲。",
    "输出中不要包含代码围栏或模板起止标记。",
    "全文必须且只能有一个一级标题。一级标题是演示文稿标题。",
    `必须恰好生成 ${slideCount} 页。每页使用二级标题“## 幻灯片 N：页面标题”，N 从 1 连续编号到 ${slideCount}。`,
    "只能包含：叙事主线、页标题、核心结论、要点、讲稿提示和材料来源。",
    "上述各部分都必须有非空内容，不得加入布局、配图、字号、颜色、动画、HTML 或 CSS 指令。",
    ...sourceRules,
    "",
    "严格使用以下模板，并按页数重复幻灯片区块：",
    "",
    "# 演示文稿标题",
    "",
    "> **叙事主线：** 用一句话说明从开场到结尾的推进关系",
    "",
    "## 幻灯片 1：页面标题",
    "",
    "**核心结论：** 本页唯一、明确、可讲述的结论",
    "",
    "**要点：**",
    "",
    "- 支撑结论的要点一",
    "- 支撑结论的要点二",
    "",
    "**讲稿提示：** 说明如何讲解本页，以及如何承接上一页或引向下一页",
    "",
    "**材料来源：**",
    "",
    sourceExample,
  ].join("\n");
}

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

function repairContext(attempt, lastError, previousMarkdown) {
  if (attempt === 0) return undefined;
  return {
    validationError: lastError?.message || "The previous attempt did not write a valid outline",
    previousMarkdown: previousMarkdown
      ? previousMarkdown.slice(0, MAX_REPAIR_DRAFT_CHARS)
      : "（上一轮没有调用 write_outline，因此没有可修复的 Markdown；请按完整模板重新生成。）",
    previousMarkdownTruncated: Boolean(previousMarkdown && previousMarkdown.length > MAX_REPAIR_DRAFT_CHARS),
    instruction: "修复校验错误后，必须再次调用 write_outline 写入完整 Markdown。不要只描述修改。",
  };
}

function buildOutlineMessages(context, skill, attempt, lastError, previousMarkdown) {
  const hasSourceBlocks = context.sourceBlocks.length > 0;
  return [
    {
      role: "system",
      content: [
        skill.instructions,
        outlineMarkdownContract({
          sourceBlocks: context.sourceBlocks,
          slideCount: context.input.source.slideCount,
        }),
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        task: attempt === 0 ? "Write slides-content.md" : "Repair slides-content.md after validation failure",
        topic: context.input.source.topic,
        userRequest: context.input.source.textInput || context.input.source.topic,
        audience: context.input.source.audience,
        slideCount: context.input.source.slideCount,
        sourceMode: hasSourceBlocks ? "provided-materials" : "topic-only",
        sourceBlockIds: context.sourceBlocks.map((block) => block.id),
        sourceMaterial: sourceContext(context.sourceBlocks),
        repair: repairContext(attempt, lastError, previousMarkdown),
        requirements: [
          "narrative structure", "slide titles", "core conclusions", "key points",
          "speaker-note hints", "human-readable material sources",
          "no visual directives", "no confirmation gate",
        ],
      }),
    },
  ];
}

function captureOutlineCandidate(allowedTools, onCandidate) {
  const writeOutline = allowedTools.write_outline;
  return {
    ...allowedTools,
    write_outline: {
      ...writeOutline,
      execute: async (input, runtime) => {
        onCandidate(input.markdown);
        return writeOutline.execute(input, runtime);
      },
    },
  };
}

export async function runOutlineStage(context) {
  const skill = await context.skillLoader.load("outline");
  let lastError;
  let previousMarkdown = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let candidateMarkdown;
    try {
      const allowedTools = captureOutlineCandidate(
        context.tools.forStage("outline", context),
        (markdown) => { candidateMarkdown = markdown; },
      );
      await context.runner.runStage({
        jobId: context.jobId,
        stage: "outline",
        messages: buildOutlineMessages(context, skill, attempt, lastError, previousMarkdown),
        allowedTools,
        requiredToolName: "write_outline",
        maxTurns: OUTLINE_MAX_TURNS,
        maxUpstreamCalls: upstreamCallBudget(OUTLINE_MAX_TURNS),
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
      if (typeof candidateMarkdown === "string") previousMarkdown = candidateMarkdown;
    }
  }
  throw new Error(`Outline validation failed after one repair: ${lastError?.message || "unknown error"}`);
}
