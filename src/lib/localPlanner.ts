import type { GeneratedAsset, NotebookDeckSpec, NotebookSlideSpec } from "../types";
import type { ExtractedBlock } from "./attachmentParser";

export type LocalSource = {
  topic: string;
  audience: string;
  slideCount: number;
  textInput: string;
  tableInput: string;
  imageBrief: string;
  styleId: string;
  assets: GeneratedAsset[];
  sourceBlocks?: ExtractedBlock[];
};

export function buildLocalDeck(source: LocalSource): NotebookDeckSpec {
  const materialText = (source.sourceBlocks || []).filter((block) => block.type === "heading" || block.type === "paragraph").map((block) => block.text).filter(Boolean).join("\n");
  const statements = splitStatements([source.textInput, materialText].filter(Boolean).join("\n"));
  const structuredTable = (source.sourceBlocks || []).find((block) => block.type === "table" && block.rows?.length)?.rows;
  const tableRows = structuredTable || parseTable(source.tableInput);
  const count = clamp(source.slideCount, 1, 50);
  const thesis = statements[0] || `${source.topic}需要一条从问题到行动的清晰叙事`;
  const evidence = statements.slice(1);
  const uploaded = source.assets.filter((asset) => asset.kind === "upload");
  const slides: NotebookSlideSpec[] = [];
  const coverRefs = sourceRefsForSlide(source.sourceBlocks, 0);

  slides.push({
    title: source.topic || "未命名演示文稿",
    subtitle: `面向${source.audience || "通用受众"}的可编辑演示文稿`,
    layout: "cover",
    claim: thesis,
    bullets: [compact(thesis, 52)],
    speakerNotes: "先给出核心判断，再说明证据链和下一步。",
    sourceNotes: coverRefs?.map(sourceRefLabel) || ["本地规则：来自用户文字"],
    sourceRefs: coverRefs,
    imageIndex: uploaded[0]?.index,
    visualBrief: source.imageBrief || "用一张主题明确的主视觉建立演示气质",
    imagePrompt: `${source.topic}，${source.imageBrief}，16:9 演示主视觉，无文字`,
  });

  const templates = [
    ["为什么现在需要处理这个问题", "把背景压缩为与决策有关的变化"],
    ["证据显示，关键矛盾集中在少数因素", "用材料中的事实支撑核心判断"],
    ["方案应沿着一条可执行路径展开", "从判断过渡到模块与动作"],
    ["优先级决定资源如何投入", "把表格或数字转化为比较"],
    ["下一步需要明确负责人和验证点", "收束为可执行行动"],
  ];

  for (let index = 1; index < count; index += 1) {
    const isLast = index === count - 1;
    const template = templates[Math.min(index - 1, templates.length - 1)];
    const start = Math.max(0, (index - 1) * 2);
    const bullets = evidence.slice(start, start + 3).map((item) => compact(item, 76));
    if (!bullets.length) bullets.push(template[1]);
    const useTable = Boolean(tableRows.length > 1 && (index === 2 || index === count - 2));
    const asset = uploaded[index % Math.max(uploaded.length, 1)];
    const sourceRefs = sourceRefsForSlide(source.sourceBlocks, index, useTable ? "table" : undefined);
    slides.push({
      title: isLast ? "把结论转化为可验证的下一步" : template[0],
      subtitle: template[1],
      layout: isLast ? "takeaway" : index % 2 ? "visual-right" : "visual-left",
      claim: bullets[0],
      bullets,
      speakerNotes: `这一页只回答一个问题：${template[0]}。`,
      sourceNotes: sourceRefs?.map(sourceRefLabel) || [useTable ? "本地规则：来自用户表格" : "本地规则：来自用户文字"],
      sourceRefs,
      imageIndex: useTable ? undefined : asset?.index,
      tableRows: useTable ? tableRows.slice(0, 7).map((row) => row.slice(0, 5)) : undefined,
      visualBrief: useTable ? "保留为原生可编辑表格" : source.imageBrief || "使用用户图片作为证据或主视觉",
      imagePrompt: `${template[0]}，${source.topic}，主题视觉，无文字，留出标题和正文空间`,
      callouts: isLast ? [{ label: "交付", value: "可编辑 PPTX" }] : [],
    });
  }

  return {
    title: source.topic || "未命名演示文稿",
    theme: source.styleId === "cinematic-dark" ? "dark-executive" : source.styleId === "editorial-tech" ? "editorial-visual" : "light-consulting",
    story: {
      thesis,
      audienceInsight: `${source.audience || "受众"}需要先看到结论，再核对证据与行动。`,
      narrativeArc: ["结论", "背景", "证据", "方案", "行动"],
      evidenceGaps: statements.length < 4 ? ["当前材料较少，建议补充量化证据或案例。"] : [],
      styleId: source.styleId,
    },
    slides,
  };
}

function sourceRefsForSlide(blocks: ExtractedBlock[] | undefined, slideIndex: number, preferredType?: ExtractedBlock["type"]) {
  const candidates = (blocks || []).filter((block) => !preferredType || block.type === preferredType);
  const fallback = candidates.length ? candidates : blocks || [];
  if (!fallback.length) return undefined;
  const start = Math.min(slideIndex * 2, Math.max(0, fallback.length - 1));
  return fallback.slice(start, start + 3).map((block) => block.source);
}

function sourceRefLabel(source: ExtractedBlock["source"]) {
  const location = [
    source.page ? `第 ${source.page} 页` : "",
    source.sectionPath?.length ? `章节：${source.sectionPath.join(" > ")}` : "",
    source.tableIndex ? `表格 ${source.tableIndex}` : "",
    source.imageIndex ? `图片 ${source.imageIndex}` : "",
    source.extraction === "ocr" ? `OCR${source.confidence !== undefined ? ` ${Math.round(source.confidence)}%` : ""}${source.lowConfidence ? "，低置信度，待核实" : ""}` : "",
  ].filter(Boolean);
  return `${source.filename}${location.length ? `，${location.join("，")}` : ""}`;
}

export function parseTable(input: string) {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const separator = lines[0].includes("\t") ? "\t" : lines[0].includes("|") ? "|" : ",";
  return lines.map((line) => line.split(separator).map((cell) => cell.trim())).filter((row) => row.some(Boolean));
}

function splitStatements(input: string) {
  return input
    .replace(/\r/g, "")
    .split(/\n+|(?<=[。！？；])/)
    .map((item) => item.replace(/^[-*\d.、\s]+/, "").trim())
    .filter((item) => item.length > 3)
    .slice(0, 24);
}

function compact(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value || min)));
}
