import { upstreamCallBudget } from "../upstream-budget.mjs";

const STYLE_THEME_HINT = Object.freeze({
  blank: "minimal-white",
  "product-calm": "corporate-clean",
  "consulting-grid": "swiss-grid",
  "editorial-tech": "magazine-bold",
  "cinematic-dark": "tokyo-night",
});

const REQUIRED_BRIEF_SECTIONS = [
  "typography scale", "palette", "grid", "spacing", "image grammar",
  "chart grammar", "motion level", "prohibited patterns",
];

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
  const themeHint = STYLE_THEME_HINT[context.input.source.styleId] || "minimal-white";
  if (typeof context.loadThemePreset !== "function") {
    throw new TypeError("Design stage requires a bundled theme loader");
  }
  const [skill, outlineMarkdown, selectedThemeCss] = await Promise.all([
    context.skillLoader.load("design"),
    context.store.readArtifact(context.jobId, "slides-content.md"),
    context.loadThemePreset(themeHint),
  ]);
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
        ].join("\n\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Create exactly one concise design direction for the supplied outline without changing its content",
          outlineMarkdown,
          selectedTheme: { id: themeHint, css: selectedThemeCss },
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
