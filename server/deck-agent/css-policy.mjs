import * as csstree from "css-tree";
import { MODEL_CSS_CONTRACT } from "./css-contract.mjs";
import { MODEL_HTML_CONTRACT } from "./html-contract.mjs";

const SLIDE_ID = /^slide-\d{2}$/;
const RESERVED_MODEL_TAG_SELECTORS = new Set(MODEL_HTML_CONTRACT.reservedTags);
const RESERVED_MODEL_CLASS_SELECTORS = new Set(MODEL_HTML_CONTRACT.reservedCssClasses);
const ALLOWED_PROPERTIES = new Set(MODEL_CSS_CONTRACT.allowedProperties);
const SAFE_VALUE_FUNCTIONS = new Set(MODEL_CSS_CONTRACT.allowedValueFunctions);
const ALLOWED_SELECTOR_NODES = new Set([
  "PseudoClassSelector", "AttributeSelector", "Combinator", "ClassSelector", "TypeSelector",
]);
const REQUIRED_THEME_TOKENS = new Set(MODEL_CSS_CONTRACT.themeTokens);
const THEME_COLOR_TOKENS = new Set([
  "--deck-bg", "--deck-surface", "--deck-text", "--deck-muted", "--deck-primary",
  "--deck-secondary", "--deck-accent", "--deck-positive", "--deck-negative",
]);
const THEME_SIZE_RANGES = new Map([
  ["--deck-title-size", [48, 96]],
  ["--deck-heading-size", [32, 64]],
  ["--deck-body-size", [24, 40]],
  ["--deck-caption-size", [16, 28]],
  ["--deck-radius", [0, 8]],
  ["--deck-space", [8, 40]],
  ["--deck-grid-gap", [16, 64]],
]);

export function validateSlideCss({ css, slideId, maxBytes = 120_000, maxRules = 300 }) {
  if (!SLIDE_ID.test(slideId)) throw new Error("Invalid slide identity");
  if (typeof css !== "string") throw new Error("CSS must be a string");
  assertLimit(maxBytes, "CSS byte limit");
  assertLimit(maxRules, "CSS rule limit");
  if (Buffer.byteLength(css, "utf8") > maxBytes) throw new Error("CSS exceeds byte limit");

  const ast = csstree.parse(css, { positions: false });
  let ruleCount = 0;
  csstree.walk(ast, (node) => {
    if (node.type === "Atrule") throw new Error(`CSS at-rule is forbidden: ${node.name}`);
    if (node.type === "Url") throw new Error("CSS url() is forbidden");
    if (node.type === "Rule") {
      ruleCount += 1;
      if (ruleCount > maxRules) throw new Error("CSS rule limit exceeded");
      rewriteSelectorList(node.prelude, slideId);
    }
    if (node.type === "Declaration") validateDeclaration(node);
  });

  return { css: csstree.generate(ast), ruleCount };
}

export function validateThemeCss(css) {
  if (typeof css !== "string") throw new Error("Theme CSS must be a string");
  const ast = csstree.parse(css, { positions: false });
  const seen = new Set();
  let ruleCount = 0;

  csstree.walk(ast, (node) => {
    if (node.type === "Atrule") throw new Error("Theme CSS cannot contain at-rules");
    if (node.type === "Url") throw new Error("Theme CSS cannot contain URLs");
    if (node.type === "Rule") {
      ruleCount += 1;
      if (ruleCount > 1) throw new Error("Theme CSS must contain only one :root rule");
      if (csstree.generate(node.prelude) !== ":root") throw new Error("Theme CSS may target only :root");
    }
    if (node.type === "Declaration") {
      if (node.important) throw new Error(`Unsafe theme token value: ${node.property}`);
      if (!REQUIRED_THEME_TOKENS.has(node.property)) throw new Error(`Unknown theme token: ${node.property}`);
      if (seen.has(node.property)) throw new Error(`Duplicate theme token: ${node.property}`);
      const value = csstree.generate(node.value).trim().replace(/\s*,\s*/g, ",");
      if (node.value.type === "Raw") node.value.value = value;
      assertSafeThemeValue(node, value);
      assertThemeValue(node.property, value);
      seen.add(node.property);
    }
  });

  if (ruleCount !== 1) throw new Error("Theme CSS must contain only one :root rule");
  const missing = [...REQUIRED_THEME_TOKENS].filter((token) => !seen.has(token));
  if (missing.length) throw new Error(`Theme CSS is missing required theme tokens: ${missing.join(", ")}`);
  return csstree.generate(ast);
}

function validateDeclaration(node) {
  const property = node.property.toLowerCase();
  if (node.important) throw new Error(`CSS !important is forbidden: ${property}`);
  if (!ALLOWED_PROPERTIES.has(property) || property.startsWith("--")) {
    throw new Error(`CSS property is forbidden: ${property}`);
  }

  const value = csstree.generate(node.value);
  csstree.walk(node.value, (valueNode) => {
    if (valueNode.type === "Url") throw new Error("CSS url() is forbidden");
    if (valueNode.type === "Function" && !SAFE_VALUE_FUNCTIONS.has(valueNode.name.toLowerCase())) {
      throw new Error(`CSS function is forbidden: ${valueNode.name}`);
    }
    if (valueNode.type === "Function" && valueNode.name.toLowerCase() === "var") {
      const reference = /^var\((--deck-[a-z-]+)\)$/.exec(csstree.generate(valueNode));
      if (!reference || !REQUIRED_THEME_TOKENS.has(reference[1])) {
        throw new Error(`CSS theme token reference is forbidden: ${csstree.generate(valueNode)}`);
      }
    }
  });
  if (/expression|javascript:|data:|\d(?:vw|vh|vmin|vmax|cqw|cqh|cqi|cqb)\b/i.test(value)) {
    throw new Error(`CSS value is forbidden: ${value}`);
  }
  if (property === "letter-spacing" && value !== "0") throw new Error("Letter spacing must be 0");
  if (property === "position" && /^(?:fixed|sticky)$/i.test(value)) {
    throw new Error(`CSS position may escape the slide: ${value}`);
  }
}

function rewriteSelectorList(prelude, slideId) {
  if (prelude.type !== "SelectorList") throw new Error("CSS rules require a selector list");
  const rewritten = [];

  prelude.children.forEach((selector) => {
    const nodes = selector.children.toArray();
    const first = nodes[0];
    const syntheticRoot = isSyntheticRoot(first);
    const storedRoot = isExactStoredRoot(first, slideId);
    if (!syntheticRoot && !storedRoot) {
      throw new Error(`Every selector branch must start with :slide; received ${describeSelectorStart(first)}`);
    }
    if (nodes[1] && nodes[1].type !== "Combinator") {
      throw new Error("The first selector compound must be exactly :slide");
    }

    for (const node of nodes) {
      if (!ALLOWED_SELECTOR_NODES.has(node.type) && node.type !== "Selector") {
        throw new Error(`Forbidden selector node: ${node.type}`);
      }
      if (node.type === "AttributeSelector" && node !== first) throw new Error("Forbidden selector node: AttributeSelector");
      if (node.type === "PseudoClassSelector" && node !== first) throw new Error(`Forbidden pseudo-class: ${node.name}`);
      if (node.type === "Combinator" && ![" ", ">"].includes(node.name)) {
        throw new Error(`Host-escaping combinator is forbidden: ${node.name}`);
      }
      if (node.type === "ClassSelector") {
        const name = csstree.ident.decode(node.name);
        if (RESERVED_MODEL_CLASS_SELECTORS.has(name)) {
          throw new Error(`Reserved renderer CSS selector is forbidden: .${name}`);
        }
      }
      if (node.type === "TypeSelector") {
        let name = csstree.ident.decode(node.name).toLowerCase();
        if (name === "section") {
          node.name = "div";
          name = "div";
        }
        if (RESERVED_MODEL_TAG_SELECTORS.has(name)) {
          throw new Error(`Reserved renderer CSS selector is forbidden: ${name}`);
        }
        if (!/^[a-z][a-z0-9-]*$/.test(name) || ["html", "body"].includes(name)) {
          throw new Error(`Forbidden host selector: ${node.name}`);
        }
      }
    }

    if (syntheticRoot) {
      const source = csstree.generate(selector);
      rewritten.push(`[data-slide-id="${slideId}"]${source.slice(":slide".length)}`);
    } else {
      rewritten.push(csstree.generate(selector));
    }
  });

  prelude.children = csstree.parse(rewritten.join(","), { context: "selectorList" }).children;
}

function describeSelectorStart(node) {
  if (!node) return "an empty selector";
  if (node.type === "PseudoClassSelector") return `:${String(node.name).slice(0, 60)}`;
  if (node.type === "ClassSelector") return `.${csstree.ident.decode(node.name).slice(0, 60)}`;
  if (node.type === "IdSelector") return `#${csstree.ident.decode(node.name).slice(0, 60)}`;
  if (node.type === "TypeSelector") return csstree.ident.decode(node.name).slice(0, 60);
  return node.type;
}

function isSyntheticRoot(node) {
  return node?.type === "PseudoClassSelector" && node.name === "slide" && !node.children;
}

function isExactStoredRoot(node, slideId) {
  return node?.type === "AttributeSelector"
    && node.name?.name === "data-slide-id"
    && node.matcher === "="
    && node.value?.type === "String"
    && node.value.value === slideId
    && !node.flags;
}

function assertSafeThemeValue(node, value) {
  if (/[a-z-]+\s*\(|expression|javascript:|data:/i.test(value)) {
    throw new Error(`Unsafe theme token value: ${node.property}`);
  }
}

function assertThemeValue(token, value) {
  if (THEME_COLOR_TOKENS.has(token) && !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)) {
    throw new Error(`Theme color must be hex: ${token}`);
  }

  const range = THEME_SIZE_RANGES.get(token);
  if (range) {
    const match = /^(\d+)px$/.exec(value);
    const number = Number(match?.[1]);
    if (!match || number < range[0] || number > range[1]) {
      throw new Error(`Theme size is out of range: ${token}`);
    }
  }

  if (token === "--deck-font-sans" && !["Arial,sans-serif", '"Noto Sans SC",Arial,sans-serif'].includes(value)) {
    throw new Error("Unknown sans-serif font stack");
  }
  if (token === "--deck-font-serif" && !["Georgia,serif", '"Noto Serif SC",Georgia,serif'].includes(value)) {
    throw new Error("Unknown serif font stack");
  }
}

function assertLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
}
