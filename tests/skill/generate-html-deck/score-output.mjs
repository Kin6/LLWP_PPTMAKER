import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
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
const UNIVERSAL_SECURITY_FIELDS = ["no-script", "no-external-url"];
const mediaRoot = fileURLToPath(new URL("../../../skills/generate-html-deck/assets/media/", import.meta.url));

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

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files.sort();
}

function sourceIdsFromBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new Error("Source block fixture must be an array");
  const ids = blocks.map((block) => block?.id);
  if (ids.some((id) => typeof id !== "string" || !id)) throw new Error("Source block fixture contains an invalid id");
  return new Set(ids);
}

async function loadMediaCatalog() {
  const catalog = JSON.parse(await readFile(new URL("../../../skills/generate-html-deck/assets/media/catalog.json", import.meta.url), "utf8"));
  const entries = Array.isArray(catalog?.assets) ? catalog.assets : [];
  const ids = new Set();
  const violations = [];
  for (const entry of entries) {
    const missing = REQUIRED_MEDIA_FIELDS.filter((field) => !Object.hasOwn(entry || {}, field));
    if (missing.length || !Array.isArray(entry.tags) || typeof entry.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id)) {
      violations.push(`media catalog: invalid entry ${entry?.id || "unknown"}`);
      continue;
    }
    const target = path.resolve(mediaRoot, entry.file);
    const relation = path.relative(mediaRoot, target);
    if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      violations.push(`media catalog: unsafe file for ${entry.id}`);
      continue;
    }
    try {
      const contents = await readFile(target);
      const digest = createHash("sha256").update(contents).digest("hex");
      if (digest !== entry.sha256) {
        violations.push(`media catalog: hash mismatch for ${entry.id}`);
        continue;
      }
      ids.add(entry.id);
    } catch (error) {
      violations.push(`media catalog: unreadable file for ${entry.id}: ${error.message}`);
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

function approvedAssetUrl(value, mediaAssetIds) {
  if (!value.startsWith("asset://")) return false;
  const id = value.slice("asset://".length);
  return /^[a-z0-9-]+$/.test(id) && mediaAssetIds.has(id);
}

function externalUrls(elements, css, mediaAssetIds, mediaViolations = []) {
  const urls = [...mediaViolations];
  const urlAttributes = new Set(["src", "href", "srcset", "action", "poster", "formaction"]);
  for (const element of elements) {
    for (const attribute of element.attrs || []) {
      if (attribute.name === "style") urls.push(`${element.file}: inline style`);
      if (attribute.name === "srcdoc") urls.push(`${element.file}: srcdoc`);
      if (urlAttributes.has(attribute.name) && !approvedAssetUrl(attribute.value, mediaAssetIds)) {
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
  "one-design-direction": ({ process }) => {
    const directions = Array.isArray(process.designDirections)
      ? process.designDirections
      : typeof process.designDirection === "string" && process.designDirection.trim()
        ? [process.designDirection]
        : [];
    return result("one-design-direction", directions.length === 1, { directions }, "text-judgment");
  },
  "no-script": ({ elements }) => {
    const violations = elements.flatMap((element) => {
      const found = [];
      if (["script", "style"].includes(element.tagName)) found.push(`${element.file}: <${element.tagName}>`);
      for (const attribute of element.attrs || []) {
        if (attribute.name === "srcdoc" || attribute.name.startsWith("on") || /^javascript:/i.test(attribute.value)) {
          found.push(`${element.file}: ${attribute.name}`);
        }
      }
      return found;
    });
    return result("no-script", violations.length === 0, { violations });
  },
  "no-external-url": ({ elements, css, media }) => {
    const violations = [...externalUrls(elements, css, media.ids, media.violations), ...css.errors];
    return result("no-external-url", violations.length === 0, { violations });
  },
  "fixed-canvas": ({ css }) => {
    const roots = css.parsed.flatMap((file) => cssSelectors(file.ast)
      .filter(({ selector }) => selector.trim() === ":slide")
      .map(({ rule }) => ({ file: file.relativePath, values: Object.fromEntries(declarations(rule)) })));
    const effective = Object.assign({}, ...roots.map(({ values }) => values));
    const pass = roots.length > 0 && effective.width === "1920px" && effective.height === "1080px";
    return result("fixed-canvas", pass, { roots, effective, parseErrors: css.errors });
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
  "valid-source-refs": ({ process, allowedSourceIds, elements }) => {
    const slides = processSlides(process);
    const invalid = [];
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
    return result("valid-source-refs", slides.length === 2 && invalid.length === 0, { invalid, allowed: [...allowedSourceIds] });
  },
  "structured-asset-slot": ({ elements }) => {
    const slots = elements.flatMap((element) => (element.attrs || [])
      .filter((attribute) => attribute.name === "data-asset-slot" && attribute.value.trim())
      .map((attribute) => `${element.file}:${attribute.value}`));
    return result("structured-asset-slot", slots.length > 0, { slots });
  },
  "no-image-fallback": ({ elements, css, process, media }) => {
    const violations = [...externalUrls(elements, css, media.ids, media.violations)];
    for (const element of elements) {
      if (element.tagName === "img") {
        const source = (element.attrs || []).find((attribute) => attribute.name === "src")?.value;
        if (!source || !approvedAssetUrl(source, media.ids)) violations.push(`${element.file}: unresolved <img>`);
      }
    }
    if (Array.isArray(process.imageFallbacks) && process.imageFallbacks.length) {
      violations.push(`process.json: ${process.imageFallbacks.length} image fallback(s)`);
    }
    return result("no-image-fallback", violations.length === 0, { violations });
  },
  "cover-dense-calibration": ({ process, qaArtifactViolations, qaCalibrationSlideIds }) => {
    const ids = Array.isArray(process.calibrationSlideIds) ? process.calibrationSlideIds : [];
    const pass = qaArtifactViolations.length === 0 && JSON.stringify(ids) === JSON.stringify(qaCalibrationSlideIds);
    return result("cover-dense-calibration", pass, { calibrationSlideIds: ids, expected: qaCalibrationSlideIds, artifactViolations: qaArtifactViolations }, "text-judgment");
  },
  "batch-size-2-3": ({ process, qaArtifactViolations }) => {
    const batches = Array.isArray(process.buildBatches) ? process.buildBatches : process.batches;
    const pass = Array.isArray(batches) && batches.length > 0
      && batches.every((batch) => Array.isArray(batch) && batch.length >= 2 && batch.length <= 3)
      && JSON.stringify(batches.flat()) === JSON.stringify(QA_SLIDE_IDS)
      && qaArtifactViolations.length === 0;
    return result("batch-size-2-3", pass, { batches: batches || [], expectedCoverage: QA_SLIDE_IDS, artifactViolations: qaArtifactViolations });
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
      && findings.length > 0
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
    const count = Number.isInteger(process.targetedRepairRounds)
      ? process.targetedRepairRounds
      : Array.isArray(process.targetedRepairs) ? process.targetedRepairs.length : 0;
    const repairs = Array.isArray(process.targetedRepairs) ? process.targetedRepairs : [];
    const findingIds = new Set(validContactFindings(process).map((finding) => finding.slideId));
    const invalidRepairs = repairs.filter((repair) => !QA_SLIDE_IDS.includes(repair?.slideId)
      || !findingIds.has(repair.slideId)
      || !isConcreteQaText(repair?.repair, 12));
    const pass = count === 1
      && repairs.length > 0
      && invalidRepairs.length === 0
      && qaArtifactViolations.length === 0;
    return result("one-targeted-repair", pass, { count, repairs, invalidRepairs, artifactViolations: qaArtifactViolations }, "text-judgment");
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
  const scenarioRoot = path.join(outputsRoot, scenario.id);
  const files = await listFiles(scenarioRoot);
  const loaded = await Promise.all(files.map(async (file) => ({
    relativePath: path.relative(scenarioRoot, file),
    contents: await readFile(file, "utf8"),
  })));
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

const options = parseArguments(process.argv.slice(2));
const scenarios = JSON.parse(await readFile(options.scenarios, "utf8"));
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
