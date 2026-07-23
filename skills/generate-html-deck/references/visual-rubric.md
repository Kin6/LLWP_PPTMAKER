# Visual Rubric

Use one bounded calibration, build, review, and repair cycle.

## Calibration

Select `slide-01` and the highest-density non-cover slide. Build both before the rest. Record their stable IDs in order in `calibrationSlideIds` and verify title fit, reading order, source clearance, body legibility, contrast, and asset-slot behavior. Apply zero or one correction, record that integer in `calibrationCorrectionCount`, then record `designRulesLocked: true`; do not correct calibration or change design rules after the lock. A one-slide outline has no non-cover candidate, so calibrate and record only `slide-01`.

## Bounded Build

Remove the calibration IDs from slide order, then partition only the remaining IDs into ordered `buildBatches` of two or three. Their flattened IDs must equal the remaining IDs exactly once and in order. Set `maxConcurrency` to `2` or lower. After each page validates, append its own `{ "slideId": "slide-NN", "status": "valid" }` record to `pageCheckpoints` in slide order; never checkpoint a batch as one unit. Reuse the locked theme and component rules; a batch does not create a new direction.

## One Complete Review

Render or assemble one contact sheet containing every slide and review it once at a readable scale. Record `contactSheetReviewCount: 1` and a `contactSheetReview` object with every stable ID in `slideIds` plus the observed defects in `findings`. Check:

Treat the supplied visible outline as authoritative when it conflicts with the design brief. Speaker notes are intentionally omitted: never require a presenter prompt, audience interaction, or note-only phrase to appear on a slide.

- canvas and safe inset;
- overflow, clipping, and footer collisions;
- repeated alignment and spacing;
- contrast and minimum readable body size;
- source markers and empty asset slots;
- cross-slide rhythm and unintended repetition.
- topic and audience fit: reject a generic corporate/dashboard treatment when the subject calls for a clearly different visual language;
- dominant visual anchors and purposeful use of the full safe canvas, including no-image HTML/CSS compositions.

Name the slide IDs and concrete defects found. Do not claim a contact-sheet review that was not performed. A clean review records zero findings as `findings: []`; it does not invent a defect to force a repair.

## Zero Or One Targeted Repair

If `findings` is empty, record `targetedRepairRounds: 0` and `targetedRepairs: []`, then publish without a repair. If findings exist, run one targeted repair round against only matching failed slide IDs, re-check only those slides, and record `targetedRepairRounds: 1` plus concrete `targetedRepairs`. The allowed contract is zero or one targeted repair round. Do not repair unaffected slides or start a second broad review.

Delete calibration previews, contact-sheet HTML/CSS/PNG, browser profiles, and other temporary QA files after the review. Leave exactly the `slide-NN.html` fragments, one shared CSS file, and `process.json` in the delivery directory.

At minimum, preserve this auditable shape in `process.json`:

```json
{
  "designDirection": "one named direction",
  "calibrationSlideIds": ["slide-01", "slide-06"],
  "calibrationCorrectionCount": 0,
  "designRulesLocked": true,
  "buildBatches": [["slide-02", "slide-03", "slide-04"], ["slide-05", "slide-07", "slide-08"]],
  "pageCheckpoints": [{ "slideId": "slide-02", "status": "valid" }, { "slideId": "slide-03", "status": "valid" }, { "slideId": "slide-04", "status": "valid" }, { "slideId": "slide-05", "status": "valid" }, { "slideId": "slide-07", "status": "valid" }, { "slideId": "slide-08", "status": "valid" }],
  "maxConcurrency": 2,
  "contactSheetReviewCount": 1,
  "contactSheetReview": {
    "slideIds": ["slide-01", "slide-02", "slide-03", "slide-04", "slide-05", "slide-06", "slide-07", "slide-08"],
    "findings": []
  },
  "targetedRepairRounds": 0,
  "targetedRepairs": []
}
```

The dense ID in the example is illustrative; compute it from the current outline.
