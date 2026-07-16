import assert from "node:assert/strict";

const { buildLocalDecompositions } = await import("../src/lib/visualDecomposition.ts");

const deck = {
  title: "Fallback test",
  theme: "light-consulting",
  story: { thesis: "", audienceInsight: "", narrativeArc: [], evidenceGaps: [], styleId: "blank" },
  slides: [
    { title: "Cover", layout: "cover" },
    { title: "Left visual", layout: "visual-left" },
    { title: "Section", layout: "section" },
  ],
};

const values = buildLocalDecompositions(deck, [
  { slideIndex: 0 },
  { slideIndex: 1 },
  { slideIndex: 2 },
]);

assert.equal(values.length, 3);
assert.ok(values[0].safeArea.x < 0.5, "cover should reserve text on the left");
assert.ok(values[1].safeArea.x > 0.5, "visual-left should reserve text on the right");
assert.ok(values[2].safeArea.w > 0.7, "section should reserve a wide centered title area");
assert.ok(values.every((item) => item.parts.length > 0), "fallback should always provide editable crop regions");

console.log("Visual decomposition fallback test passed: cover, visual-left and section layouts.");
