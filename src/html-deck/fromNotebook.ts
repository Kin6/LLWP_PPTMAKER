import type { GeneratedAsset, NotebookDeckSpec, NotebookSlideSpec } from "../types";
import type { HtmlChartNode, HtmlDeckSpec, HtmlNode, HtmlTextNode } from "./types";

const themeMap = {
  "dark-executive": {
    name: "深色叙事",
    background: "#071017",
    surface: "#14232d",
    text: "#f4f7f8",
    muted: "#a7b4bb",
    primary: "#12c7ed",
    accent: "#d99a32",
    fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
  },
  "editorial-visual": {
    name: "编辑科技",
    background: "#0b0b0c",
    surface: "#f5f5f2",
    text: "#f5f5f2",
    muted: "#a7aaad",
    primary: "#00bfd4",
    accent: "#f03b1e",
    fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
  },
  "light-consulting": {
    name: "清晰咨询",
    background: "#f8f8f4",
    surface: "#ffffff",
    text: "#111820",
    muted: "#667078",
    primary: "#0e6cff",
    accent: "#e74c36",
    fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
  },
} as const;

export function notebookToHtmlDeck(deck: NotebookDeckSpec, assets: GeneratedAsset[] = []): HtmlDeckSpec {
  const theme = themeMap[deck.theme || "light-consulting"];
  const id = makeId("html-deck");
  return {
    id,
    title: deck.title,
    width: 1600,
    height: 900,
    revision: 1,
    theme: { ...theme },
    slides: deck.slides.map((slide, index) => buildSlide(slide, index, deck.slides.length, theme, assets)),
    variables: [
      { id: "accent-strength", label: "强调色强度", type: "number", value: 1, min: 0.2, max: 1.6, step: 0.1 },
      { id: "motion-enabled", label: "启用动效", type: "boolean", value: true },
      { id: "primary-color", label: "主色", type: "color", value: theme.primary },
      { id: "accent-color", label: "强调色", type: "color", value: theme.accent },
    ],
    comments: [],
    drawings: [],
  };
}

function buildSlide(
  slide: NotebookSlideSpec,
  index: number,
  total: number,
  theme: (typeof themeMap)[keyof typeof themeMap],
  assets: GeneratedAsset[],
) {
  const slideId = `slide-${index + 1}`;
  const dark = theme.background !== "#f8f8f4";
  const visualLeft = slide.layout === "visual-left";
  const section = slide.layout === "section";
  const cover = slide.layout === "cover" || index === 0;
  const nodes: HtmlNode[] = [];
  const titleWidth = section ? 0.82 : cover ? 0.58 : 0.52;
  const titleX = section ? 0.09 : visualLeft ? 0.49 : 0.07;

  nodes.push(textNode(`${slideId}-title`, "标题", titleX, cover ? 0.16 : 0.11, titleWidth, cover ? 0.24 : 0.16, slide.title, "title", {
    fontSize: cover ? 58 : section ? 52 : 38,
    fontWeight: 760,
    lineHeight: 1.12,
    color: theme.text,
    align: section ? "center" : "left",
    verticalAlign: "middle",
  }));

  if (slide.subtitle) {
    nodes.push(textNode(`${slideId}-subtitle`, "副标题", titleX, cover ? 0.43 : 0.28, titleWidth, 0.1, slide.subtitle, "subtitle", {
      fontSize: cover ? 22 : 17,
      fontWeight: 480,
      lineHeight: 1.35,
      color: theme.muted,
      align: section ? "center" : "left",
      verticalAlign: "top",
    }));
  }

  if (!section && slide.claim) {
    nodes.push(textNode(`${slideId}-claim`, "核心结论", titleX, cover ? 0.57 : 0.4, titleWidth, 0.12, slide.claim, "body", {
      fontSize: cover ? 24 : 20,
      fontWeight: 650,
      lineHeight: 1.3,
      color: theme.text,
      align: "left",
      verticalAlign: "top",
    }));
  }

  if (!section && slide.bullets?.length) {
    const bullets = slide.bullets.slice(0, 5).map((item) => `• ${item}`).join("\n");
    nodes.push(textNode(`${slideId}-bullets`, "证据要点", titleX, cover ? 0.7 : 0.55, titleWidth, cover ? 0.18 : 0.31, bullets, "body", {
      fontSize: cover ? 17 : 16,
      fontWeight: 450,
      lineHeight: 1.55,
      color: theme.text,
      align: "left",
      verticalAlign: "top",
    }));
  }

  const primary = slide.imageIndex == null ? undefined : assets.find((asset) => asset.index === slide.imageIndex);
  if (primary) {
    nodes.push({
      id: `${slideId}-image`,
      type: "image",
      name: "主视觉",
      x: visualLeft ? 0.05 : 0.62,
      y: cover ? 0.08 : 0.18,
      w: cover ? 0.36 : 0.33,
      h: cover ? 0.82 : 0.68,
      zIndex: 2,
      src: primary.url,
      alt: primary.summary || primary.filename,
      objectFit: "cover",
      assetId: primary.id,
      prompt: primary.prompt,
      animation: "scale",
    });
  } else if (slide.tableRows?.length) {
    nodes.push(tableToChart(slideId, slide, visualLeft ? 0.05 : 0.61, 0.22, 0.34, 0.58, theme.primary));
  } else if (!section) {
    nodes.push({
      id: `${slideId}-visual-shape`,
      type: "shape",
      name: "视觉色块",
      x: visualLeft ? 0.05 : 0.62,
      y: cover ? 0.12 : 0.2,
      w: cover ? 0.34 : 0.31,
      h: cover ? 0.74 : 0.62,
      zIndex: 1,
      shape: "rect",
      fill: dark ? "#14232d" : "#eaf1ff",
      stroke: theme.primary,
      strokeWidth: 1,
      radius: 24,
      opacity: 0.96,
      animation: "rise",
    });
  }

  nodes.push(textNode(`${slideId}-number`, "页码", 0.9, 0.92, 0.06, 0.04, `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, "caption", {
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
    color: theme.muted,
    align: "right",
    verticalAlign: "middle",
  }));

  return {
    id: slideId,
    title: slide.title,
    background: theme.background,
    transition: cover ? "zoom" as const : "fade" as const,
    nodes,
    interactions: [{ id: `${slideId}-next`, trigger: "click" as const, action: "next" as const }],
    speakerNotes: slide.speakerNotes || "",
    sourceRefs: slide.sourceRefs,
  };
}

function textNode(
  id: string,
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  role: HtmlTextNode["role"],
  style: HtmlTextNode["style"],
): HtmlTextNode {
  return { id, type: "text", name, x, y, w, h, zIndex: 10, text, role, style, animation: role === "title" ? "rise" : "fade" };
}

function tableToChart(slideId: string, slide: NotebookSlideSpec, x: number, y: number, w: number, h: number, accentColor: string): HtmlChartNode {
  const rows = slide.tableRows || [];
  const labels = rows.slice(1, 9).map((row, index) => String(row[0] || `项目 ${index + 1}`));
  const headers = rows[0] || [];
  const series = headers.slice(1, 4).map((header, columnIndex) => ({
    name: String(header || `系列 ${columnIndex + 1}`),
    values: rows.slice(1, 9).map((row) => Number(String(row[columnIndex + 1] || "").replace(/[^\d.-]/g, "")) || 0),
  }));
  return {
    id: `${slideId}-chart`,
    type: "chart",
    name: "数据图表",
    x, y, w, h,
    zIndex: 4,
    chartType: "bar",
    labels,
    series: series.length ? series : [{ name: "数值", values: labels.map((_, index) => index + 1) }],
    showLegend: true,
    showValues: true,
    accentColor,
    animation: "rise",
  };
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
