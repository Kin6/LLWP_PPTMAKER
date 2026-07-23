# Content Density

Treat the validated visible outline as the slide-content contract. Preserve every claim, required fact, table value, and source reference. Speaker notes are intentionally withheld from model input, stay in manifest metadata, and are injected by the renderer; never infer or place presenter cues in visible slide HTML. Do not solve overflow by deleting evidence or inventing shorter claims.

## Classify Before Layout

For each slide, count prose, list items, table cells, and labeled sections. Rank non-cover slides by that combined load; ties go to the earlier slide. Record the cover and the highest-density non-cover slide as the calibration pair.

Use the density class to choose structure:

| Density | Typical evidence | Layout response |
| --- | --- | --- |
| Light | One claim and one short supporting element | Cover, section divider, quote, stat, image hero, or thanks |
| Medium | Two to four facts or one compact comparison | Two-column, comparison, timeline, or process steps |
| Dense | Multiple sections, a table, or five or more evidence units | Table, KPI grid, or a deliberately partitioned two-column layout |

Keep one dominant reading path. Turn repeated facts into a grid or sequence, but retain their wording and source mapping. Use at most two body hierarchy levels inside a content region.

## Fixed Geometry

- Author every slide for a `1920px` by `1080px` canvas.
- The server-owned slide root is an unpadded full canvas. Apply the `72px` safe inset exactly once in the generated composition; do not nest another four-sided safe wrapper inside it.
- Keep meaningful content inside that single `72px` safe inset.
- Reserve stable regions for title, evidence, source footer, and any asset slot.
- Use the safe canvas vertically as well as horizontally. Except for an intentional sparse divider, do not pack all meaningful content into the upper half or let the content region touch the source footer.
- Treat clipping, horizontal scroll, footer collision, and text below the safe region as failures.
- Use system font stacks and explicit line-height; do not rely on a downloaded font to make text fit.

Build the remaining deck only after the cover and densest slide prove that the chosen type scale and spacing survive both extremes.
