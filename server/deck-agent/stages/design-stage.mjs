import { upstreamCallBudget } from "../upstream-budget.mjs";
import { effectiveImageCount } from "../image-plan.mjs";
import { removeSpeakerNotes } from "../outline.mjs";

const STYLE_THEME_HINT = Object.freeze({
  "product-calm": "corporate-clean",
  "consulting-grid": "swiss-grid",
  "editorial-tech": "magazine-bold",
  "cinematic-dark": "tokyo-night",
});

const REQUIRED_BRIEF_SECTIONS = [
  "typography scale", "palette", "grid", "spacing", "image grammar",
  "chart grammar", "motion level", "visual motif vocabulary",
  "slide composition map", "prohibited patterns",
];

const PLAYFUL_TOPIC = /儿童|幼儿|卡通|动画|童话|绘本|玩具|游戏|小猪|佩奇|亲子|child|kids?|cartoon|animation|storybook|toy|game/i;
const YOUNG_AUDIENCE = /儿童|幼儿|小学|课堂|亲子|学生|child|kids?|primary|classroom|student/i;

export function selectThemeHint(source = {}) {
  const styleId = String(source.styleId || "blank");
  if (styleId !== "blank") return STYLE_THEME_HINT[styleId] || "minimal-white";
  const topic = String(source.topic || "");
  const audience = String(source.audience || "");
  return PLAYFUL_TOPIC.test(topic) && YOUNG_AUDIENCE.test(audience)
    ? "playful-classroom"
    : "minimal-white";
}

const WRITE_THEME_CONTRACT = Object.freeze({
  name: "write_theme",
  callExactlyOnce: true,
  arguments: {
    designBriefMarkdown: [
      "A concise Markdown document with exactly one design direction.",
      "It must include all required brief sections and concrete rules for later slide generation.",
      "Do not include CSS; the server applies the selected bundled theme.",
    ].join(" "),
  },
});

export async function runDesignStage(context) {
  const themeHint = selectThemeHint(context.input.source);
  const imageOptions = context.input.options || {};
  const generatedImageBudget = effectiveImageCount({
    enabled: imageOptions.imageEnabled === true,
    imageCount: Number.isSafeInteger(imageOptions.imageCount) ? imageOptions.imageCount : 0,
    slideCount: context.input.source.slideCount,
  });
  if (typeof context.loadThemePreset !== "function") {
    throw new TypeError("Design stage requires a bundled theme loader");
  }
  const [skill, storedOutlineMarkdown, selectedThemeCss] = await Promise.all([
    context.skillLoader.load("design"),
    context.store.readArtifact(context.jobId, "slides-content.md"),
    context.loadThemePreset(themeHint),
  ]);
  const outlineMarkdown = removeSpeakerNotes(storedOutlineMarkdown);
  const stageTools = context.tools.forStage("design", { ...context, selectedThemeCss });
  await context.runner.runStage({
    jobId: context.jobId,
    stage: "design",
    messages: [
      {
        role: "system",
        content: [
          skill.instructions,
          "Complete this stage in one model turn.",
          "Call write_theme exactly once. Put the complete design brief in designBriefMarkdown, set final to true, and do not call any other tool.",
          "The bundled theme CSS is fixed by the server. Do not return CSS and do not change slide content.",
          "The supplied outline intentionally excludes speaker notes. Do not invent presenter prompts, audience interactions, or other visible content that is absent from it.",
          "The server canvas is exactly 1920x1080 with one 72px safe inset. The brief must use that value and must not define a different canvas margin or nested safe inset.",
          "Treat the topic and audience as primary visual constraints. Create a domain-specific visual language; do not default to a corporate dashboard, consulting report, repeated top bar, or generic card grid unless the subject explicitly requires it.",
          "The visual motif vocabulary must name 3-5 reusable topic-linked motifs. The slide composition map must assign every slide ID one dominant visual anchor and one of 2-3 coherent layout families, with a distinctive cover and closing page.",
          generatedImageBudget > 0
            ? `The deck may generate at most ${generatedImageBudget} local images, at most one on any slide. Define one coherent image grammar for those key pages and complete no-image layouts for all others.`
            : "Image generation is disabled. Do not reserve empty image areas. Define complete no-image compositions that use safe HTML/CSS geometry, large typography, diagrams, and color fields as real visual anchors instead of bordered text panels.",
        ].join("\n\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Create exactly one concise design direction for the supplied outline without changing its content",
          outlineMarkdown,
          sourceContext: {
            topic: context.input.source.topic,
            audience: context.input.source.audience,
            requestedStyleId: context.input.source.styleId,
            selectionMode: context.input.source.styleId === "blank" ? "content-adaptive" : "user-selected",
          },
          selectedTheme: { id: themeHint, css: selectedThemeCss },
          imagePolicy: {
            generationEnabled: generatedImageBudget > 0,
            generatedImageBudget,
            maxPerSlide: 1,
            generatedImagesBecomeLocalReviewedAssets: true,
            textInsideImagesForbidden: true,
          },
          requiredBriefSections: REQUIRED_BRIEF_SECTIONS,
          requiredToolCall: WRITE_THEME_CONTRACT,
        }),
      },
    ],
    allowedTools: { write_theme: stageTools.write_theme },
    requiredToolName: "write_theme",
    maxTurns: 1,
    maxUpstreamCalls: upstreamCallBudget(1),
    timeoutMs: 120_000,
    signal: context.signal,
    emit: context.emit,
  });
  const designBrief = await context.store.readArtifact(context.jobId, "design-brief.md", { optional: true });
  const storedThemeCss = await context.store.readArtifact(context.jobId, "working/theme.css", { optional: true });
  if (!designBrief || !storedThemeCss) throw new Error("Design stage did not publish its single direction");
  return { designBrief, themeCss: storedThemeCss, themeHint };
}
