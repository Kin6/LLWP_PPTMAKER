import { describe, expect, it } from "vitest";
import { createImagePlan, effectiveImageCount } from "../../../server/deck-agent/image-plan.mjs";

function outlineFor(count) {
  return {
    slides: Array.from({ length: count }, (_, index) => ({
      slideId: `slide-${String(index + 1).padStart(2, "0")}`,
      number: index + 1,
      densityScore: index === 5 ? 100 : index,
    })),
  };
}

describe("HTML deck image plan", () => {
  it("treats zero as follow-total only when image generation is enabled", () => {
    expect(effectiveImageCount({ enabled: true, imageCount: 0, slideCount: 8 })).toBe(8);
    expect(effectiveImageCount({ enabled: true, imageCount: 3, slideCount: 8 })).toBe(3);
    expect(effectiveImageCount({ enabled: false, imageCount: 0, slideCount: 8 })).toBe(0);
  });

  it("reserves a bounded one-slot plan for the cover, densest page, and a spread page", () => {
    const plan = createImagePlan(outlineFor(8), { imageEnabled: true, imageCount: 3 });

    expect(plan.generatedImageBudget).toBe(3);
    expect(plan.maxAssetSlotsPerSlide).toBe(1);
    expect(plan.generationEligibleSlideIds).toEqual(["slide-01", "slide-04", "slide-06"]);
    expect(plan.assetSlotsAllowedSlideIds).toEqual(plan.generationEligibleSlideIds);
  });

  it("allows approved uploaded assets on any slide without expanding generation priority", () => {
    const plan = createImagePlan(
      outlineFor(4),
      { imageEnabled: true, imageCount: 2 },
      [{ id: "asset-approved" }],
    );

    expect(plan.generationEligibleSlideIds).toHaveLength(2);
    expect(plan.assetSlotsAllowedSlideIds).toEqual([
      "slide-01", "slide-02", "slide-03", "slide-04",
    ]);
  });
});
