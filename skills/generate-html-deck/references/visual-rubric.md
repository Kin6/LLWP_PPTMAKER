# Visual Rubric

Use one bounded calibration, build, review, and repair cycle.

## Calibration

Select `slide-01` and the highest-density non-cover slide. Build both before the rest. Record their stable IDs in order in `calibrationSlideIds` and verify title fit, reading order, source clearance, body legibility, contrast, and asset-slot behavior. A one-slide outline has no non-cover candidate, so calibrate and record only `slide-01`.

## Bounded Build

Partition all slides into ordered `buildBatches` of two or three IDs. Their flattened IDs must cover every slide exactly once in slide order. Set `maxConcurrency` to `2` or lower. Reuse the calibrated theme and component rules; a batch does not create a new direction.

## One Complete Review

Render or assemble one contact sheet containing every slide and review it once at a readable scale. Record `contactSheetReviewCount: 1` and a `contactSheetReview` object with every stable ID in `slideIds` plus the observed defects in `findings`. Check:

- canvas and safe inset;
- overflow, clipping, and footer collisions;
- repeated alignment and spacing;
- contrast and minimum readable body size;
- source markers and empty asset slots;
- cross-slide rhythm and unintended repetition.

Name the slide IDs and defects found. Do not claim a contact-sheet review that was not performed. The findings must include at least one concrete, visually observed defect for the targeted repair round.

## One Targeted Repair

Run one targeted repair round against only the named defects, then re-check those slides. Record `targetedRepairRounds: 1` plus a non-empty `targetedRepairs` array; each record uses a finding's `slideId` and a concrete `repair` string. Do not regenerate unaffected slides or start a second broad review.

Delete calibration previews, contact-sheet HTML/CSS/PNG, browser profiles, and other temporary QA files after the review. Leave exactly the `slide-NN.html` fragments, one shared CSS file, and `process.json` in the delivery directory.

At minimum, preserve this auditable shape in `process.json`:

```json
{
  "designDirection": "one named direction",
  "calibrationSlideIds": ["slide-01", "slide-06"],
  "buildBatches": [["slide-01", "slide-02"], ["slide-03", "slide-04", "slide-05"], ["slide-06", "slide-07", "slide-08"]],
  "maxConcurrency": 2,
  "contactSheetReviewCount": 1,
  "contactSheetReview": {
    "slideIds": ["slide-01", "slide-02", "slide-03", "slide-04", "slide-05", "slide-06", "slide-07", "slide-08"],
    "findings": [{ "slideId": "slide-07", "defect": "timeline markers collide with labels" }]
  },
  "targetedRepairRounds": 1,
  "targetedRepairs": [{ "slideId": "slide-07", "repair": "separated markers from labels and rechecked slide-07" }]
}
```

The dense ID in the example is illustrative; compute it from the current outline.
