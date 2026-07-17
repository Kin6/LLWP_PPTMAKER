import { htmlDeckSchema, htmlNodeSchema } from "./schema";
import type { HtmlDeckPatch, HtmlDeckSpec, HtmlNode } from "./types";

const commonNodeKeys = new Set(["name", "x", "y", "w", "h", "zIndex", "locked", "hidden", "animation", "animationDelay"]);
const textStyleKeys = new Set(["fontSize", "fontWeight", "lineHeight", "color", "align", "verticalAlign", "backgroundColor", "borderColor", "borderWidth", "radius", "opacity", "padding"]);

export function applyHtmlDeckPatches(deck: HtmlDeckSpec, patches: HtmlDeckPatch[]) {
  let current = structuredClone(deck);
  let applied = 0;
  for (const patch of patches.slice(0, 40)) {
    const candidate = applyPatch(current, patch);
    const parsed = htmlDeckSchema.safeParse(candidate);
    if (!parsed.success) continue;
    current = parsed.data as HtmlDeckSpec;
    applied += 1;
  }
  return { deck: applied ? { ...current, revision: deck.revision + 1 } : deck, applied };
}

function applyPatch(deck: HtmlDeckSpec, patch: HtmlDeckPatch): HtmlDeckSpec {
  if (patch.operation === "reorder-slides") {
    const order = Array.isArray(patch.changes.order) ? patch.changes.order.map(String) : [];
    if (order.length !== deck.slides.length || new Set(order).size !== deck.slides.length) return deck;
    const byId = new Map(deck.slides.map((slide) => [slide.id, slide]));
    if (order.some((id) => !byId.has(id))) return deck;
    return { ...deck, slides: order.map((id) => byId.get(id)!) };
  }

  const slide = deck.slides.find((item) => item.id === patch.slideId);
  if (!slide) return deck;
  if (patch.operation === "update-slide") {
    const allowed = pick(patch.changes, new Set(["title", "background", "transition", "speakerNotes"]));
    return { ...deck, slides: deck.slides.map((item) => item.id === slide.id ? { ...item, ...allowed } : item) };
  }
  if (patch.operation === "add-node") {
    const rawNode = patch.changes.node;
    const parsedNode = htmlNodeSchema.safeParse(rawNode);
    if (!parsedNode.success || slide.nodes.some((item) => item.id === parsedNode.data.id)) return deck;
    if (parsedNode.data.type === "image" || parsedNode.data.type === "video") return deck;
    return {
      ...deck,
      slides: deck.slides.map((item) => item.id === slide.id ? { ...item, nodes: [...item.nodes, parsedNode.data as HtmlNode] } : item),
    };
  }
  if (!patch.nodeId) return deck;
  const node = slide.nodes.find((item) => item.id === patch.nodeId);
  if (!node) return deck;
  if (patch.operation === "remove-node") {
    return {
      ...deck,
      slides: deck.slides.map((item) => item.id === slide.id ? { ...item, nodes: item.nodes.filter((candidate) => candidate.id !== node.id) } : item),
      comments: deck.comments.filter((comment) => comment.nodeId !== node.id),
    };
  }
  const changes = sanitizeNodeChanges(node, patch.changes);
  return {
    ...deck,
    slides: deck.slides.map((item) => item.id === slide.id
      ? { ...item, nodes: item.nodes.map((candidate) => candidate.id === node.id ? { ...candidate, ...changes } as HtmlNode : candidate) }
      : item),
  };
}

function sanitizeNodeChanges(node: HtmlNode, raw: Record<string, unknown>) {
  const common = pick(raw, commonNodeKeys);
  if (node.type === "text") {
    const style = raw.style && typeof raw.style === "object" && !Array.isArray(raw.style)
      ? { ...node.style, ...pick(raw.style as Record<string, unknown>, textStyleKeys) }
      : node.style;
    return { ...common, ...pick(raw, new Set(["text", "role"])), style };
  }
  if (node.type === "shape") return { ...common, ...pick(raw, new Set(["shape", "fill", "stroke", "strokeWidth", "radius", "opacity"])) };
  if (node.type === "image") return { ...common, ...pick(raw, new Set(["alt", "objectFit", "opacity"])) };
  if (node.type === "chart") return { ...common, ...pick(raw, new Set(["chartType", "labels", "series", "showLegend", "showValues", "accentColor"])) };
  if (node.type === "video") return { ...common, ...pick(raw, new Set(["autoplay", "loop", "muted"])) };
  return { ...common, ...pick(raw, new Set(["widgetType", "props"])) };
}

function pick(value: Record<string, unknown>, keys: Set<string>) {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && key !== "__proto__" && key !== "constructor" && key !== "prototype") result[key] = item;
  }
  return result;
}
