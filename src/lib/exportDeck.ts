import type { GeneratedAsset, NotebookDeckSpec, NotebookSlideSpec, VisualPart } from "../types";

const colors = {
  ink: "111820",
  ink2: "253038",
  blue: "0E6CFF",
  lime: "A7D92D",
  red: "E74C36",
  muted: "667078",
  line: "DCE0E2",
  surface: "F4F5F2",
  paper: "FAFAF7",
  white: "FFFFFF",
};

export async function exportNotebookDeck(deck: NotebookDeckSpec, assets: GeneratedAsset[]) {
  const { default: pptxgen } = await import("pptxgenjs");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "DeckForge";
  pptx.company = "LLWP PPTMAKER";
  pptx.subject = "Editable AI-assisted presentation";
  pptx.title = deck.title;
  pptx.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei" };
  pptx.defineSlideMaster({
    title: "CONTENT",
    background: { color: colors.paper },
    objects: [
      { line: { x: 0.68, y: 7.08, w: 11.96, h: 0, line: { color: colors.line, width: 0.6 } } },
      { text: { text: "LLWP PPTMAKER · editable objects", options: { x: 0.7, y: 7.12, w: 4.2, h: 0.16, fontSize: 6.8, color: colors.muted } } },
    ],
    slideNumber: { x: 12.2, y: 7.1, w: 0.4, h: 0.16, fontSize: 7, color: colors.muted, align: "right" },
  });

  const cache = new Map<string, string>();
  for (const [index, item] of deck.slides.entries()) {
    const layout = item.layout || (index === 0 ? "cover" : "two-column");
    const primaryAsset = item.imageIndex == null ? undefined : assets.find((asset) => asset.index === item.imageIndex);
    const fullSlideVisual = (item.visualMode === "full-slide" || item.visualMode === "full-slide-text") && primaryAsset?.kind === "generated";
    const slide = (fullSlideVisual || layout === "cover" || layout === "section") ? pptx.addSlide() : pptx.addSlide("CONTENT");
    const partData = await getVisualParts(item, assets, cache);
    const primary = await getPrimaryImage(item, assets, cache);
    slide.addNotes([
      item.speakerNotes || "",
      "",
      `页面标题：${item.title}`,
      item.subtitle ? `副标题：${item.subtitle}` : "",
      `核心主张：${item.claim || item.title}`,
      ...(item.bullets || []).map((bullet) => `- ${bullet}`),
      "",
      "来源：",
      ...(item.sourceNotes || []).map((note) => `- ${note}`),
      ...partData.map((part) => `- 独立图片对象：${part.asset.filename} (${part.role})`),
    ].filter(Boolean).join("\n"));

    if (fullSlideVisual && primary) addFullSlideVisual(pptx, slide, item, primary, partData, index, deck.theme);
    else if (layout === "cover") addCover(pptx, slide, item, primary, partData, index);
    else if (layout === "section") addSection(pptx, slide, item, index);
    else addContent(pptx, slide, item, primary, partData, index, layout === "visual-left" ? "left" : "right");
  }

  addAppendix(pptx, deck, assets);
  await pptx.writeFile({ fileName: `${sanitizeFileName(deck.title)}.pptx` });
}

function addFullSlideVisual(
  pptx: any,
  slide: any,
  item: NotebookSlideSpec,
  imageData: string,
  parts: ResolvedPart[],
  index: number,
  theme?: NotebookDeckSpec["theme"],
) {
  const slideW = 13.333;
  const slideH = 7.5;
  slide.addImage({ data: imageData, x: 0, y: 0, w: slideW, h: slideH, sizing: { type: "cover", w: slideW, h: slideH } });
  parts.forEach((part) => {
    slide.addImage({
      data: part.data,
      x: part.x * slideW,
      y: part.y * slideH,
      w: Math.max(0.6, Math.min(part.w * slideW, slideW - part.x * slideW)),
      h: Math.max(0.5, Math.min(part.h * slideH, slideH - part.y * slideH)),
    });
  });

  if (item.visualMode === "full-slide-text") return;

  const safe = item.safeArea || defaultSafeArea(item.layout);
  const panelX = safe.x * slideW;
  const panelY = safe.y * slideH;
  const panelW = safe.w * slideW;
  const panelH = safe.h * slideH;
  const dark = theme === "dark-executive" || item.layout === "cover" || item.layout === "section";
  const textColor = dark ? colors.white : colors.ink;
  const mutedColor = dark ? "D6DDE1" : colors.muted;
  const panelColor = dark ? colors.ink : colors.paper;
  const pad = Math.min(0.28, panelW * 0.05);
  const innerX = panelX + pad;
  const innerW = panelW - pad * 2;

  slide.addShape(pptx.ShapeType.rect, {
    x: panelX, y: panelY, w: panelW, h: panelH,
    fill: { color: panelColor, transparency: dark ? 20 : 12 },
    line: { color: panelColor, transparency: 100 },
  });
  slide.addText(String(index + 1).padStart(2, "0"), {
    x: innerX, y: panelY + 0.2, w: 0.52, h: 0.22,
    fontSize: 10, bold: true, color: dark ? colors.lime : colors.blue, margin: 0,
  });
  slide.addText(item.title, {
    x: innerX, y: panelY + 0.55, w: innerW, h: Math.min(1.08, panelH * 0.22),
    fontFace: "Microsoft YaHei", fontSize: item.layout === "section" ? 29 : 24,
    bold: true, color: textColor, fit: "shrink", margin: 0,
  });
  let cursorY = panelY + Math.min(1.76, panelH * 0.34);
  if (item.subtitle) {
    slide.addText(item.subtitle, { x: innerX, y: cursorY, w: innerW, h: 0.34, fontSize: 10.5, color: mutedColor, fit: "shrink", margin: 0 });
    cursorY += 0.46;
  }
  if (item.claim) {
    slide.addText(item.claim, { x: innerX, y: cursorY, w: innerW, h: 0.52, fontSize: 14.5, bold: true, color: textColor, fit: "shrink", margin: 0 });
    cursorY += 0.68;
  }
  const bulletRoom = Math.max(0.45, panelY + panelH - cursorY - 0.55);
  const bulletStep = Math.min(0.44, bulletRoom / Math.max(1, Math.min(5, item.bullets?.length || 0)));
  (item.bullets || []).slice(0, 5).forEach((bullet, bulletIndex) => {
    slide.addText(bullet, {
      x: innerX, y: cursorY + bulletIndex * bulletStep, w: innerW, h: Math.max(0.24, bulletStep - 0.05),
      fontSize: 10.5, color: textColor, bullet: { type: "bullet" }, fit: "shrink", margin: 0.02,
    });
  });

  if (item.tableRows?.length) {
    const tableX = safe.x < 0.5 ? 7.15 : 0.68;
    addTable(slide, item.tableRows, tableX, 1.72, 5.5, 4.25);
  }
  slide.addText("LLWP PPTMAKER · Image 2 full-slide art + native editable text", {
    x: 0.5, y: 7.12, w: 5.6, h: 0.16, fontSize: 6.5, color: dark ? "C6CFD3" : colors.muted, margin: 0,
  });
}

function defaultSafeArea(layout: NotebookSlideSpec["layout"]) {
  if (layout === "visual-left") return { x: 0.53, y: 0.1, w: 0.41, h: 0.8 };
  if (layout === "section") return { x: 0.12, y: 0.2, w: 0.76, h: 0.56 };
  return { x: 0.06, y: 0.1, w: 0.41, h: 0.8 };
}

function addCover(
  pptx: any,
  slide: any,
  item: NotebookSlideSpec,
  imageData: string | null,
  parts: ResolvedPart[],
  index: number,
) {
  slide.background = { color: colors.ink };
  if (parts.length) {
    parts.forEach((part) => {
      const x = 6.75 + part.x * 6.58;
      const y = part.y * 7.5;
      slide.addImage({
        data: part.data,
        x,
        y,
        w: Math.max(0.7, Math.min(part.w * 6.58, 13.33 - x)),
        h: Math.max(0.65, Math.min(part.h * 7.5, 7.5 - y)),
      });
    });
  } else if (imageData) {
    slide.addImage({ data: imageData, x: 6.75, y: 0, w: 6.58, h: 7.5 });
  }
  if (parts.length || imageData) {
    slide.addShape(pptx.ShapeType.rect, {
      x: 5.25, y: 0, w: 3.2, h: 7.5,
      fill: { color: colors.ink, transparency: 20 }, line: { color: colors.ink, transparency: 100 },
    });
  }
  slide.addText(String(index + 1).padStart(2, "0"), { x: 0.72, y: 0.62, w: 0.6, h: 0.24, fontSize: 12, bold: true, color: colors.lime });
  slide.addText(item.title, {
    x: 0.76, y: 1.55, w: 6.1, h: 1.6, fontFace: "Microsoft YaHei", fontSize: 34,
    bold: true, color: colors.white, fit: "shrink", breakLine: false, margin: 0,
  });
  if (item.subtitle) slide.addText(item.subtitle, { x: 0.8, y: 3.35, w: 5.6, h: 0.5, fontSize: 13, color: "D6DDE1", fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.line, { x: 0.8, y: 4.08, w: 0.9, h: 0, line: { color: colors.blue, width: 2.2 } });
  addBullets(slide, item.bullets || [], 0.82, 4.42, 5.65, true);
  slide.addText("LLWP PPTMAKER · native editable deck", { x: 0.76, y: 7.06, w: 4.8, h: 0.18, fontSize: 7, color: "B9C4C9" });
}

function addSection(pptx: any, slide: any, item: NotebookSlideSpec, index: number) {
  slide.background = { color: colors.ink };
  slide.addShape(pptx.ShapeType.line, { x: 0.76, y: 1.05, w: 1.05, h: 0, line: { color: colors.lime, width: 3 } });
  slide.addText(String(index + 1).padStart(2, "0"), { x: 0.76, y: 1.3, w: 0.8, h: 0.3, fontSize: 15, bold: true, color: colors.blue });
  slide.addText(item.title, { x: 0.76, y: 2.25, w: 9.8, h: 1.05, fontSize: 31, bold: true, color: colors.white, fit: "shrink", margin: 0 });
  if (item.subtitle) slide.addText(item.subtitle, { x: 0.78, y: 3.48, w: 8.5, h: 0.42, fontSize: 13, color: "CBD4D8", fit: "shrink", margin: 0 });
}

function addContent(
  pptx: any,
  slide: any,
  item: NotebookSlideSpec,
  primary: string | null,
  parts: ResolvedPart[],
  index: number,
  imageSide: "left" | "right",
) {
  slide.background = { color: colors.paper };
  slide.addText(String(index + 1).padStart(2, "0"), { x: 0.68, y: 0.42, w: 0.52, h: 0.22, fontSize: 10, bold: true, color: colors.blue });
  slide.addText(item.title, { x: 0.68, y: 0.78, w: 8.4, h: 0.56, fontSize: 24, bold: true, color: colors.ink, fit: "shrink", margin: 0 });
  if (item.subtitle) slide.addText(item.subtitle, { x: 0.7, y: 1.42, w: 8.2, h: 0.3, fontSize: 10.5, color: colors.muted, fit: "shrink", margin: 0 });
  slide.addShape(pptx.ShapeType.line, { x: 0.68, y: 1.92, w: 11.95, h: 0, line: { color: colors.line, width: 0.8 } });

  const visualX = imageSide === "left" ? 0.72 : 7.45;
  const textX = imageSide === "left" ? 6.25 : 0.78;
  const visualW = 5.15;
  const visualY = 2.25;
  const visualH = 3.9;
  const textW = imageSide === "left" ? 6.35 : 5.85;

  if (parts.length) {
    slide.addShape(pptx.ShapeType.rect, { x: visualX, y: visualY, w: visualW, h: visualH, fill: { color: colors.surface }, line: { color: colors.line, width: 0.6 } });
    parts.forEach((part) => {
      const x = visualX + part.x * visualW;
      const y = visualY + part.y * visualH;
      const w = Math.max(0.6, part.w * visualW);
      const h = Math.max(0.55, part.h * visualH);
      slide.addImage({ data: part.data, x, y, w: Math.min(w, visualX + visualW - x), h: Math.min(h, visualY + visualH - y) });
    });
  } else if (primary) {
    slide.addImage({ data: primary, x: visualX, y: visualY, w: visualW, h: visualH });
  } else if (item.tableRows?.length) {
    addTable(slide, item.tableRows, visualX, visualY, visualW, visualH);
  } else {
    slide.addShape(pptx.ShapeType.rect, { x: visualX, y: visualY, w: visualW, h: visualH, fill: { color: colors.surface }, line: { color: colors.line } });
    slide.addText("VISUAL", { x: visualX, y: visualY + 1.75, w: visualW, h: 0.25, fontSize: 10, bold: true, color: colors.muted, align: "center" });
  }

  if (item.claim) slide.addText(item.claim, { x: textX, y: 2.25, w: textW, h: 0.62, fontSize: 15, bold: true, color: colors.ink, fit: "shrink", margin: 0 });
  addBullets(slide, item.bullets || [], textX, item.claim ? 3.05 : 2.38, textW, false);
  addCallouts(pptx, slide, item.callouts || [], textX, 5.25, textW);
  addSources(slide, item.sourceNotes || [], textX, 6.12, textW);
}

function addBullets(slide: any, bullets: string[], x: number, y: number, w: number, dark: boolean) {
  bullets.slice(0, 6).forEach((bullet, index) => {
    slide.addText(bullet, {
      x, y: y + index * 0.48, w, h: 0.32, fontSize: dark ? 11 : 11.2,
      color: dark ? "E8EEF0" : colors.ink2, bullet: { type: "bullet" }, fit: "shrink", margin: 0.02,
    });
  });
}

function addCallouts(pptx: any, slide: any, callouts: { label: string; value: string }[], x: number, y: number, w: number) {
  if (!callouts.length) return;
  const gap = 0.12;
  const width = Math.min(1.75, (w - gap * 2) / Math.min(3, callouts.length));
  callouts.slice(0, 3).forEach((item, index) => {
    const left = x + index * (width + gap);
    slide.addShape(pptx.ShapeType.rect, { x: left, y, w: width, h: 0.62, fill: { color: "EDF3FF" }, line: { color: "C7D7FA", width: 0.5 } });
    slide.addText(item.value, { x: left + 0.08, y: y + 0.08, w: width - 0.16, h: 0.24, fontSize: 12, bold: true, color: colors.blue, fit: "shrink", margin: 0 });
    slide.addText(item.label, { x: left + 0.08, y: y + 0.37, w: width - 0.16, h: 0.14, fontSize: 6.7, color: colors.muted, fit: "shrink", margin: 0 });
  });
}

function addSources(slide: any, notes: string[], x: number, y: number, w: number) {
  if (!notes.length) return;
  slide.addText("SOURCES", { x, y, w: 0.9, h: 0.16, fontSize: 6.8, bold: true, color: colors.blue, margin: 0 });
  slide.addText(notes.slice(0, 3).join("  ·  "), { x, y: y + 0.22, w, h: 0.25, fontSize: 7.2, color: colors.muted, fit: "shrink", margin: 0 });
}

function addTable(slide: any, rows: string[][], x: number, y: number, w: number, h: number) {
  const values = rows.slice(0, 7).map((row) => row.slice(0, 5).map(String));
  slide.addTable(values, {
    x, y, w, h, border: { type: "solid", color: colors.line, pt: 0.6 },
    color: colors.ink, fill: { color: colors.white }, fontFace: "Microsoft YaHei", fontSize: 7.5,
    margin: 0.04, valign: "mid", fit: "shrink", autoFit: true, rowH: h / Math.max(values.length, 1),
    bold: false,
  });
}

function addAppendix(pptx: any, deck: NotebookDeckSpec, assets: GeneratedAsset[]) {
  const slide = pptx.addSlide("CONTENT");
  slide.background = { color: colors.paper };
  slide.addText("附录：论证与素材索引", { x: 0.68, y: 0.72, w: 6.5, h: 0.45, fontSize: 25, bold: true, color: colors.ink, margin: 0 });
  slide.addText(deck.story.thesis, { x: 0.7, y: 1.42, w: 11.6, h: 0.48, fontSize: 12, bold: true, color: colors.blue, fit: "shrink", margin: 0 });
  deck.slides.slice(0, 10).forEach((item, index) => {
    slide.addText(`${index + 1}. ${item.title}`, { x: 0.72, y: 2.1 + index * 0.38, w: 5.7, h: 0.22, fontSize: 8.7, bold: true, color: colors.ink, fit: "shrink", margin: 0 });
    slide.addText((item.sourceNotes || []).join(" · "), { x: 6.65, y: 2.1 + index * 0.38, w: 5.55, h: 0.22, fontSize: 7.2, color: colors.muted, fit: "shrink", margin: 0 });
  });
  slide.addText(`素材对象：${assets.length} 个；独立裁图：${assets.filter((asset) => asset.kind === "crop").length} 个`, { x: 0.72, y: 6.35, w: 6, h: 0.24, fontSize: 8, color: colors.muted });
}

type ResolvedPart = VisualPart & { data: string; asset: GeneratedAsset };

async function getVisualParts(item: NotebookSlideSpec, assets: GeneratedAsset[], cache: Map<string, string>): Promise<ResolvedPart[]> {
  const values = await Promise.all((item.visualParts || []).map(async (part) => {
    const asset = assets.find((candidate) => candidate.index === part.imageIndex);
    if (!asset) return null;
    return { ...part, data: await getImageData(asset.url, cache), asset };
  }));
  return values.filter((value): value is ResolvedPart => Boolean(value));
}

async function getPrimaryImage(item: NotebookSlideSpec, assets: GeneratedAsset[], cache: Map<string, string>) {
  if (item.imageIndex == null) return null;
  const asset = assets.find((candidate) => candidate.index === item.imageIndex);
  return asset ? getImageData(asset.url, cache) : null;
}

async function getImageData(url: string, cache: Map<string, string>) {
  if (cache.has(url)) return cache.get(url)!;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load image asset: ${url}`);
  const data = await blobToDataUri(await response.blob());
  cache.set(url, data);
  return data;
}

function blobToDataUri(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image asset."));
    reader.readAsDataURL(blob);
  });
}

function sanitizeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 80) || "LLWP-PPTMAKER";
}
