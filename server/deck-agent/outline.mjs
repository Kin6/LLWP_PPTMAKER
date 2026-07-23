import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const processor = unified().use(remarkParse).use(remarkGfm);
const SLIDE_HEADING = /^幻灯片\s+(\d+)[:：]\s*(.+)$/;
const SOURCE_COMMENT = /^<!--\s*source:([A-Za-z0-9._-]+)\s*-->$/;
const VISUAL_LABEL = /^(布局|版式|配图|图片提示|视觉方向|坐标|字号|颜色|动画|layout|image prompt|css|html)$/i;
const SPEAKER_NOTE_LABELS = new Set(["演讲备注", "讲稿提示"]);
export const NO_EXTERNAL_MATERIALS = "未提供外部材料；内容基于模型通用知识生成，重要事实需核验。";

export function parseOutline(markdown, { expectedSlideCount, sourceBlockIds }) {
  const tree = processor.parse(markdown);
  const h1 = tree.children.filter((node) => node.type === "heading" && node.depth === 1);
  if (h1.length !== 1) throw new Error("Outline must contain exactly one H1");

  walkNodes(tree.children, (node) => {
    if (node.type === "html" && !SOURCE_COMMENT.test(node.value.trim())) {
      throw new Error("Only source comments are allowed HTML");
    }
  });

  const boundaries = tree.children
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type === "heading" && node.depth === 2);
  walkNodes(tree.children.slice(0, boundaries[0]?.index ?? tree.children.length), (node) => {
    if (node.type === "html" && SOURCE_COMMENT.test(node.value.trim())) {
      throw new Error("Source comment must appear inside 材料来源");
    }
  });
  const slides = boundaries.map(({ node, index }, slideIndex) => parseSlide(
    markdown,
    tree.children.slice(index, boundaries[slideIndex + 1]?.index ?? tree.children.length),
    node,
    slideIndex,
    sourceBlockIds,
  ));
  if (slides.length !== expectedSlideCount) {
    throw new Error(`Expected ${expectedSlideCount} slides but found ${slides.length}`);
  }

  const narrative = readNarrative(tree);
  if (!narrative) throw new Error("Outline must contain a narrative line");
  return { title: toString(h1[0]).trim(), narrative, slides };
}

export function removeSpeakerNotes(markdown) {
  if (typeof markdown !== "string") throw new TypeError("Outline Markdown must be a string");
  const tree = processor.parse(markdown);
  const ranges = [];
  let rangeStart;

  for (const node of tree.children) {
    const offset = node.position?.start?.offset;
    if (!Number.isInteger(offset)) throw new Error("Markdown parser did not provide source positions");
    const label = node.type === "heading" && node.depth === 3
      ? readHeadingLabel(node)
      : node.type === "paragraph" ? readStrongLabel(node) : undefined;
    const endsSection = (node.type === "heading" && node.depth <= 2) || label !== undefined;

    if (rangeStart !== undefined && endsSection) {
      ranges.push([rangeStart, offset]);
      rangeStart = undefined;
    }
    if (label && SPEAKER_NOTE_LABELS.has(label)) rangeStart = offset;
  }
  if (rangeStart !== undefined) ranges.push([rangeStart, markdown.length]);
  if (ranges.length === 0) return markdown;

  let cursor = 0;
  let visible = "";
  for (const [start, end] of ranges) {
    visible += markdown.slice(cursor, start);
    cursor = end;
  }
  return `${visible}${markdown.slice(cursor)}`;
}

export function projectVisibleOutline(outline, { slideIds } = {}) {
  if (!outline || !Array.isArray(outline.slides)) throw new TypeError("Parsed outline is required");
  const selected = slideIds === undefined ? undefined : new Set(slideIds);
  return {
    title: outline.title,
    narrative: outline.narrative,
    slides: outline.slides
      .filter((slide) => !selected || selected.has(slide.slideId))
      .map((slide) => ({
        slideId: slide.slideId,
        number: slide.number,
        title: slide.title,
        claim: slide.claim,
        markdown: removeSpeakerNotes(
          typeof slide.visibleMarkdown === "string"
            ? slide.visibleMarkdown
            : typeof slide.rawMarkdown === "string" ? slide.rawMarkdown : "",
        ),
        sourceBlockIds: Array.isArray(slide.sourceBlockIds) ? [...slide.sourceBlockIds] : [],
      })),
  };
}

function parseSlide(markdown, nodes, heading, slideIndex, sourceBlockIds) {
  const match = toString(heading).trim().match(SLIDE_HEADING);
  if (!match || Number(match[1]) !== slideIndex + 1) {
    throw new Error(`Slide numbering must be continuous at ${slideIndex + 1}`);
  }

  const labels = readLabeledSections(nodes);
  for (const label of labels.keys()) {
    if (VISUAL_LABEL.test(label)) throw new Error(`Forbidden visual directive: ${label}`);
  }
  walkNodes(nodes, (node) => {
    const label = readStrongLabel(node) || readHeadingLabel(node);
    if (label && VISUAL_LABEL.test(label)) throw new Error(`Forbidden visual directive: ${label}`);
  });

  const claim = labels.get("核心观点") || labels.get("核心结论");
  const speakerNotes = labels.get("演讲备注") || labels.get("讲稿提示");
  const refs = readSourceReferences(nodes);

  const slideId = `slide-${String(slideIndex + 1).padStart(2, "0")}`;
  const sourcesRequired = sourceBlockIds.size > 0;
  const sourceText = labels.get("材料来源")?.trim();
  if (!claim || !speakerNotes || !sourceText || (sourcesRequired && refs.length === 0)) {
    throw new Error(`${slideId} lacks claim, speaker notes, or sources`);
  }
  if (!sourcesRequired && sourceText !== NO_EXTERNAL_MATERIALS) {
    throw new Error(`${slideId} requires the no-external-material disclosure`);
  }
  for (const blockId of refs) {
    if (!sourceBlockIds.has(blockId)) throw new Error(`Unknown source reference: ${blockId}`);
  }

  const rawMarkdown = sliceByPositions(markdown, nodes);
  const visibleMarkdown = removeSpeakerNotes(rawMarkdown);
  return {
    slideId,
    number: slideIndex + 1,
    title: match[2].trim(),
    claim,
    speakerNotes,
    sourceBlockIds: [...new Set(refs)],
    sectionLabels: [...labels.keys()],
    rawMarkdown,
    visibleMarkdown,
    densityScore: scoreNodes(processor.parse(visibleMarkdown).children),
  };
}

export function selectCalibrationSlides(outline) {
  const dense = outline.slides.slice(1)
    .sort((left, right) => right.densityScore - left.densityScore || left.number - right.number)[0]
    || outline.slides[0];
  return [...new Set([outline.slides[0].slideId, dense.slideId])];
}

function walkNodes(nodes, visitor) {
  for (const node of nodes) {
    visitor(node);
    if (Array.isArray(node.children)) walkNodes(node.children, visitor);
  }
}

function readLabeledSections(nodes) {
  const sections = new Map();
  let currentLabel;
  for (const node of nodes) {
    if (node.type === "heading" && node.depth === 3) {
      currentLabel = toString(node).replace(/[：:]$/, "").trim();
      sections.set(currentLabel, "");
      continue;
    }

    const strongLabel = node.type === "paragraph" ? readStrongLabel(node) : undefined;
    if (strongLabel) {
      currentLabel = strongLabel;
      const inline = toString({ type: "root", children: node.children.slice(1) })
        .replace(/^[\s：:]+/, "")
        .trim();
      sections.set(currentLabel, inline);
      continue;
    }

    if (currentLabel && !["heading", "html"].includes(node.type)) {
      const text = toString(node).trim();
      if (text) sections.set(currentLabel, [sections.get(currentLabel), text].filter(Boolean).join("\n"));
    }
  }
  return sections;
}

function readStrongLabel(node) {
  const first = node.children?.[0];
  const rawLabel = first?.type === "strong" ? toString(first).trim() : "";
  return rawLabel.endsWith("：") || rawLabel.endsWith(":")
    ? rawLabel.replace(/[：:]$/, "").trim()
    : undefined;
}

function readHeadingLabel(node) {
  if (node.type !== "heading" || node.depth < 3) return undefined;
  return toString(node).split(/[：:]/, 1)[0].trim();
}

function readSourceReferences(nodes) {
  const refs = [];
  let currentLabel;
  for (const node of nodes) {
    if (node.type === "heading" && node.depth === 3) {
      currentLabel = toString(node).replace(/[：:]$/, "").trim();
    } else if (node.type === "paragraph") {
      currentLabel = readStrongLabel(node) || currentLabel;
    }
    walkNodes([node], (nested) => {
      const ref = nested.type === "html" ? nested.value.trim().match(SOURCE_COMMENT)?.[1] : undefined;
      if (!ref) return;
      if (currentLabel !== "材料来源") {
        throw new Error("Source comment must appear inside 材料来源");
      }
      refs.push(ref);
    });
  }
  return refs;
}

function readNarrative(tree) {
  const quote = tree.children.find((node) => node.type === "blockquote" && /叙事主线/.test(toString(node)));
  return quote ? toString(quote).replace(/^\s*叙事主线\s*[：:]\s*/, "").trim() : "";
}

function sliceByPositions(markdown, nodes) {
  const start = nodes[0]?.position?.start?.offset;
  const end = nodes.at(-1)?.position?.end?.offset;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error("Markdown parser did not provide source positions");
  }
  return markdown.slice(start, end);
}

function scoreNodes(nodes) {
  let score = 0;
  const labels = new Set();
  walkNodes(nodes, (node) => {
    if (["text", "inlineCode", "code"].includes(node.type)) score += String(node.value || "").trim().length;
    if (node.type === "listItem") score += 40;
    if (node.type === "tableCell") score += 60;
    if (node.type === "paragraph" && node.children?.[0]?.type === "strong") {
      labels.add(toString(node.children[0]).replace(/[：:]$/, "").trim());
    }
  });
  return score + labels.size * 80;
}
