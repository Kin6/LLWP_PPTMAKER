import type { DecompositionResult } from "./apiClient";
import type { NotebookDeckSpec, SlideLayout } from "../types";

type GeneratedImage = { slideIndex: number };

export function buildLocalDecompositions(
  deck: NotebookDeckSpec,
  images: GeneratedImage[],
): DecompositionResult[] {
  return images.map((image) => {
    const layout = deck.slides[image.slideIndex]?.layout || "two-column";
    const textOnRight = layout === "visual-left";
    const centered = layout === "section";
    const safeArea = centered
      ? { x: 0.12, y: 0.2, w: 0.76, h: 0.56 }
      : textOnRight
        ? { x: 0.53, y: 0.1, w: 0.41, h: 0.8 }
        : { x: 0.06, y: 0.1, w: 0.41, h: 0.8 };

    return {
      slideIndex: image.slideIndex,
      composition: localComposition(layout),
      safeArea,
      parts: centered
        ? [{ label: "整页视觉底稿", role: "hero", x: 0, y: 0, w: 1, h: 1 }]
        : textOnRight
          ? [
              { label: "左侧主视觉", role: "hero", x: 0.03, y: 0.07, w: 0.45, h: 0.58 },
              { label: "左侧辅助视觉", role: "detail", x: 0.08, y: 0.66, w: 0.36, h: 0.27 },
            ]
          : [
              { label: "右侧主视觉", role: "hero", x: 0.51, y: 0.07, w: 0.46, h: 0.58 },
              { label: "右侧辅助视觉", role: "detail", x: 0.57, y: 0.66, w: 0.36, h: 0.27 },
            ],
    };
  });
}

function localComposition(layout: SlideLayout) {
  if (layout === "section") return "居中叙事区与全画布氛围视觉";
  if (layout === "visual-left") return "左侧主视觉，右侧原生文字安全区";
  if (layout === "cover") return "左侧标题安全区，右侧高冲击主视觉";
  return "左侧原生文字安全区，右侧高冲击主视觉";
}
