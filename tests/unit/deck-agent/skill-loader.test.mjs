import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFragment } from "parse5";
import { describe, expect, it } from "vitest";
import { createSkillLoader } from "../../../server/deck-agent/skill-loader.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skillRoot = path.join(repositoryRoot, "skills/generate-html-deck");
const expectedThemes = ["minimal-white", "corporate-clean", "swiss-grid", "editorial-serif", "academic-paper", "magazine-bold", "tokyo-night", "pitch-deck-vc"];
const expectedLayouts = ["cover", "section-divider", "two-column", "big-quote", "stat-highlight", "kpi-grid", "table", "timeline", "comparison", "process-steps", "image-hero", "thanks"];
const expectedStageFiles = {
  outline: ["SKILL.md", "references/content-density.md", "references/source-provenance.md"],
  design: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md", "references/security-contract.md"],
  calibrating: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md", "references/visual-rubric.md", "references/security-contract.md"],
  building: ["SKILL.md", "references/content-density.md", "references/layout-catalog.md", "references/source-provenance.md", "references/security-contract.md"],
  verifying: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
  repairing: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
};
const expectedLayoutSlots = {
  cover: ["cover-image", "eyebrow", "source", "subtitle", "title"],
  "section-divider": ["section-number", "summary", "title"],
  "two-column": ["left", "right", "source", "title"],
  "big-quote": ["attribution", "quote", "source"],
  "stat-highlight": ["context", "source", "stat-label", "stat-value", "title"],
  "kpi-grid": ["kpi-1", "kpi-2", "kpi-3", "kpi-4", "source", "title"],
  table: ["caption", "source", "table-body", "table-head", "title"],
  timeline: ["phase-1", "phase-2", "phase-3", "phase-4", "source", "title"],
  comparison: ["left-body", "left-heading", "right-body", "right-heading", "source", "title"],
  "process-steps": ["source", "step-1", "step-2", "step-3", "step-4", "title"],
  "image-hero": ["caption", "hero-image", "source", "title"],
  thanks: ["contact", "takeaway", "title"],
};

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

  it("rejects inherited object property names as unknown stages", async () => {
    const loader = createSkillLoader({ skillRoot });

    for (const stage of ["toString", "constructor", "__proto__"]) {
      await expect(loader.load(stage)).rejects.toThrow(/unknown stage/i);
    }
  });

  it("registers exactly eight themes and twelve layouts", async () => {
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
