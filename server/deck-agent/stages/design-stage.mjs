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

export async function runDesignStage(context) {
  const skill = await context.skillLoader.load("design");
  const themeHint = STYLE_THEME_HINT[context.input.source.styleId] || "minimal-white";
  await context.runner.runStage({
    jobId: context.jobId,
    stage: "design",
    messages: [
      { role: "system", content: skill.instructions },
      {
        role: "user",
        content: JSON.stringify({
          task: "Return exactly one design direction without changing outline content",
          themeHint,
          requiredBriefSections: REQUIRED_BRIEF_SECTIONS,
        }),
      },
    ],
    allowedTools: context.tools.forStage("design", context),
    maxTurns: 1,
    maxUpstreamCalls: upstreamCallBudget(1),
    timeoutMs: 120_000,
    signal: context.signal,
    emit: context.emit,
  });
  const designBrief = await context.store.readArtifact(context.jobId, "design-brief.md", { optional: true });
  const themeCss = await context.store.readArtifact(context.jobId, "working/theme.css", { optional: true });
  if (!designBrief || !themeCss) throw new Error("Design stage did not publish its single direction");
  return { designBrief, themeCss, themeHint };
}
