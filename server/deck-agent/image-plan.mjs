export function effectiveImageCount({ enabled, imageCount, slideCount }) {
  if (typeof enabled !== "boolean") throw new TypeError("Image generation enabled must be boolean");
  if (!Number.isSafeInteger(imageCount) || imageCount < 0) {
    throw new TypeError("Image count must be a nonnegative integer");
  }
  if (!Number.isSafeInteger(slideCount) || slideCount < 1) {
    throw new TypeError("Slide count must be a positive integer");
  }
  if (!enabled) return 0;
  return Math.min(imageCount === 0 ? slideCount : imageCount, slideCount);
}

export function createImagePlan(outline, options = {}, allowedAssets = []) {
  if (!outline || !Array.isArray(outline.slides) || outline.slides.length === 0) {
    throw new TypeError("Image plan requires a nonempty outline");
  }
  const slideIds = outline.slides.map((slide) => slide.slideId);
  const budget = effectiveImageCount({
    enabled: options.imageEnabled === true,
    imageCount: Number.isSafeInteger(options.imageCount) ? options.imageCount : 0,
    slideCount: slideIds.length,
  });
  const generationEligibleSlideIds = selectPrioritySlides(outline, budget);
  const hasApprovedAssets = Array.isArray(allowedAssets) && allowedAssets.length > 0;
  return Object.freeze({
    generationEnabled: budget > 0,
    generatedImageBudget: budget,
    maxAssetSlotsPerSlide: 1,
    generationEligibleSlideIds: Object.freeze(generationEligibleSlideIds),
    assetSlotsAllowedSlideIds: Object.freeze(hasApprovedAssets ? slideIds : generationEligibleSlideIds),
    rules: Object.freeze([
      "Return at most one assetSlots item for each allowed slide.",
      "Slides outside assetSlotsAllowedSlideIds must return assetSlots as an empty array.",
      "Use an asset slot only when a meaningful visual improves the slide; otherwise use a complete no-image layout.",
      "Do not put presentation text, labels, logos, or watermarks inside generated images.",
    ]),
  });
}

function selectPrioritySlides(outline, budget) {
  if (budget === 0) return [];
  const slides = outline.slides;
  if (budget >= slides.length) return slides.map((slide) => slide.slideId);

  const nonClosing = slides.length > 2 ? slides.slice(0, -1) : slides;
  const contentCandidates = nonClosing.slice(1);
  const dense = [...contentCandidates].sort((left, right) => (
    Number(right.densityScore || 0) - Number(left.densityScore || 0)
      || Number(left.number || 0) - Number(right.number || 0)
  ))[0];
  const selected = new Set([slides[0].slideId]);
  if (dense) selected.add(dense.slideId);

  const denominator = Math.max(1, budget - 1);
  for (let index = 1; index < budget && selected.size < budget; index += 1) {
    const candidateIndex = Math.round(index * (nonClosing.length - 1) / denominator);
    selected.add(nonClosing[candidateIndex].slideId);
  }
  for (const slide of [...nonClosing, ...slides]) {
    if (selected.size >= budget) break;
    selected.add(slide.slideId);
  }
  return slides.map((slide) => slide.slideId).filter((slideId) => selected.has(slideId));
}
