import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import * as csstree from "css-tree";
import { parseFragment } from "parse5";
import { fileURLToPath } from "node:url";
import { parseOutline, selectCalibrationSlides } from "../../../server/deck-agent/outline.mjs";

const EXPECTED_SOURCE_REFS = new Map([
  ["slide-01", ["block-018"]],
  ["slide-02", ["block-031"]],
]);
const QA_SLIDE_IDS = Array.from({ length: 8 }, (_, index) => `slide-${String(index + 1).padStart(2, "0")}`);
const REQUIRED_MEDIA_FIELDS = ["id", "file", "tags", "license", "sourceUrl", "sha256"];
const IMAGE_RESOLUTION_ORDER = ["uploaded-assets", "licensed-internal-assets", "optional-generation", "no-image-layout"];
const UNIVERSAL_SECURITY_FIELDS = ["artifact-safety", "fragment-structure", "no-script", "no-external-url"];
const BYTE_LIMITS = Object.freeze({
  markdown: 2 * 1024 * 1024,
  slideHtml: 200 * 1024,
  slideCss: 120 * 1024,
  json: 10 * 1024 * 1024,
  image: 12 * 1024 * 1024,
});
const PROHIBITED_FRAGMENT_TAGS = new Set(["script", "style", "form", "frame", "iframe", "embed", "object", "svg", "math"]);
const PROHIBITED_FRAGMENT_NAMESPACES = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1998/Math/MathML",
]);
const URL_ATTRIBUTES = new Set([
  "action",
  "archive",
  "attributionsrc",
  "background",
  "cite",
  "classid",
  "codebase",
  "data",
  "dynsrc",
  "formaction",
  "href",
  "imagesrcset",
  "itemid",
  "itemtype",
  "longdesc",
  "lowsrc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcset",
  "usemap",
  "xlink:href",
]);
const defaultMediaRoot = fileURLToPath(new URL("../../../skills/generate-html-deck/assets/media/", import.meta.url));

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--scenarios", "--outputs", "--report"].includes(flag) || !value) {
      throw new Error("Usage: score-output.mjs --scenarios <file> --outputs <directory> --report <file>");
    }
    values[flag.slice(2)] = value;
  }
  if (!values.scenarios || !values.outputs || !values.report || argv.length !== 6) {
    throw new Error("Usage: score-output.mjs --scenarios <file> --outputs <directory> --report <file>");
  }
  return values;
}

function isContained(root, target) {
  const relation = path.relative(root, target);
  return Boolean(relation)
    && relation !== ".."
    && !relation.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relation);
}

async function readContainedFile(root, target, { byteLimit, label, encoding = "utf8" }) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isContained(resolvedRoot, resolvedTarget)) throw new Error(`${label}: escapes root`);
  try {
    const rootStat = await lstat(resolvedRoot);
    if (rootStat.isSymbolicLink()) throw new Error(`${label}: symbolic links are forbidden`);
    if (!rootStat.isDirectory()) throw new Error(`${label}: root is not a directory`);
    let cursor = resolvedTarget;
    while (true) {
      const entryStat = await lstat(cursor);
      if (entryStat.isSymbolicLink()) throw new Error(`${label}: symbolic links are forbidden`);
      if (cursor === resolvedRoot) break;
      cursor = path.dirname(cursor);
    }
    const [realRoot, realTarget] = await Promise.all([realpath(resolvedRoot), realpath(resolvedTarget)]);
    if (!isContained(realRoot, realTarget)) throw new Error(`${label}: escapes root`);
    const targetStat = await lstat(realTarget);
    if (!targetStat.isFile()) throw new Error(`${label}: is not a regular file`);
    if (targetStat.size > byteLimit) throw new Error(`${label}: exceeds ${byteLimit} byte limit`);
    return readFile(realTarget, encoding);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error;
    throw new Error(`${label}: unreadable file (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function readInputFile(target, { byteLimit, label }) {
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) throw new Error(`${label}: symbolic links are forbidden`);
    if (!targetStat.isFile()) throw new Error(`${label}: is not a regular file`);
    if (targetStat.size > byteLimit) throw new Error(`${label}: exceeds ${byteLimit} byte limit`);
    return await readFile(target, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error;
    throw new Error(`${label}: unreadable file (${error instanceof Error ? error.message : String(error)})`);
  }
}

function scenarioArtifactLimit(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".md") return BYTE_LIMITS.markdown;
  if (extension === ".html") return BYTE_LIMITS.slideHtml;
  if (extension === ".css") return BYTE_LIMITS.slideCss;
  if (extension === ".json") return BYTE_LIMITS.json;
  return undefined;
}

async function loadScenarioFiles(root) {
  const files = [];
  const violations = [];
  const resolvedRoot = path.resolve(root);
  let rootStat;
  try {
    rootStat = await lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { files, violations };
    return { files, violations: [`scenario root: unreadable (${error.message})`] };
  }
  if (rootStat.isSymbolicLink()) return { files, violations: ["scenario root: symbolic links are forbidden"] };
  if (!rootStat.isDirectory()) return { files, violations: ["scenario root: is not a directory"] };

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      violations.push(`${path.relative(resolvedRoot, directory) || "scenario root"}: unreadable directory (${error.message})`);
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relativePath = path.relative(resolvedRoot, target);
      if (entry.isSymbolicLink()) {
        violations.push(`${relativePath}: symbolic links are forbidden`);
      } else if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        const byteLimit = scenarioArtifactLimit(relativePath);
        if (!byteLimit) {
          violations.push(`${relativePath}: unsupported artifact type`);
          continue;
        }
        try {
          files.push({
            relativePath,
            contents: await readContainedFile(resolvedRoot, target, { byteLimit, label: relativePath }),
          });
        } catch (error) {
          violations.push(error.message);
        }
      } else {
        violations.push(`${relativePath}: unsupported filesystem entry`);
      }
    }
  }
  await visit(resolvedRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  violations.sort();
  return { files, violations };
}

function sourceIdsFromBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new Error("Source block fixture must be an array");
  const ids = blocks.map((block) => block?.id);
  if (ids.some((id) => typeof id !== "string" || !id)) throw new Error("Source block fixture contains an invalid id");
  return new Set(ids);
}

export async function loadMediaCatalog({
  mediaRoot = defaultMediaRoot,
  catalogPath = path.join(mediaRoot, "catalog.json"),
} = {}) {
  let catalog;
  try {
    const rawCatalog = await readContainedFile(mediaRoot, catalogPath, {
      byteLimit: BYTE_LIMITS.json,
      label: path.basename(catalogPath),
    });
    catalog = JSON.parse(rawCatalog);
  } catch (error) {
    return { ids: new Set(), violations: [error instanceof Error ? error.message : String(error)] };
  }
  const entries = Array.isArray(catalog?.assets) ? catalog.assets : [];
  const ids = new Set();
  const violations = [];
  for (const entry of entries) {
    const missing = REQUIRED_MEDIA_FIELDS.filter((field) => !Object.hasOwn(entry || {}, field));
    if (missing.length || !Array.isArray(entry.tags) || typeof entry.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id)) {
      violations.push(`media catalog: invalid entry ${entry?.id || "unknown"}`);
      continue;
    }
    try {
      const contents = await readContainedFile(mediaRoot, path.resolve(mediaRoot, entry.file), {
        byteLimit: BYTE_LIMITS.image,
        label: entry.file,
        encoding: null,
      });
      const digest = createHash("sha256").update(contents).digest("hex");
      if (digest !== entry.sha256) {
        violations.push(`media catalog: hash mismatch for ${entry.id}`);
        continue;
      }
      ids.add(entry.id);
    } catch (error) {
      violations.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ids, violations };
}

async function loadEvaluationContract() {
  const sourceBlocks = JSON.parse(await readFile(new URL("../../fixtures/deck-agent/skill-outline/source-blocks.json", import.meta.url), "utf8"));
  const allowedSourceIds = sourceIdsFromBlocks(sourceBlocks);
  const qaMarkdown = await readFile(new URL("../../fixtures/deck-agent/skill-outline/qa-under-budget.md", import.meta.url), "utf8");
  const qaOutline = parseOutline(qaMarkdown, { expectedSlideCount: QA_SLIDE_IDS.length, sourceBlockIds: allowedSourceIds });
  return {
    allowedSourceIds,
    media: await loadMediaCatalog(),
    qaCalibrationSlideIds: selectCalibrationSlides(qaOutline),
  };
}

function walkHtml(node, visitor) {
  visitor(node);
  for (const child of node.childNodes || []) walkHtml(child, visitor);
  if (node.content) walkHtml(node.content, visitor);
}

function collectHtml(files) {
  const elements = [];
  for (const file of files) {
    const fragment = parseFragment(file.contents);
    walkHtml(fragment, (node) => {
      if (node.tagName) elements.push({ ...node, file: file.relativePath });
    });
  }
  return elements;
}

function isHtmlHidden(node) {
  const attrs = node.attrs || [];
  return attrs.some((item) => item.name === "hidden")
    || attrs.some((item) => item.name === "aria-hidden" && item.value.trim().toLowerCase() === "true");
}

function isInsideHiddenHtml(node) {
  for (let current = node; current; current = current.parentNode) {
    if (isHtmlHidden(current)) return true;
  }
  return false;
}

function visibleTextContent(node) {
  if (node.nodeName === "#text") return node.value || "";
  if (isHtmlHidden(node)) return "";
  return (node.childNodes || []).map(visibleTextContent).join(" ");
}

function attribute(element, name) {
  return (element.attrs || []).find((item) => item.name === name)?.value;
}

function parseCssFiles(files) {
  const parsed = [];
  const errors = [];
  for (const file of files) {
    try {
      parsed.push({ ...file, ast: csstree.parse(file.contents, { positions: true }) });
    } catch (error) {
      errors.push(`${file.relativePath}: ${error.message}`);
    }
  }
  return { parsed, errors };
}

function cssSelectors(ast) {
  const selectors = [];
  csstree.walk(ast, {
    visit: "Rule",
    enter(node) {
      if (node.prelude?.type !== "SelectorList") return;
      node.prelude.children.forEach((selector) => selectors.push({ selector: csstree.generate(selector), rule: node }));
    },
  });
  return selectors;
}

function declarations(rule) {
  const values = new Map();
  csstree.walk(rule.block, {
    visit: "Declaration",
    enter(node) {
      values.set(node.property.toLowerCase(), csstree.generate(node.value).toLowerCase());
    },
  });
  return values;
}

function declarationRecords(rule) {
  const records = [];
  csstree.walk(rule.block, {
    visit: "Declaration",
    enter(node) {
      records.push({
        property: node.property.toLowerCase(),
        value: csstree.generate(node.value).toLowerCase(),
        important: node.important === true,
      });
    },
  });
  return records;
}

function approvedAssetUrl(value, mediaAssetIds) {
  if (!value.startsWith("asset://")) return false;
  const id = value.slice("asset://".length);
  return /^[a-z0-9-]+$/.test(id) && mediaAssetIds.has(id);
}

function externalUrls(elements, css, mediaAssetIds, mediaViolations = []) {
  const urls = [...mediaViolations];
  for (const element of elements) {
    for (const attribute of element.attrs || []) {
      if (attribute.name === "style") urls.push(`${element.file}: inline style`);
      if (attribute.name === "srcdoc") urls.push(`${element.file}: srcdoc`);
      const approvedImageSource = element.tagName === "img"
        && attribute.name === "src"
        && approvedAssetUrl(attribute.value, mediaAssetIds);
      if (URL_ATTRIBUTES.has(attribute.name) && !approvedImageSource) {
        urls.push(`${element.file}: ${attribute.name}=${attribute.value}`);
      }
    }
  }
  for (const file of css.parsed) {
    csstree.walk(file.ast, (node) => {
      if (node.type === "Url") {
        const generated = csstree.generate(node);
        const value = generated.slice(4, -1).replace(/^(["'])(.*)\1$/, "$2");
        if (!approvedAssetUrl(value, mediaAssetIds)) urls.push(`${file.relativePath}: ${generated}`);
      }
      if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
        urls.push(`${file.relativePath}: @import`);
      }
    });
  }
  return urls;
}

function result(field, pass, evidence, kind = "structural") {
  return { field, pass: Boolean(pass), kind, evidence };
}

function processSlides(process) {
  return Array.isArray(process.slides) ? process.slides : [];
}

function fragmentStructureViolations(htmlFiles) {
  const violations = [];
  for (const file of htmlFiles) {
    const contents = file.contents.replace(/<!--[\s\S]*?-->/g, "");
    if (/<!doctype(?:\s|>)/i.test(contents)) violations.push(`${file.relativePath}: <!doctype>`);
    for (const match of contents.matchAll(/<\s*\/?\s*(html|head|body)(?=\s|\/?>)/gi)) {
      violations.push(`${file.relativePath}: <${match[1].toLowerCase()}> wrapper`);
    }
  }
  return violations;
}

function cssHidingDeclarations(css) {
  const found = [];
  for (const file of css.parsed) {
    csstree.walk(file.ast, {
      visit: "Declaration",
      enter(node) {
        const property = node.property.toLowerCase();
        const value = csstree.generate(node.value).trim().toLowerCase();
        const zeroLength = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z%]+)?$/.test(value);
        const hidden = (property === "display" && value === "none")
          || (property === "visibility" && ["hidden", "collapse"].includes(value))
          || (property === "opacity" && Number(value) === 0)
          || (property === "color" && value === "transparent")
          || (property === "font-size" && zeroLength)
          || (property === "content-visibility" && value === "hidden")
          || property === "clip"
          || property === "clip-path"
          || (property === "transform" && /\bscale(?:x|y|3d)?\(\s*(?:0+(?:\.0*)?|\.0+)(?=[, )])/.test(value))
          || (property === "scale" && /^(?:0+(?:\.0*)?|\.0+)(?:\s|$)/.test(value));
        if (hidden) found.push(`${file.relativePath}: ${property}: ${value}`);
      },
    });
  }
  return found;
}

function isStructurallyEmpty(element) {
  if (element.tagName === "img") return false;
  const children = [...(element.childNodes || []), ...(element.content?.childNodes || [])];
  return children.every((child) => child.nodeName === "#comment"
    || (child.nodeName === "#text" && !(child.value || "").trim()));
}

function isConcreteQaText(value, minimumLength) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  const placeholder = /^(?:n\/?a|none|ok|done|fixed|repaired|pass(?:ed)?|无|暂无|无问题|已修复|完成|通过)[\s.!。！-]*$/i;
  return text.length >= minimumLength && !placeholder.test(text);
}

function validContactFindings(process) {
  const findings = Array.isArray(process.contactSheetReview?.findings)
    ? process.contactSheetReview.findings
    : [];
  return findings.filter((finding) => QA_SLIDE_IDS.includes(finding?.slideId)
    && isConcreteQaText(finding?.defect, 8));
}

const checks = {
  "artifact-safety": ({ artifactViolations }) => result(
    "artifact-safety",
    artifactViolations.length === 0,
    { violations: artifactViolations },
  ),
  "fragment-structure": ({ htmlFiles }) => {
    const violations = fragmentStructureViolations(htmlFiles);
    return result("fragment-structure", violations.length === 0, { violations });
  },
  "one-design-direction": ({ process }) => {
    const direction = typeof process.designDirection === "string" ? process.designDirection.trim() : "";
    const pluralAliasPresent = Object.hasOwn(process, "designDirections");
    return result(
      "one-design-direction",
      Boolean(direction) && !pluralAliasPresent,
      { direction, pluralAliasPresent },
      "text-judgment",
    );
  },
  "no-script": ({ elements, htmlFiles }) => {
    const violations = elements.flatMap((element) => {
      const found = [];
      if (PROHIBITED_FRAGMENT_TAGS.has(element.tagName)
        || PROHIBITED_FRAGMENT_NAMESPACES.has(element.namespaceURI)) {
        found.push(`${element.file}: <${element.tagName}>`);
      }
      for (const attribute of element.attrs || []) {
        if (attribute.name === "srcdoc" || attribute.name.startsWith("on") || /^javascript:/i.test(attribute.value)) {
          found.push(`${element.file}: ${attribute.name}`);
        }
      }
      return found;
    });
    for (const file of htmlFiles) {
      if (/<\s*frame\b/i.test(file.contents)) violations.push(`${file.relativePath}: <frame>`);
    }
    return result("no-script", violations.length === 0, { violations });
  },
  "no-external-url": ({ elements, css, media }) => {
    const violations = [...externalUrls(elements, css, media.ids, media.violations), ...css.errors];
    return result("no-external-url", violations.length === 0, { violations });
  },
  "fixed-canvas": ({ css }) => {
    const roots = css.parsed.flatMap((file) => cssSelectors(file.ast)
      .filter(({ selector }) => selector.trim() === ":slide")
      .map(({ rule }) => ({
        file: file.relativePath,
        declarations: declarationRecords(rule),
        values: Object.fromEntries(declarations(rule)),
      })));
    const required = { width: "1920px", height: "1080px", overflow: "hidden" };
    const effectiveRecords = {};
    for (const root of roots) {
      for (const declaration of root.declarations) {
        if (!Object.hasOwn(required, declaration.property)) continue;
        const current = effectiveRecords[declaration.property];
        if (!current
          || declaration.important === current.important
          || (declaration.important && !current.important)) {
          effectiveRecords[declaration.property] = declaration;
        }
      }
    }
    const effective = Object.fromEntries(Object.entries(effectiveRecords)
      .map(([property, declaration]) => [property, declaration.value]));
    const violations = [];
    for (const file of css.parsed) {
      for (const { selector, rule } of cssSelectors(file.ast)) {
        const normalized = selector.trim();
        if (!/^:slide(?:$|[\s>+~.#[:])/.test(normalized)) continue;
        const values = declarations(rule);
        if (normalized !== ":slide") {
          for (const [property, expected] of Object.entries(required)) {
            if (values.has(property) && values.get(property) !== expected) {
              violations.push(`${file.relativePath}: ${normalized} sets ${property}: ${values.get(property)}`);
            }
          }
        }
        for (const property of ["overflow-x", "overflow-y"]) {
          if (values.has(property) && values.get(property) !== "hidden") {
            violations.push(`${file.relativePath}: ${normalized} sets ${property}: ${values.get(property)}`);
          }
        }
      }
    }
    const pass = roots.length > 0
      && css.errors.length === 0
      && Object.entries(required).every(([property, expected]) => effective[property] === expected)
      && violations.length === 0;
    return result("fixed-canvas", pass, { roots, effective, violations, parseErrors: css.errors });
  },
  "scoped-css": ({ css }) => {
    const violations = [...css.errors];
    for (const file of css.parsed) {
      for (const { selector, rule } of cssSelectors(file.ast)) {
        const normalized = selector.trim();
        const rootTokensOnly = normalized === ":root"
          && [...declarations(rule).keys()].every((property) => property.startsWith("--deck-"));
        if (!rootTokensOnly && !/^:slide(?:$|[\s>+~.#[:])/.test(normalized)) {
          violations.push(`${file.relativePath}: ${normalized}`);
        }
      }
    }
    return result("scoped-css", violations.length === 0, { violations });
  },
  "stable-slide-id": ({ htmlFiles, elements, process }) => {
    const filenames = htmlFiles.map((file) => path.basename(file.relativePath)).sort();
    const ids = processSlides(process).map((slide) => slide.slideId).sort();
    const serviceOwned = elements.flatMap((element) => (element.attrs || [])
      .filter((attribute) => ["data-slide-root", "data-slide-id", "data-source-refs"].includes(attribute.name))
      .map((attribute) => `${element.file}: ${attribute.name}`));
    const pass = JSON.stringify(filenames) === JSON.stringify(["slide-01.html", "slide-02.html"])
      && JSON.stringify(ids) === JSON.stringify(["slide-01", "slide-02"])
      && serviceOwned.length === 0;
    return result("stable-slide-id", pass, { filenames, processSlideIds: ids, serviceOwned });
  },
  "valid-source-refs": ({ process, allowedSourceIds, elements, css }) => {
    const slides = processSlides(process);
    const invalid = [];
    const hidingDeclarations = cssHidingDeclarations(css);
    if (hidingDeclarations.length) invalid.push("CSS hides source evidence");
    for (const slide of slides) {
      const refs = slide.sourceRefs;
      if (!Array.isArray(refs) || refs.length === 0) invalid.push(`${slide.slideId || "unknown"}: missing refs`);
      else if (refs.some((ref) => !allowedSourceIds.has(ref))) invalid.push(`${slide.slideId || "unknown"}: ${refs.join(",")}`);
      const expected = EXPECTED_SOURCE_REFS.get(slide.slideId);
      if (expected && JSON.stringify(refs) !== JSON.stringify(expected)) {
        invalid.push(`${slide.slideId}: expected ${expected.join(",")}`);
      }
      const sourceText = elements
        .filter((element) => element.file === `${slide.slideId}.html`
          && attribute(element, "data-slot") === "source"
          && !isInsideHiddenHtml(element))
        .map(visibleTextContent)
        .join(" ");
      if (expected?.some((ref) => !sourceText.includes(ref))) invalid.push(`${slide.slideId}: source not visible`);
    }
    return result("valid-source-refs", slides.length === 2 && invalid.length === 0, {
      invalid,
      allowed: [...allowedSourceIds],
      cssHidingDeclarations: hidingDeclarations,
    });
  },
  "structured-asset-slot": ({ elements }) => {
    const slots = elements.flatMap((element) => (element.attrs || [])
      .filter((attribute) => attribute.name === "data-asset-slot" && attribute.value.trim())
      .map((attribute) => `${element.file}:${attribute.value}`));
    return result("structured-asset-slot", slots.length > 0, { slots });
  },
  "no-image-fallback": ({ elements, css, process, media }) => {
    const violations = [...externalUrls(elements, css, media.ids, media.violations)];
    const resolutionOrder = Array.isArray(process.imageResolutionOrder) ? process.imageResolutionOrder : [];
    if (JSON.stringify(resolutionOrder) !== JSON.stringify(IMAGE_RESOLUTION_ORDER)) {
      violations.push(`process.json: imageResolutionOrder must be ${IMAGE_RESOLUTION_ORDER.join(" -> ")}`);
    }
    for (const element of elements) {
      if (element.tagName === "img") {
        const source = (element.attrs || []).find((attribute) => attribute.name === "src")?.value;
        if (!source || !approvedAssetUrl(source, media.ids)) violations.push(`${element.file}: unresolved <img>`);
      }
    }
    if (Array.isArray(process.imageFallbacks) && process.imageFallbacks.length) {
      violations.push(`process.json: ${process.imageFallbacks.length} image fallback(s)`);
    }
    const optionalImageFailures = process.optionalImageFailures;
    if (optionalImageFailures !== undefined && !Array.isArray(optionalImageFailures)) {
      violations.push("process.json: optionalImageFailures must be an array");
    } else {
      const seenFailureSlots = new Set();
      for (const failure of optionalImageFailures || []) {
        const keys = failure && typeof failure === "object" && !Array.isArray(failure)
          ? Object.keys(failure).sort()
          : [];
        const slot = typeof failure?.slot === "string" ? failure.slot.trim() : "";
        if (JSON.stringify(keys) !== JSON.stringify(["outcome", "slot"])
          || !slot
          || failure.outcome !== "no-image-layout") {
          violations.push("process.json: optional image failure must resolve to no-image-layout");
          continue;
        }
        if (seenFailureSlots.has(slot)) {
          violations.push(`process.json: duplicate optional image failure for ${slot}`);
          continue;
        }
        seenFailureSlots.add(slot);
        const matchingSlots = elements.filter((element) => attribute(element, "data-asset-slot")?.trim() === slot);
        if (matchingSlots.length === 0) {
          violations.push(`process.json: optional image failure ${slot} has no matching data-asset-slot`);
          continue;
        }
        for (const matchingSlot of matchingSlots) {
          if (!isStructurallyEmpty(matchingSlot)) {
            violations.push(`${matchingSlot.file}: data-asset-slot=${slot} must be structurally empty`);
          }
        }
      }
    }
    return result("no-image-fallback", violations.length === 0, {
      violations,
      imageResolutionOrder: resolutionOrder,
      optionalImageFailures: optionalImageFailures || [],
    });
  },
  "cover-dense-calibration": ({ process, qaArtifactViolations, qaCalibrationSlideIds }) => {
    const ids = Array.isArray(process.calibrationSlideIds) ? process.calibrationSlideIds : [];
    const correctionCount = process.calibrationCorrectionCount;
    const designRulesLocked = process.designRulesLocked;
    const pass = qaArtifactViolations.length === 0
      && JSON.stringify(ids) === JSON.stringify(qaCalibrationSlideIds)
      && Number.isInteger(correctionCount)
      && correctionCount >= 0
      && correctionCount <= 1
      && designRulesLocked === true;
    return result("cover-dense-calibration", pass, {
      calibrationSlideIds: ids,
      expected: qaCalibrationSlideIds,
      calibrationCorrectionCount: correctionCount,
      designRulesLocked,
      artifactViolations: qaArtifactViolations,
    }, "text-judgment");
  },
  "batch-size-2-3": ({ process, qaArtifactViolations, qaCalibrationSlideIds }) => {
    const batches = Array.isArray(process.buildBatches) ? process.buildBatches : process.batches;
    const expectedBuildSlideIds = QA_SLIDE_IDS.filter((slideId) => !qaCalibrationSlideIds.includes(slideId));
    const checkpoints = Array.isArray(process.pageCheckpoints) ? process.pageCheckpoints : [];
    const checkpointSlideIds = checkpoints.map((checkpoint) => checkpoint?.slideId);
    const pass = Array.isArray(batches) && batches.length > 0
      && batches.every((batch) => Array.isArray(batch) && batch.length >= 2 && batch.length <= 3)
      && JSON.stringify(batches.flat()) === JSON.stringify(expectedBuildSlideIds)
      && JSON.stringify(checkpointSlideIds) === JSON.stringify(expectedBuildSlideIds)
      && checkpoints.every((checkpoint) => checkpoint?.status === "valid")
      && qaArtifactViolations.length === 0;
    return result("batch-size-2-3", pass, {
      batches: batches || [],
      expectedCoverage: expectedBuildSlideIds,
      pageCheckpoints: checkpoints,
      artifactViolations: qaArtifactViolations,
    });
  },
  "max-concurrency-2": ({ process, qaArtifactViolations }) => {
    const value = process.maxConcurrency;
    return result("max-concurrency-2", Number.isInteger(value) && value >= 1 && value <= 2 && qaArtifactViolations.length === 0, { maxConcurrency: value, artifactViolations: qaArtifactViolations });
  },
  "one-contact-sheet-review": ({ process, qaArtifactViolations }) => {
    const count = Number.isInteger(process.contactSheetReviewCount)
      ? process.contactSheetReviewCount
      : Array.isArray(process.contactSheetReviews) ? process.contactSheetReviews.length : 0;
    const review = process.contactSheetReview;
    const reviewedIds = Array.isArray(review?.slideIds) ? review.slideIds : [];
    const findings = Array.isArray(review?.findings) ? review.findings : [];
    const concreteFindings = validContactFindings(process);
    const pass = count === 1
      && JSON.stringify(reviewedIds) === JSON.stringify(QA_SLIDE_IDS)
      && concreteFindings.length === findings.length
      && qaArtifactViolations.length === 0;
    return result("one-contact-sheet-review", pass, {
      count,
      reviewedIds,
      findings,
      invalidFindings: findings.filter((finding) => !concreteFindings.includes(finding)),
      artifactViolations: qaArtifactViolations,
    }, "text-judgment");
  },
  "one-targeted-repair": ({ process, qaArtifactViolations }) => {
    const count = process.targetedRepairRounds;
    const repairs = Array.isArray(process.targetedRepairs) ? process.targetedRepairs : [];
    const findingIds = new Set(validContactFindings(process).map((finding) => finding.slideId));
    const invalidRepairs = repairs.filter((repair) => !QA_SLIDE_IDS.includes(repair?.slideId)
      || !findingIds.has(repair.slideId)
      || !isConcreteQaText(repair?.repair, 12));
    const cleanReview = findingIds.size === 0 && count === 0 && repairs.length === 0;
    const repairedReview = findingIds.size > 0
      && count === 1
      && repairs.length > 0
      && invalidRepairs.length === 0;
    const pass = Number.isInteger(count)
      && (cleanReview || repairedReview)
      && qaArtifactViolations.length === 0;
    return result("one-targeted-repair", pass, {
      count,
      repairs,
      failedSlideIds: [...findingIds],
      invalidRepairs,
      artifactViolations: qaArtifactViolations,
    }, "text-judgment");
  },
};

function qaArtifactViolations(loaded, htmlFiles, cssFiles, css) {
  const violations = [...css.errors];
  const filenames = htmlFiles.map((file) => path.basename(file.relativePath)).sort();
  const expected = QA_SLIDE_IDS.map((id) => `${id}.html`);
  if (JSON.stringify(filenames) !== JSON.stringify(expected)) {
    violations.push(`expected HTML ${expected.join(",")}; found ${filenames.join(",") || "none"}`);
  }
  if (cssFiles.length !== 1) violations.push(`expected one shared CSS file; found ${cssFiles.length}`);
  const allowed = new Set(["process.json", ...expected, ...cssFiles.map((file) => file.relativePath)]);
  const extras = loaded.map((file) => file.relativePath).filter((file) => !allowed.has(file));
  if (extras.length) violations.push(`unexpected artifacts: ${extras.join(",")}`);
  return violations;
}

async function loadScenarioOutput(outputsRoot, scenario, evaluation) {
  const resolvedOutputsRoot = path.resolve(outputsRoot);
  const scenarioRoot = path.resolve(resolvedOutputsRoot, scenario.id);
  const scenarioFiles = isContained(resolvedOutputsRoot, scenarioRoot)
    ? await loadScenarioFiles(scenarioRoot)
    : { files: [], violations: ["scenario root: escape path outside output root"] };
  const { files: loaded, violations: artifactViolations } = scenarioFiles;
  const htmlFiles = loaded.filter((file) => file.relativePath.endsWith(".html"));
  const cssFiles = loaded.filter((file) => file.relativePath.endsWith(".css"));
  const processFile = loaded.find((file) => file.relativePath === "process.json");
  let process = {};
  let processError;
  try {
    process = processFile ? JSON.parse(processFile.contents) : {};
  } catch (error) {
    processError = error.message;
  }
  const elements = collectHtml(htmlFiles);
  const css = parseCssFiles(cssFiles);
  const context = {
    allowedSourceIds: evaluation.allowedSourceIds,
    artifactViolations,
    css,
    elements,
    htmlFiles,
    media: evaluation.media,
    process,
    qaArtifactViolations: scenario.id === "qa-under-budget" ? qaArtifactViolations(loaded, htmlFiles, cssFiles, css) : [],
    qaCalibrationSlideIds: evaluation.qaCalibrationSlideIds,
  };
  const requiredFields = [...new Set([...scenario.mustPass, ...UNIVERSAL_SECURITY_FIELDS])];
  const fields = requiredFields.map((field) => {
    if (!checks[field]) throw new Error(`Unknown score field: ${field}`);
    const scored = checks[field](context);
    if (processError) return { ...scored, pass: false, evidence: { ...scored.evidence, processError } };
    return scored;
  });
  return {
    id: scenario.id,
    pass: fields.every((field) => field.pass),
    artifacts: loaded.map((file) => file.relativePath),
    fields,
  };
}

export async function runScorer(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const scenarios = JSON.parse(await readInputFile(options.scenarios, {
    byteLimit: BYTE_LIMITS.json,
    label: "Scenarios file",
  }));
  const evaluation = await loadEvaluationContract();
  const records = [];
  for (const scenario of scenarios) records.push(await loadScenarioOutput(options.outputs, scenario, evaluation));

  const report = {
    pass: records.every((record) => record.pass),
    scenarios: records,
    manualReviewRequired: records.flatMap((record) => record.fields
      .filter((field) => !field.pass || field.kind === "text-judgment")
      .map((field) => ({ scenario: record.id, field: field.field, reason: field.kind === "text-judgment" ? "text judgment" : "failed" }))),
  };
  await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ pass: report.pass, scenarios: records.map(({ id, pass }) => ({ id, pass })) }));
  if (!report.pass) process.exitCode = 1;
  return report;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await runScorer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
