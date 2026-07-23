# Design Direction

Commit to one direction before slide generation. Do not present variants, alternatives, or mixed visual systems. The service supplies the complete outline and one already selected bundled theme; treat both as locked inputs.

Call `write_theme` exactly once with only `designBriefMarkdown`. Do not return CSS. The service validates and writes the bundled theme atomically with the brief.

Keep the brief concise and concrete. Include these sections: typography scale, palette, grid, spacing, image grammar, chart grammar, motion level, and prohibited patterns. State how the selected `--deck-*` colors and type sizes support the audience and narrative. Define usable rules for cover, evidence, transition, comparison, and closing pages without rewriting slide content.
