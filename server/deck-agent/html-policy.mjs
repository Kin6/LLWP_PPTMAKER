import { parse, parseFragment, serialize } from "parse5";
import { validateSlideCss } from "./css-policy.mjs";
import { MODEL_HTML_CONTRACT } from "./html-contract.mjs";

const SLIDE_ID = /^slide-\d{2}$/;
const ASSET_URL = /^asset:\/\/([a-z0-9-]+)$/;
const ALLOWED_TAGS = new Set(MODEL_HTML_CONTRACT.allowedTags);
const MODEL_ATTRS = new Set([
  "class", "alt", "role", "aria-label", "data-role", "data-slot",
  "data-chart-id", "data-asset-slot",
]);
const STORED_ATTRS = new Set([...MODEL_ATTRS, "data-asset-state"]);
const SERVICE_OWNED_ATTRS = new Set([
  "data-slide-root", "data-slide-id", "data-source-refs", "data-density", "data-asset-state",
]);
const STORED_ASSET_STATES = new Set(["empty", "resolved"]);
const REVEAL_RESERVED_CONTAINER = "section";

export function validateSlideHtml({
  html,
  slideId,
  sourceRefs,
  sourceBlockIds,
  assetIds,
  maxBytes = 200_000,
  maxNodes = 1_500,
  maxDepth = 24,
}) {
  return validateFragment({
    html, slideId, sourceRefs, sourceBlockIds, assetIds,
    maxBytes, maxNodes, maxDepth, mode: "model",
  });
}

export function validateStoredSlideHtml({
  html,
  slideId,
  sourceRefs,
  sourceBlockIds,
  assetIds,
  maxBytes = 200_000,
  maxNodes = 1_500,
  maxDepth = 24,
}) {
  return validateFragment({
    html, slideId, sourceRefs, sourceBlockIds, assetIds,
    maxBytes, maxNodes, maxDepth, mode: "stored",
  });
}

export function sanitizeSlide(input) {
  const htmlResult = validateSlideHtml(input);
  const cssResult = validateSlideCss({
    css: input.css,
    slideId: input.slideId,
    maxBytes: input.maxCssBytes,
    maxRules: input.maxCssRules,
  });
  return { html: htmlResult.html, css: cssResult.css };
}

function validateFragment({
  html,
  slideId,
  sourceRefs,
  sourceBlockIds,
  assetIds,
  maxBytes,
  maxNodes,
  maxDepth,
  mode,
}) {
  if (!SLIDE_ID.test(slideId)) throw new Error("Invalid slide identity");
  if (typeof html !== "string") throw new Error("HTML must be a string");
  assertLimit(maxBytes, "HTML byte limit");
  assertLimit(maxNodes, "HTML node limit");
  assertLimit(maxDepth, "HTML depth limit");
  if (!(sourceBlockIds instanceof Set)) throw new Error("Source block IDs must be a Set");
  if (!(assetIds instanceof Set)) throw new Error("Asset IDs must be a Set");
  if (!Array.isArray(sourceRefs)) throw new Error("Source references must be an array");
  if (Buffer.byteLength(html, "utf8") > maxBytes) throw new Error("HTML exceeds byte limit");

  rejectExplicitDocumentStructure(html);
  const parseErrors = [];
  const fragment = parseFragment(html, { onParseError: (error) => parseErrors.push(error) });
  if (parseErrors.length) throw new Error(`Invalid HTML syntax: ${parseErrors[0].code}`);

  const allowedAttrs = mode === "stored" ? STORED_ATTRS : MODEL_ATTRS;
  let nodeCount = 0;
  walk(fragment, 0, (node, depth) => {
    nodeCount += 1;
    if (nodeCount > maxNodes || depth > maxDepth) throw new Error("HTML structure exceeds limits");
    if (!node.tagName) return;
    normalizeRevealContainer(node);
    if (!ALLOWED_TAGS.has(node.tagName)) throw new Error(`Forbidden HTML tag: ${node.tagName}`);

    const attributes = new Map((node.attrs || []).map((attribute) => [attribute.name, attribute.value]));
    for (const attribute of node.attrs || []) {
      validateAttribute({ attribute, node, mode, allowedAttrs, assetIds });
    }

    if (node.tagName === "img") {
      if (!attributes.get("alt")?.trim()) throw new Error("Images require nonempty alt text");
      if (!attributes.has("src")) throw new Error("Images require an approved asset source");
    }
    if (attributes.has("data-asset-state") && !attributes.has("data-asset-slot")) {
      throw new Error("Stored asset state requires an asset slot");
    }
  });

  for (const blockId of new Set(sourceRefs)) {
    if (typeof blockId !== "string" || !sourceBlockIds.has(blockId)) {
      throw new Error(`Unknown source reference: ${String(blockId)}`);
    }
  }

  return { html: serialize(fragment), nodeCount };
}

function normalizeRevealContainer(node) {
  if (node.tagName !== REVEAL_RESERVED_CONTAINER) return;
  node.tagName = "div";
  node.nodeName = "div";
}

function validateAttribute({ attribute, node, mode, allowedAttrs, assetIds }) {
  const { name, value } = attribute;
  if (value.length > 4_096) throw new Error(`HTML attribute is too long: ${name}`);
  if (/^on/i.test(name) || name === "style" || name === "id") {
    throw new Error(`Forbidden HTML attribute: ${name}`);
  }
  if (SERVICE_OWNED_ATTRS.has(name) && !(mode === "stored" && name === "data-asset-state")) {
    throw new Error(`Service-owned HTML attribute: ${name}`);
  }

  if (name === "src") {
    const assetId = value.match(ASSET_URL)?.[1];
    if (node.tagName !== "img" || !assetId || !assetIds.has(assetId)) {
      throw new Error(`Unknown or external asset URL: ${value}`);
    }
    return;
  }
  if (!allowedAttrs.has(name)) throw new Error(`Forbidden HTML attribute: ${name}`);
  if (name === "data-asset-state" && !STORED_ASSET_STATES.has(value)) {
    throw new Error(`Invalid service-owned asset state: ${value}`);
  }
}

function rejectExplicitDocumentStructure(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  walk(document, 0, (node) => {
    const explicitDocumentNode = node.sourceCodeLocation
      && (node.nodeName === "#documentType" || ["html", "head", "body"].includes(node.tagName));
    if (explicitDocumentNode) throw new Error("HTML fragments must remain rootless");
  });
}

function walk(node, depth, visitor) {
  visitor(node, depth);
  for (const child of node.childNodes || []) walk(child, depth + 1, visitor);
  if (node.content) walk(node.content, depth + 1, visitor);
}

function assertLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
}
