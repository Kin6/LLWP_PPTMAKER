---
name: generate-html-deck
description: Use when creating or revising source-grounded HTML presentation decks that need visual design, fixed-slide layout, local assets, browser QA, or standalone offline delivery.
---

# Generate HTML Deck

## Stage Order

Run stages in this order:

1. `outline`: validate the Markdown outline, slide count, claims, notes, and source block IDs.
2. `design`: commit to one design direction and one catalog theme.
3. `calibrating`: build and inspect the cover plus the densest non-cover slide; record `calibrationCorrectionCount` as `0` or `1`, then set `designRulesLocked: true`.
4. `building`: put only non-calibration IDs in ordered 2-3-slide `buildBatches`, record one valid `pageCheckpoints` entry per page, and resolve local asset slots.
5. `verifying`: inspect the complete deck once as a contact sheet and run deterministic checks.
6. `repairing`: when review findings exist, make at most one targeted repair round against matching failed slides, then re-run only their failed checks.

## Stop Conditions

- Stop `outline` when validation reports a missing claim, note, narrative, continuous slide number, or a missing source while source blocks were supplied. When no source blocks were supplied, require a visible no-external-material disclosure and keep machine source references empty instead of inventing a source.
- Stop `design` unless exactly one direction is recorded and every dependency is local and reviewable.
- Stop `calibrating` until both calibration slides pass the visual and security rubrics. Do not build the rest first.
- Stop `building` on an unknown source ID, unsafe fragment, overflow, or out-of-budget batch. Resolve a missing or failed optional image to a no-image layout and continue.
- Stop `verifying` after one complete contact-sheet review. Route only named failures to `repairing`.
- Skip `repairing` when review records zero findings. Otherwise stop after one targeted round; re-verify repaired slides and report `needs-review` if any required check still fails.

## Stage Routing

Read only the references routed to the active stage.

| Stage | Required reference IDs |
| --- | --- |
| `outline` | `content-density`, `source-provenance` |
| `design` | `design-direction`, `layout-catalog` |
| `calibrating` | `design-direction`, `layout-catalog`, `visual-rubric`, `security-contract` |
| `building` | `content-density`, `layout-catalog`, `source-provenance`, `security-contract` |
| `verifying` | `visual-rubric`, `security-contract` |
| `repairing` | `visual-rubric`, `security-contract` |
