import type { HtmlChartNode, HtmlDeckSpec, HtmlNode } from "./types";

export async function exportHtmlDeckAsPptx(deck: HtmlDeckSpec) {
  const { default: pptxgen } = await import("pptxgenjs");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "LLWP PPTMAKER";
  pptx.subject = "Static editable fallback from an interactive HTML presentation";
  pptx.title = deck.title;
  pptx.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei" };

  for (const slideSpec of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: toPptColor(slideSpec.background, "F8F8F4") };
    for (const node of [...slideSpec.nodes].filter((item) => !item.hidden).sort((left, right) => left.zIndex - right.zIndex)) {
      await addNode(pptx, slide, node, deck);
    }
    slide.addNotes([slideSpec.speakerNotes, "", "交互式 HTML 降级导出：Web 动画、视频状态和交互逻辑不会保留。"].filter(Boolean).join("\n"));
  }

  await pptx.writeFile({ fileName: `${sanitizeFileName(deck.title)}-static.pptx` });
}

async function addNode(pptx: any, slide: any, node: HtmlNode, deck: HtmlDeckSpec) {
  const rect = { x: node.x * 13.333, y: node.y * 7.5, w: node.w * 13.333, h: node.h * 7.5 };
  if (node.type === "text") {
    slide.addText(node.text, {
      ...rect,
      fontFace: "Microsoft YaHei",
      fontSize: Math.max(6, node.style.fontSize * 0.46),
      bold: node.style.fontWeight >= 650,
      color: toPptColor(node.style.color, "111820"),
      align: node.style.align,
      valign: node.style.verticalAlign,
      margin: Math.max(0, (node.style.padding || 0) * 0.01),
      breakLine: false,
      fit: "shrink",
      fill: node.style.backgroundColor ? { color: toPptColor(node.style.backgroundColor, "FFFFFF"), transparency: Math.round((1 - (node.style.opacity ?? 1)) * 100) } : undefined,
      line: node.style.borderWidth ? { color: toPptColor(node.style.borderColor || deck.theme.muted, "DCE0E2"), width: node.style.borderWidth * 0.5 } : undefined,
    });
    return;
  }
  if (node.type === "shape") {
    const shape = node.shape === "circle" ? pptx.ShapeType.ellipse : node.shape === "line" ? pptx.ShapeType.line : pptx.ShapeType.roundRect;
    slide.addShape(shape, {
      ...rect,
      rectRadius: node.radius,
      fill: { color: toPptColor(node.fill, "FFFFFF"), transparency: Math.round((1 - (node.opacity ?? 1)) * 100) },
      line: { color: toPptColor(node.stroke, "DCE0E2"), width: node.strokeWidth },
    });
    return;
  }
  if (node.type === "image") {
    const data = await imageData(node.src);
    if (data) slide.addImage({ data, ...rect, sizing: { type: node.objectFit, w: rect.w, h: rect.h } });
    return;
  }
  if (node.type === "chart") {
    const chartType = chartTypeFor(pptx, node);
    const chartData = node.chartType === "pie"
      ? [{ name: node.series[0]?.name || "数据", labels: node.labels, values: node.series[0]?.values || [] }]
      : node.series.map((series) => ({ name: series.name, labels: node.labels, values: series.values }));
    slide.addChart(chartType, chartData, {
      ...rect,
      showLegend: node.showLegend,
      showValue: node.showValues,
      showTitle: false,
      chartColors: [toPptColor(node.accentColor, "0E6CFF"), toPptColor(deck.theme.accent, "E74C36"), toPptColor(deck.theme.muted, "667078")],
      showCatName: node.chartType === "pie",
      showPercent: node.chartType === "pie",
      catAxisLabelColor: toPptColor(deck.theme.muted, "667078"),
      valAxisLabelColor: toPptColor(deck.theme.muted, "667078"),
      showBorder: false,
    });
    return;
  }
  if (node.type === "widget") {
    const value = String(node.props.value ?? "");
    slide.addText(value || node.name, { ...rect, fontFace: "Microsoft YaHei", fontSize: 26, bold: true, color: toPptColor(deck.theme.primary, "0E6CFF"), fit: "shrink", margin: 0 });
    return;
  }
  if (node.type === "video") {
    slide.addShape(pptx.ShapeType.rect, { ...rect, fill: { color: "111820" }, line: { color: "111820" } });
    slide.addText("VIDEO\n请在 HTML 版本中播放", { ...rect, fontSize: 12, color: "FFFFFF", align: "center", valign: "mid", fit: "shrink" });
  }
}

function chartTypeFor(pptx: any, node: HtmlChartNode) {
  if (node.chartType === "line") return pptx.ChartType.line;
  if (node.chartType === "pie") return pptx.ChartType.doughnut;
  if (node.chartType === "scatter") return pptx.ChartType.scatter;
  if (node.chartType === "radar") return pptx.ChartType.radar;
  return pptx.ChartType.bar;
}

async function imageData(url: string) {
  if (url.startsWith("data:")) return url;
  if (!url.startsWith("blob:")) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片素材。"));
    reader.readAsDataURL(blob);
  });
}

function toPptColor(value: string, fallback: string) {
  const hex = String(value || "").trim().match(/^#([\da-f]{6})$/i)?.[1];
  return hex?.toUpperCase() || fallback;
}

function sanitizeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "interactive-deck";
}
