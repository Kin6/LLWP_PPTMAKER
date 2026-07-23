---
name: generate-html-deck
description: Use when creating or revising source-grounded HTML presentation decks that need visual design, fixed-slide layout, local assets, browser QA, or standalone offline delivery.
---

# Generate HTML Deck

## Stage Order

Run stages in this order:

1. `outline`: validate the Markdown outline, slide count, claims, notes, and source block IDs.
2. `design`: commit to one design direction and one catalog theme.
3. `calibrating`: build and inspect the cover plus the densest non-cover slide.
4. `building`: build the remaining slides in bounded batches and resolve local asset slots.
5. `verifying`: inspect the complete deck once as a contact sheet and run deterministic checks.
6. `repairing`: make one targeted repair round, then re-run the failed checks.

## Stop Conditions

- Stop `outline` when validation reports a missing claim, note, source, narrative, or continuous slide number. Do not design around invalid input.
- Stop `design` unless exactly one direction is recorded and every dependency is local and reviewable.
- Stop `calibrating` until both calibration slides pass the visual and security rubrics. Do not build the rest first.
- Stop `building` on an unknown source ID, unresolved image, unsafe fragment, overflow, or out-of-budget batch.
- Stop `verifying` after one complete contact-sheet review. Route only named failures to `repairing`.
- Stop `repairing` after one targeted round. Re-verify repaired slides; if any required check still fails, report `needs-review` instead of broadening the repair.

## Stage Routing

Read only the references routed to the active stage.

| Stage | Required reference IDs |
| --- | --- |
| `outline` | `content-density`, `source-provenance` |
| `design` | `design-direction`, `layout-catalog`, `security-contract` |
| `calibrating` | `design-direction`, `layout-catalog`, `visual-rubric`, `security-contract` |
| `building` | `content-density`, `layout-catalog`, `source-provenance`, `security-contract` |
| `verifying` | `visual-rubric`, `security-contract` |
| `repairing` | `visual-rubric`, `security-contract` |
