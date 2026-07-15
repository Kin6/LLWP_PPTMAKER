type GeneratedAsset = {
  id: string;
  filename: string;
  url: string;
  prompt: string;
  revisedPrompt?: string;
  index: number;
};

type NotebookSlideSpec = {
  title: string;
  subtitle?: string;
  layout?: "cover" | "two-column" | "visual-left" | "visual-right" | "section" | "takeaway";
  bullets?: string[];
  speakerNotes?: string;
  sourceNotes?: string[];
  imageIndex?: number;
  tableRows?: string[][];
  callouts?: { label: string; value: string }[];
};

type NotebookDeckSpec = {
  title: string;
  theme?: "dark-executive" | "light-consulting" | "editorial-visual";
  slides: NotebookSlideSpec[];
};

const colors = {
  graphite: "10191D",
  graphite2: "1E2B31",
  cyan: "10AFC7",
  coral: "F6533D",
  lime: "55B947",
  muted: "5C6B73",
  line: "D9E1E6",
  surface: "F7FAFC",
  white: "FFFFFF",
};

export async function exportNotebookDeck(deck: NotebookDeckSpec, assets: GeneratedAsset[]) {
  const { default: pptxgen } = await import("pptxgenjs");
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "DeckForge";
  pptx.company = "DeckForge";
  pptx.subject = "DeckForge Local editable PPTX";
  pptx.title = deck.title;
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei",
  };

  const imageCache = new Map<string, string>();

  for (const [index, item] of deck.slides.entries()) {
    const layout = item.layout || (index === 0 ? "cover" : "two-column");
    const isDark = layout === "cover" || layout === "section" || deck.theme === "dark-executive";
    const slide = pptx.addSlide();
    slide.background = { color: isDark ? colors.graphite : colors.white };

    const asset = findAssetForSlide(item, assets);
    const imageData = asset ? await getImageData(asset.url, imageCache) : null;
    const notes = [
      item.speakerNotes || "",
      "",
      "Source notes:",
      ...(item.sourceNotes || []).map((note) => `- ${note}`),
      asset ? `- Image asset: ${asset.filename}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    slide.addNotes(notes);

    if (layout === "cover") {
      addCoverSlide(pptx, slide, item, imageData, index);
    } else if (layout === "section") {
      addSectionSlide(pptx, slide, item, index);
    } else if (layout === "visual-left") {
      addContentSlide(pptx, slide, item, imageData, index, "left");
    } else if (layout === "visual-right") {
      addContentSlide(pptx, slide, item, imageData, index, "right");
    } else {
      addContentSlide(pptx, slide, item, imageData, index, "right");
    }
  }

  addAppendix(pptx, deck, assets);
  await pptx.writeFile({ fileName: `${sanitizeFileName(deck.title)}.pptx` });
}

function addCoverSlide(
  pptx: any,
  slide: any,
  item: NotebookSlideSpec,
  imageData: string | null,
  index: number,
) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 13.33,
    h: 7.5,
    fill: { color: colors.graphite },
    line: { color: colors.graphite },
  });
  if (imageData) {
    slide.addImage({
      data: imageData,
      x: 7.25,
      y: 0.75,
      w: 5.3,
      h: 5.95,
      transparency: 8,
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 6.75,
      y: 0,
      w: 6.58,
      h: 7.5,
      fill: { color: colors.graphite, transparency: 42 },
      line: { color: colors.graphite, transparency: 100 },
    });
  }
  slide.addText(formatNumber(index), numberStyle(true));
  slide.addText(item.title, {
    x: 0.75,
    y: 1.65,
    w: 6.35,
    h: 1.45,
    fontFace: "Microsoft YaHei",
    fontSize: 34,
    bold: true,
    color: colors.white,
    fit: "shrink",
  });
  if (item.subtitle) {
    slide.addText(item.subtitle, {
      x: 0.78,
      y: 3.25,
      w: 5.9,
      h: 0.5,
      fontSize: 13.5,
      color: "DCE8EC",
      fit: "shrink",
    });
  }
  slide.addShape(pptx.ShapeType.line, {
    x: 0.78,
    y: 4.05,
    w: 0.86,
    h: 0,
    line: { color: colors.cyan, width: 2 },
  });
  addBullets(slide, item.bullets || [], 0.8, 4.48, 5.7, true);
  addFooter(slide, "DeckForge Local -> editable PPTX", true);
}

function addSectionSlide(pptx: any, slide: any, item: NotebookSlideSpec, index: number) {
  slide.addText(formatNumber(index), numberStyle(true));
  slide.addText(item.title, {
    x: 0.78,
    y: 2.35,
    w: 8.9,
    h: 0.9,
    fontFace: "Microsoft YaHei",
    fontSize: 31,
    bold: true,
    color: colors.white,
    fit: "shrink",
  });
  if (item.subtitle) {
    slide.addText(item.subtitle, {
      x: 0.8,
      y: 3.35,
      w: 8,
      h: 0.35,
      fontSize: 13,
      color: "C7D3D8",
      fit: "shrink",
    });
  }
  slide.addShape(pptx.ShapeType.line, {
    x: 0.82,
    y: 4.05,
    w: 1.1,
    h: 0,
    line: { color: colors.cyan, width: 2 },
  });
  addFooter(slide, "Section", true);
}

function addContentSlide(
  pptx: any,
  slide: any,
  item: NotebookSlideSpec,
  imageData: string | null,
  index: number,
  imageSide: "left" | "right",
) {
  slide.addText(formatNumber(index), numberStyle(false));
  slide.addText(item.title, {
    x: 0.68,
    y: 0.82,
    w: 7.1,
    h: 0.52,
    fontFace: "Microsoft YaHei",
    fontSize: 24,
    bold: true,
    color: colors.graphite,
    fit: "shrink",
  });
  if (item.subtitle) {
    slide.addText(item.subtitle, {
      x: 0.7,
      y: 1.42,
      w: 7,
      h: 0.28,
      fontSize: 10.6,
      color: colors.muted,
      fit: "shrink",
    });
  }
  slide.addShape(pptx.ShapeType.line, {
    x: 0.68,
    y: 1.92,
    w: 11.9,
    h: 0,
    line: { color: colors.line, width: 1 },
  });

  const imageX = imageSide === "left" ? 0.75 : 7.6;
  const textX = imageSide === "left" ? 6.45 : 0.82;
  const textW = imageSide === "left" ? 5.7 : 5.85;

  if (imageData) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: imageX,
      y: 2.35,
      w: 4.9,
      h: 3.25,
      rectRadius: 0.08,
      fill: { color: colors.surface },
      line: { color: colors.line },
    });
    slide.addImage({
      data: imageData,
      x: imageX + 0.18,
      y: 2.52,
      w: 4.54,
      h: 2.88,
    });
  } else if (item.tableRows?.length) {
    addTableBlock(slide, item.tableRows, imageX, 2.35, 4.9, 3.25);
  } else {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: imageX,
      y: 2.35,
      w: 4.9,
      h: 3.25,
      rectRadius: 0.08,
      fill: { color: colors.surface },
      line: { color: colors.line },
    });
    slide.addText("Visual asset", {
      x: imageX,
      y: 3.72,
      w: 4.9,
      h: 0.3,
      fontSize: 13,
      bold: true,
      align: "center",
      color: colors.muted,
    });
  }

  addBullets(slide, item.bullets || [], textX, 2.42, textW, false);
  addCallouts(slide, item.callouts || [], textX, 4.85, textW);
  addSourceNotes(slide, item.sourceNotes || [], textX, 5.75, textW);
  addFooter(slide, "Editable slide objects generated by DeckForge Local", false);
}

function addBullets(
  slide: any,
  bullets: string[],
  x: number,
  y: number,
  w: number,
  dark: boolean,
) {
  if (!bullets.length) return;
  bullets.slice(0, 6).forEach((bullet, index) => {
    slide.addText(bullet, {
      x,
      y: y + index * 0.48,
      w,
      h: 0.32,
      fontSize: dark ? 11.2 : 11.4,
      color: dark ? "E7F1F4" : colors.graphite,
      bullet: { type: "bullet" },
      fit: "shrink",
    });
  });
}

function addSourceNotes(slide: any, notes: string[], x: number, y: number, w: number) {
  if (!notes.length) return;
  slide.addText("Source notes", {
    x,
    y,
    w,
    h: 0.2,
    fontSize: 8,
    bold: true,
    color: colors.cyan,
  });
  slide.addText(notes.slice(0, 3).join(" | "), {
    x,
    y: y + 0.24,
    w,
    h: 0.28,
    fontSize: 7.4,
    color: colors.muted,
    fit: "shrink",
  });
}

function addTableBlock(slide: any, rows: string[][], x: number, y: number, w: number, h: number) {
  const trimmed = rows.slice(0, 6).map((row) => row.slice(0, 4).map((cell) => String(cell)));
  if (!trimmed.length) return;
  slide.addTable(trimmed, {
    x,
    y,
    w,
    h,
    border: { type: "solid", color: colors.line, pt: 0.6 },
    color: colors.graphite,
    fill: { color: colors.white },
    fontFace: "Microsoft YaHei",
    fontSize: 7.6,
    margin: 0.04,
    valign: "mid",
    fit: "shrink",
    autoFit: true,
    rowH: h / trimmed.length,
  });
}

function addCallouts(
  slide: any,
  callouts: { label: string; value: string }[],
  x: number,
  y: number,
  w: number,
) {
  if (!callouts.length) return;
  const itemW = Math.min(1.55, (w - 0.18) / Math.min(callouts.length, 3));
  callouts.slice(0, 3).forEach((callout, index) => {
    const itemX = x + index * (itemW + 0.12);
    slide.addShape("roundRect", {
      x: itemX,
      y,
      w: itemW,
      h: 0.52,
      fill: { color: "EEF8FA" },
      line: { color: colors.line },
      rectRadius: 0.05,
    });
    slide.addText(callout.value, {
      x: itemX + 0.08,
      y: y + 0.07,
      w: itemW - 0.16,
      h: 0.2,
      fontFace: "Microsoft YaHei",
      fontSize: 12,
      bold: true,
      color: colors.cyan,
      fit: "shrink",
    });
    slide.addText(callout.label, {
      x: itemX + 0.08,
      y: y + 0.3,
      w: itemW - 0.16,
      h: 0.14,
      fontFace: "Microsoft YaHei",
      fontSize: 6.6,
      color: colors.muted,
      fit: "shrink",
    });
  });
}

function addFooter(slide: any, text: string, dark: boolean) {
  slide.addText(text, {
    x: 0.72,
    y: 6.92,
    w: 5.4,
    h: 0.18,
    fontSize: 7.5,
    color: dark ? "C7D3D8" : colors.muted,
  });
}

function addAppendix(pptx: any, deck: NotebookDeckSpec, assets: GeneratedAsset[]) {
  const slide = pptx.addSlide();
  slide.background = { color: colors.white };
  slide.addText("Appendix: Sources and Assets", {
    x: 0.65,
    y: 0.65,
    w: 6.4,
    h: 0.42,
    fontFace: "Microsoft YaHei",
    fontSize: 25,
    bold: true,
    color: colors.graphite,
  });
  deck.slides.forEach((item, index) => {
    slide.addText(`${index + 1}. ${item.title}`, {
      x: 0.78,
      y: 1.42 + index * 0.38,
      w: 6.4,
      h: 0.22,
      fontSize: 9,
      bold: true,
      color: colors.graphite,
      fit: "shrink",
    });
    slide.addText((item.sourceNotes || []).join(" | "), {
      x: 7.1,
      y: 1.42 + index * 0.38,
      w: 5.1,
      h: 0.22,
      fontSize: 7.6,
      color: colors.muted,
      fit: "shrink",
    });
  });
  assets.slice(0, 6).forEach((asset, index) => {
    slide.addText(`Asset ${asset.index}: ${asset.filename}`, {
      x: 0.78,
      y: 5.6 + index * 0.24,
      w: 10.8,
      h: 0.18,
      fontSize: 7.2,
      color: colors.muted,
      fit: "shrink",
    });
  });
}

function numberStyle(dark: boolean) {
  return {
    x: 0.72,
    y: 0.62,
    w: 0.8,
    h: 0.25,
    fontSize: 13,
    bold: true,
    color: dark ? colors.cyan : colors.cyan,
  };
}

function formatNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

function findAssetForSlide(item: NotebookSlideSpec, assets: GeneratedAsset[]) {
  if (!assets.length || item.imageIndex == null) return null;
  const byIndex = assets.find((asset) => asset.index === item.imageIndex);
  return byIndex || null;
}

async function getImageData(url: string, cache: Map<string, string>) {
  if (cache.has(url)) return cache.get(url)!;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load image asset: ${url}`);
  const blob = await response.blob();
  const dataUri = await blobToDataUri(blob);
  cache.set(url, dataUri);
  return dataUri;
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
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "DeckForge-Local-export"
  );
}
