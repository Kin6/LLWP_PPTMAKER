import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFragment } from "parse5";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_HTML_CONTRACT } from "../../../server/deck-agent/html-contract.mjs";
import { validateSlideHtml } from "../../../server/deck-agent/html-policy.mjs";
import { createSkillLoader } from "../../../server/deck-agent/skill-loader.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skillRoot = path.join(repositoryRoot, "skills/generate-html-deck");
const temporaryRoots = [];
const expectedThemes = ["minimal-white", "corporate-clean", "swiss-grid", "editorial-serif", "academic-paper", "magazine-bold", "tokyo-night", "pitch-deck-vc", "playful-classroom"];
const expectedLayouts = ["cover", "section-divider", "two-column", "big-quote", "stat-highlight", "kpi-grid", "table", "timeline", "comparison", "process-steps", "image-hero", "thanks"];
const expectedStageFiles = {
  outline: ["SKILL.md", "references/content-density.md", "references/source-provenance.md"],
  design: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md"],
  calibrating: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md", "references/visual-rubric.md", "references/security-contract.md"],
  building: ["SKILL.md", "references/content-density.md", "references/layout-catalog.md", "references/source-provenance.md", "references/security-contract.md"],
  verifying: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
  repairing: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
};
const expectedLayoutSlots = {
  cover: ["cover-image", "eyebrow", "source", "subtitle", "title"],
  "section-divider": ["section-number", "source", "summary", "title"],
  "two-column": ["left", "right", "source", "title"],
  "big-quote": ["attribution", "quote", "source"],
  "stat-highlight": ["context", "source", "stat-label", "stat-value", "title"],
  "kpi-grid": ["kpi-1", "kpi-2", "kpi-3", "kpi-4", "source", "title"],
  table: ["caption", "source", "table-body", "table-head", "title"],
  timeline: ["phase-1", "phase-2", "phase-3", "phase-4", "source", "title"],
  comparison: ["left-body", "left-heading", "right-body", "right-heading", "source", "title"],
  "process-steps": ["source", "step-1", "step-2", "step-3", "step-4", "title"],
  "image-hero": ["caption", "hero-image", "source", "title"],
  thanks: ["contact", "source", "takeaway", "title"],
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTemporaryOutlineSkill() {
  const root = await mkdtemp(path.join(tmpdir(), "deck-skill-loader-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "references"), { recursive: true });
  await writeFile(path.join(root, "SKILL.md"), "skill", "utf8");
  await writeFile(path.join(root, "references/content-density.md"), "density", "utf8");
  await writeFile(path.join(root, "references/source-provenance.md"), "sources", "utf8");
  return root;
}

function collectElements(node, elements = []) {
  if (node.tagName) elements.push(node);
  for (const child of node.childNodes || []) collectElements(child, elements);
  return elements;
}

function colorVariables(css) {
  return Object.fromEntries([...css.matchAll(/(--deck-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const [bright, dark] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

describe("project Skill loader", () => {
  it("loads only the allowlisted references for each stage", async () => {
    const loader = createSkillLoader({ skillRoot, maxChars: 24_000 });
    for (const [stage, files] of Object.entries(expectedStageFiles)) {
      const loaded = await loader.load(stage);
      expect(loaded.files).toEqual(files);
      expect(loaded.charCount).toBe(loaded.instructions.length);
    }

    const outline = await loader.load("outline");
    expect(outline.files).toEqual(["SKILL.md", "references/content-density.md", "references/source-provenance.md"]);
    expect(outline.instructions).not.toContain("visual-rubric.md");
    await expect(loader.load("../../package.json")).rejects.toThrow(/unknown stage/i);
  });

  it("enforces the configured context budget", async () => {
    await expect(createSkillLoader({ skillRoot, maxChars: 10 }).load("outline"))
      .rejects.toThrow(/exceeds 10 characters/i);
  });

  it("routes the auditable calibration lock and remaining-page build contract", async () => {
    const loader = createSkillLoader({ skillRoot });
    const calibrating = await loader.load("calibrating");
    const building = await loader.load("building");

    expect(calibrating.instructions).toContain("calibrationCorrectionCount");
    expect(calibrating.instructions).toContain("designRulesLocked");
    expect(building.instructions).toContain("buildBatches");
    expect(building.instructions).toContain("pageCheckpoints");
    expect(building.instructions).toMatch(/non-calibration/i);
  });

  it("routes the ordered optional-image resolution contract to building", async () => {
    const instructions = (await createSkillLoader({ skillRoot }).load("building")).instructions;
    const terms = ["uploaded-assets", "licensed-internal-assets", "optional-generation", "no-image-layout"];
    const positions = terms.map((term) => instructions.indexOf(term));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(instructions).toMatch(/optional image.*must not fail|failed optional image.*continue/i);
    expect(instructions).not.toMatch(/Stop `building`.*unresolved image/i);
  });

  it("routes the topic-only provenance contract without weakening supplied-source validation", async () => {
    const loader = createSkillLoader({ skillRoot });
    const outline = (await loader.load("outline")).instructions;
    const building = (await loader.load("building")).instructions;

    for (const instructions of [outline, building]) {
      expect(instructions).toMatch(/no external materials/i);
      expect(instructions).toContain("sourceRefs` as an empty array");
      expect(instructions).toMatch(/one or more source blocks[\s\S]{0,180}every slide must retain at least one valid source comment/i);
    }
  });

  it("keeps every decided image position as an empty named slot after no-image resolution", async () => {
    const instructions = (await createSkillLoader({ skillRoot }).load("building")).instructions;

    expect(instructions).toContain("Keep every decided image position as an empty named `data-asset-slot`");
    expect(instructions).toMatch(/no-image-layout[\s\S]{0,240}do not (?:add|emit) an `<img>` or (?:add|emit) a URL/i);
  });

  it("routes the hardened fragment, metadata, fallback, and source-visibility contracts", async () => {
    const loader = createSkillLoader({ skillRoot });
    const design = (await loader.load("design")).instructions;
    const building = (await loader.load("building")).instructions;

    expect(design).toMatch(/call `write_theme` exactly once[\s\S]{0,160}only `designBriefMarkdown`/i);
    expect(building).toMatch(/doctype[\s\S]{0,120}`<html>`[\s\S]{0,120}`<head>`[\s\S]{0,120}`<body>`/i);
    expect(building).toContain("`htmlContract.allowedTags`");
    expect(building).toMatch(/speaker notes[\s\S]{0,180}server-owned metadata/i);
    expect(building).toMatch(/service owns[\s\S]{0,160}`:root`[\s\S]{0,160}never emit/i);
    expect(building).toMatch(/every comma-separated selector branch[\s\S]{0,120}`:slide`/i);
    expect(building).not.toContain("Use a token-only `:root` rule");
    expect(building).not.toContain("Use semantic elements");
    for (const attribute of ["cite", "ping", "data", "longdesc", "manifest", "usemap", "xlink:href", "background", "archive", "codebase", "classid", "profile", "attributionsrc", "dynsrc", "imagesrcset", "itemtype", "lowsrc"]) {
      expect(building).toContain(`\`${attribute}\``);
    }
    expect(building).toMatch(/each `optionalImageFailures`[\s\S]{0,240}matching empty named `data-asset-slot`/i);
    expect(building).toMatch(/duplicate[\s\S]{0,120}optional image failure/i);
    for (const hiding of ["display: none", "visibility: hidden", "opacity: 0", "color: transparent", "font-size: 0", "content-visibility: hidden", "clip-path", "scale(0)"]) {
      expect(building).toContain(`\`${hiding}\``);
    }
  });

  it("routes every prohibited hostile fragment element to generation stages", async () => {
    const loader = createSkillLoader({ skillRoot });
    const calibrating = (await loader.load("calibrating")).instructions.toLowerCase();
    const building = (await loader.load("building")).instructions.toLowerCase();

    for (const prohibited of ["<form>", "<frame>", "<iframe>", "<embed>", "<object>", "svg", "mathml"]) {
      expect(calibrating).toContain(prohibited);
      expect(building).toContain(prohibited);
    }
  });

  it("routes the clean zero-repair and matching one-repair QA contract", async () => {
    const loader = createSkillLoader({ skillRoot });
    const verifying = (await loader.load("verifying")).instructions;
    const repairing = (await loader.load("repairing")).instructions;

    expect(verifying).toMatch(/zero findings|findings.*empty/i);
    expect(repairing).toMatch(/zero or one targeted repair|0 or 1 targeted repair/i);
    expect(repairing).toMatch(/matching failed slide|only.*failed slide/i);
    expect(repairing).toContain("targetedRepairRounds");
  });

  it("rejects symlinked stage files and Markdown larger than exactly 2 MiB", async () => {
    const root = await createTemporaryOutlineSkill();
    const sourcePath = path.join(root, "references/source-provenance.md");
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "deck-skill-outside-"));
    temporaryRoots.push(outsideRoot);
    const outsidePath = path.join(outsideRoot, "outside.md");
    await writeFile(outsidePath, "outside", "utf8");
    await rm(sourcePath);
    await symlink(outsidePath, sourcePath);

    await expect(createSkillLoader({ skillRoot: root, maxChars: 4 * 1024 * 1024 }).load("outline"))
      .rejects.toThrow(/symbolic link|escape/i);

    await rm(sourcePath);
    await writeFile(sourcePath, "x".repeat(2 * 1024 * 1024), "utf8");
    await expect(createSkillLoader({ skillRoot: root, maxChars: 4 * 1024 * 1024 }).load("outline"))
      .resolves.toMatchObject({ files: expectedStageFiles.outline });

    await writeFile(sourcePath, "x".repeat(2 * 1024 * 1024 + 1), "utf8");
    await expect(createSkillLoader({ skillRoot: root, maxChars: 4 * 1024 * 1024 }).load("outline"))
      .rejects.toThrow(/2097152|2 MiB|size|limit/i);
  });

  it("rejects inherited object property names as unknown stages", async () => {
    const loader = createSkillLoader({ skillRoot });

    for (const stage of ["toString", "constructor", "__proto__"]) {
      await expect(loader.load(stage)).rejects.toThrow(/unknown stage/i);
    }
  });

  it("registers exactly nine themes and twelve layouts", async () => {
    const catalog = JSON.parse(await readFile(path.join(skillRoot, "assets/catalog.json"), "utf8"));

    expect(catalog.themes.map((item) => item.id)).toEqual(expectedThemes);
    expect(catalog.layouts.map((item) => item.id)).toEqual(expectedLayouts);
    expect(catalog.themes.map((item) => item.file)).toEqual(expectedThemes.map((id) => `themes/${id}.css`));
    expect(catalog.layouts.map((item) => item.file)).toEqual(expectedLayouts.map((id) => `layouts/${id}.html`));
    expect(catalog.canvas).toEqual({ width: 1920, height: 1080, safeInset: 72 });
  });

  it("uses one shared theme token contract with AA body-text contrast", async () => {
    const catalogs = await Promise.all(expectedThemes.map(async (theme) => {
      const css = await readFile(path.join(skillRoot, `assets/themes/${theme}.css`), "utf8");
      const variables = colorVariables(css);
      expect(contrastRatio(variables["--deck-text"], variables["--deck-bg"])).toBeGreaterThanOrEqual(4.5);
      return Object.keys(variables).sort();
    }));

    for (const tokens of catalogs.slice(1)) expect(tokens).toEqual(catalogs[0]);
  });

  it("keeps every layout fragment rootless, local, inert, and slot-driven", async () => {
    for (const layout of expectedLayouts) {
      const html = await readFile(path.join(skillRoot, `assets/layouts/${layout}.html`), "utf8");
      const elements = collectElements(parseFragment(html));
      expect(elements.every((element) => MODEL_HTML_CONTRACT.allowedTags.includes(element.tagName))).toBe(true);
      expect(() => validateSlideHtml({
        html,
        slideId: "slide-01",
        sourceRefs: [],
        sourceBlockIds: new Set(),
        assetIds: new Set(),
      })).not.toThrow();
      expect(elements.length).toBeGreaterThan(0);
      expect(elements.some((element) => element.tagName === "script" || element.tagName === "style")).toBe(false);
      expect(elements.some((element) => element.attrs.some((attribute) => attribute.name === "data-slide-root" || attribute.name.startsWith("on") || ["src", "href", "srcset"].includes(attribute.name)))).toBe(false);
      expect(elements.some((element) => element.attrs.some((attribute) => attribute.name === "data-slot"))).toBe(true);
      const slots = elements.flatMap((element) => element.attrs
        .filter((attribute) => ["data-slot", "data-asset-slot"].includes(attribute.name))
        .map((attribute) => attribute.value)).sort();
      expect(slots).toEqual(expectedLayoutSlots[layout]);
    }
  });

  it("starts with no unreviewed media assets", async () => {
    const media = JSON.parse(await readFile(path.join(skillRoot, "assets/media/catalog.json"), "utf8"));
    expect(media).toEqual({ assets: [] });
  });
});
