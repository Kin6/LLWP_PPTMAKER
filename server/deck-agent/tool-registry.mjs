import { parseFragment, serialize } from "parse5";
import * as csstree from "css-tree";
import { z } from "zod";
import { validateThemeCss } from "./css-policy.mjs";
import { sanitizeSlide } from "./html-policy.mjs";
import { parseOutline } from "./outline.mjs";

const emptyInputSchema = z.object({}).strict();
const markdownSchema = z.object({ markdown: z.string().min(1).max(2_000_000) }).strict();
const themeSchema = z.object({ designBriefMarkdown: z.string().min(1).max(12_000) }).strict();

const assetSlotSchema = z.object({
  slotId: z.string().regex(/^[a-z0-9-]+$/),
  purpose: z.string().min(1).max(500),
  aspectRatio: z.enum(["16:9", "4:3", "3:2", "1:1", "3:4"]),
  safeArea: z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().positive().max(1), h: z.number().positive().max(1),
  }).strict(),
  sourceBlockIds: z.array(z.string()).max(20),
}).strict();

const chartSpecSchema = z.object({
  chartId: z.string().regex(/^chart-[a-z0-9-]+$/),
  type: z.enum(["bar", "line", "pie", "scatter"]),
  labels: z.array(z.string().max(120)).max(40),
  series: z.array(z.object({
    name: z.string().max(120),
    values: z.array(z.number().finite()).max(40),
    colorToken: z.enum(["primary", "secondary", "accent", "positive", "negative"]),
  }).strict()).min(1).max(8),
}).strict();

export const writeSlideInputSchema = z.object({
  slideId: z.string().regex(/^slide-\d{2}$/),
  html: z.string().max(200_000),
  css: z.string().max(120_000),
  assetSlots: z.array(assetSlotSchema).max(6),
  charts: z.array(chartSpecSchema).max(6),
}).strict();

const STAGE_TOOLS = Object.freeze({
  outline: ["read_source_blocks", "write_outline"],
  design: ["write_theme"],
  calibrating: ["read_outline", "write_slide", "render_deck", "inspect_slide", "capture_slide", "patch_slide"],
  building: ["read_outline", "write_slide"],
  "generating-assets": ["generate_asset", "patch_slide"],
  verifying: ["render_deck", "inspect_slide", "capture_slide"],
  repairing: ["read_outline", "inspect_slide", "capture_slide", "patch_slide", "publish_deck"],
});

const SERVICE_ATTRIBUTES = new Set(["data-slide-root", "data-slide-id", "data-source-refs", "data-density", "data-asset-state"]);
const DESIGN_BRIEF_REQUIREMENTS = Object.freeze([
  ["typography scale", /typography\s+scale|字体层级|字号层级|排版比例/i],
  ["palette", /palette|色板|配色/i],
  ["grid", /grid|网格/i],
  ["spacing", /spacing|间距/i],
  ["image grammar", /image\s+grammar|图像语法|图片语法|图像规则|图片规则/i],
  ["chart grammar", /chart\s+grammar|图表语法|图表规则/i],
  ["motion level", /motion\s+level|动效等级|动画等级/i],
  ["prohibited patterns", /prohibited\s+patterns|禁止模式|禁用模式/i],
]);

function validateDesignBrief(markdown) {
  const missing = DESIGN_BRIEF_REQUIREMENTS
    .filter(([, pattern]) => !pattern.test(markdown))
    .map(([label]) => label);
  if (missing.length) throw new Error(`Design brief is missing required sections: ${missing.join(", ")}`);
}

function canonicalThemeCss(css) {
  const ast = csstree.parse(css, { positions: false });
  csstree.walk(ast, (node) => {
    if (node.type === "Declaration" && node.property.startsWith("--") && node.value.type === "Raw") {
      node.value.value = node.value.value.trim().replace(/\s*,\s*/g, ",");
    }
  });
  return csstree.generate(ast);
}

function normalizeModelFragment(html, slotIds) {
  const fragment = parseFragment(html);
  const visit = (node) => {
    if (node.attrs) node.attrs = node.attrs.filter((attribute) => !SERVICE_ATTRIBUTES.has(attribute.name));
    const slot = node.attrs?.find((attribute) => attribute.name === "data-asset-slot")?.value;
    if (slot) {
      if (!slotIds.has(slot)) throw new Error(`Unknown asset slot: ${slot}`);
      node.childNodes = [];
    }
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  };
  visit(fragment);
  return serialize(fragment);
}

function sourceIdSet(context) {
  return new Set((context.sourceBlocks || []).map((block) => block.id));
}

async function readOutline(context) {
  if (context.outline) return context.outline;
  if (typeof context.readOutline === "function") return context.readOutline();
  const markdown = await context.store.readArtifact(context.jobId, "slides-content.md");
  return parseOutline(markdown, {
    expectedSlideCount: context.input.source.slideCount,
    sourceBlockIds: sourceIdSet(context),
  });
}

function builtInTool(name, context) {
  if (name === "read_source_blocks") {
    return {
      schema: emptyInputSchema,
      execute: async () => ({
        summary: "Source blocks loaded",
        modelContent: JSON.stringify({ sourceBlocks: context.sourceBlocks || [] }),
      }),
    };
  }
  if (name === "read_outline") {
    return { schema: emptyInputSchema, execute: async () => ({ value: await readOutline(context), summary: "Outline loaded" }) };
  }
  if (name === "write_outline") {
    return {
      schema: markdownSchema,
      execute: async ({ markdown }) => {
        parseOutline(markdown, {
          expectedSlideCount: context.input.source.slideCount,
          sourceBlockIds: sourceIdSet(context),
        });
        await context.store.writeArtifact(context.jobId, "slides-content.md", markdown, { signal: context.signal });
        return { summary: "Outline written" };
      },
    };
  }
  if (name === "write_theme") {
    return {
      schema: themeSchema,
      execute: async ({ designBriefMarkdown }) => {
        validateDesignBrief(designBriefMarkdown);
        if (typeof context.selectedThemeCss !== "string" || !context.selectedThemeCss.trim()) {
          throw new Error("Design stage did not select a bundled theme");
        }
        const css = validateThemeCss(canonicalThemeCss(context.selectedThemeCss));
        await context.store.runExclusive(context.jobId, async () => {
          await context.store.writeArtifact(context.jobId, "design-brief.md", designBriefMarkdown, { alreadyLocked: true, signal: context.signal });
          await context.store.writeArtifact(context.jobId, "working/theme.css", css, { alreadyLocked: true, signal: context.signal });
        });
        return { summary: "Single design direction written" };
      },
    };
  }
  if (name === "write_slide") {
    return {
      schema: writeSlideInputSchema,
      execute: async (input) => {
        if (Array.isArray(context.targetSlideIds) && !context.targetSlideIds.includes(input.slideId)) {
          throw new Error(`Slide ${input.slideId} is outside the requested targets`);
        }
        const outline = await readOutline(context);
        const slide = outline.slides.find((candidate) => candidate.slideId === input.slideId);
        if (!slide) throw new Error(`Unknown target slide: ${input.slideId}`);
        const knownSources = sourceIdSet(context);
        const slots = input.assetSlots.map((slot) => ({
          ...slot,
          sourceBlockIds: [...new Set(slot.sourceBlockIds.filter((id) => slide.sourceBlockIds.includes(id)))],
        }));
        const rootlessHtml = normalizeModelFragment(input.html, new Set(slots.map((slot) => slot.slotId)));
        const sanitized = sanitizeSlide({
          html: rootlessHtml,
          css: input.css,
          slideId: slide.slideId,
          sourceRefs: slide.sourceBlockIds,
          sourceBlockIds: knownSources,
          assetIds: new Set(),
        });
        await context.store.runExclusive(context.jobId, async () => {
          const manifest = await context.store.readJson(context.jobId, "working/manifest.json", { optional: true, alreadyLocked: true }) || { slides: [] };
          const entry = {
            slideId: slide.slideId,
            number: slide.number,
            title: slide.title,
            claim: slide.claim,
            speakerNotes: slide.speakerNotes,
            sourceRefs: [...slide.sourceBlockIds],
            sourceBlockIds: [...slide.sourceBlockIds],
            densityScore: slide.densityScore,
            assetSlots: slots,
            charts: input.charts,
            status: "done",
          };
          const slides = [...(manifest.slides || [])];
          const index = slides.findIndex((candidate) => candidate.slideId === slide.slideId);
          if (index === -1) slides.push(entry);
          else slides[index] = entry;
          slides.sort((left, right) => left.slideId.localeCompare(right.slideId));
          await context.store.writeArtifact(context.jobId, `working/slides/${slide.slideId}.html`, sanitized.html, { alreadyLocked: true, signal: context.signal });
          await context.store.writeArtifact(context.jobId, `working/slides/${slide.slideId}.css`, sanitized.css, { alreadyLocked: true, signal: context.signal });
          await context.store.writeJson(context.jobId, "working/manifest.json", { ...manifest, slides }, { alreadyLocked: true, signal: context.signal });
        });
        return { summary: `Slide ${slide.slideId} written` };
      },
    };
  }
  return undefined;
}

function bindTool(tool, context) {
  if (!tool || typeof tool.execute !== "function" || !tool.schema?.parse) {
    throw new Error("Registered tools require a schema and execute function");
  }
  return {
    schema: tool.schema,
    execute: (input, runtime = {}) => tool.execute(input, { ...runtime, context }),
  };
}

export function createToolRegistry({ tools = {} } = {}) {
  return {
    forStage(stage, context) {
      const names = STAGE_TOOLS[stage];
      if (!names) throw new Error(`No tool policy for stage ${stage}`);
      return Object.fromEntries(names.map((name) => {
        const tool = builtInTool(name, context) || tools[name];
        if (!tool) throw new Error(`Tool ${name} is not registered`);
        return [name, bindTool(tool, context)];
      }));
    },
  };
}
