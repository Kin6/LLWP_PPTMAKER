# Design Direction

Commit to one direction before slide generation. Do not present variants, alternatives, or mixed visual systems. The service supplies the complete outline and one already selected bundled theme; treat both as locked inputs.

Call `write_theme` exactly once with only `designBriefMarkdown`. Do not return CSS. The service validates and writes the bundled theme atomically with the brief.

Keep the brief concise and concrete. Include these sections: typography scale, palette, grid, spacing, image grammar, chart grammar, motion level, visual motif vocabulary, slide composition map, and prohibited patterns. State how the selected `--deck-*` colors and type sizes support the audience and narrative. Define 3-5 topic-linked visual motifs and assign every slide ID a dominant visual anchor within 2-3 coherent layout families. Make the cover and closing composition distinctive. Do not default to corporate dashboards, repeated top bars, or generic card grids when the topic and audience call for a different visual language.

When image generation and approved assets are unavailable, design complete no-image compositions from safe HTML/CSS geometry, diagrams, color fields, and large typography. Do not reserve blank image placeholders or let the deck collapse into bordered text panels.
