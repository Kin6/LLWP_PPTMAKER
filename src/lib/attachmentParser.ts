import JSZip from "jszip";
import type { SourceLocation } from "../types";

export type AttachmentKind = "image" | "table" | "pptx" | "text" | "docx" | "pdf";

export type ExtractedBlock = {
  id: string;
  type: "heading" | "paragraph" | "table" | "image" | "notice";
  text?: string;
  level?: number;
  rows?: string[][];
  imageFileIndex?: number;
  assetId?: string;
  source: SourceLocation;
};

type OcrResult = { text: string; confidence?: number };

export type AttachmentParserOptions = {
  ocrPage?: (page: PdfPageLike, pageNumber: number) => Promise<OcrResult>;
  pdfDocumentLoader?: (data: Uint8Array) => Promise<PdfDocumentLike>;
  onProgress?: (message: string) => void;
};

type PdfTextItem = { str?: string; transform?: number[]; width?: number; height?: number };
type PdfPageLike = {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
  getViewport?: (options: { scale: number }) => { width: number; height: number };
  render?: (options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<unknown> };
  getOperatorList?: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs?: { get: (name: string, callback?: (value: unknown) => void) => unknown };
};
type PdfDocumentLike = { numPages: number; getPage: (pageNumber: number) => Promise<PdfPageLike>; destroy?: () => Promise<void> };

export type ParsedAttachment = {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  detail: string;
  extractedText?: string;
  tableText?: string;
  imageFiles: File[];
  assetIds: string[];
  blocks: ExtractedBlock[];
};

const imageExtensions = new Set(["png", "jpg", "jpeg", "webp"]);

export async function parseAttachment(file: File, options: AttachmentParserOptions = {}): Promise<ParsedAttachment> {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const base = {
    id: makeId("attachment"),
    name: file.name,
    size: file.size,
    imageFiles: [] as File[],
    assetIds: [] as string[],
    blocks: [] as ExtractedBlock[],
  };

  if (file.type.startsWith("image/") || imageExtensions.has(extension)) {
    const source = makeSource(base.id, file.name, "image", "native", { imageIndex: 1 });
    return { ...base, kind: "image", detail: "内容参考图", imageFiles: [file], blocks: [makeBlock("image", source, { imageFileIndex: 0 })] };
  }

  if (extension === "csv" || extension === "tsv") {
    const text = (await file.text()).replace(/^\uFEFF/, "").slice(0, 120_000);
    const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 120).map((line) => line.split(extension === "tsv" ? "\t" : ",").slice(0, 24));
    const source = makeSource(base.id, file.name, "text", "native", { tableIndex: 1 });
    return { ...base, kind: "table", detail: `${extension.toUpperCase()} 表格`, tableText: text, blocks: [makeBlock("table", source, { rows })] };
  }

  if (extension === "xlsx") {
    const rows = await parseXlsx(file);
    const source = makeSource(base.id, file.name, "xlsx", "native", { tableIndex: 1 });
    return {
      ...base,
      kind: "table",
      detail: `Excel · ${Math.max(0, rows.length - 1)} 行`,
      tableText: rows.map((row) => row.map(csvCell).join(",")).join("\n"),
      blocks: [makeBlock("table", source, { rows })],
    };
  }

  if (extension === "pptx") {
    const result = await parsePptx(file, base.id);
    return {
      ...base,
      kind: "pptx",
      detail: `示例 PPTX · ${result.slideCount} 页 · ${result.imageFiles.length} 张图`,
      extractedText: result.text,
      imageFiles: result.imageFiles,
      blocks: result.blocks,
    };
  }

  if (extension === "docx") {
    const result = await parseDocx(file, base.id);
    return {
      ...base,
      kind: "docx",
      detail: `Word · ${result.headingCount} 个标题 · ${result.tableCount} 个表格 · ${result.imageFiles.length} 张图`,
      extractedText: blocksToText(result.blocks),
      tableText: blocksToTableText(result.blocks),
      imageFiles: result.imageFiles,
      blocks: result.blocks,
    };
  }

  if (extension === "pdf") {
    const result = await parsePdf(file, base.id, options);
    return {
      ...base,
      kind: "pdf",
      detail: `PDF · ${result.processedPageCount === result.pageCount ? `${result.pageCount} 页` : `已解析 ${result.processedPageCount}/${result.pageCount} 页`} · ${result.ocrPageCount ? `${result.ocrPageCount} 页 OCR` : "原生文本"} · ${result.imageFiles.length} 张图`,
      extractedText: blocksToText(result.blocks),
      tableText: blocksToTableText(result.blocks),
      imageFiles: result.imageFiles,
      blocks: result.blocks,
    };
  }

  if (extension === "txt" || extension === "md") {
    const text = (await file.text()).slice(0, 120_000);
    const source = makeSource(base.id, file.name, "text", "native", { paragraphIndex: 1 });
    return { ...base, kind: "text", detail: "文字材料", extractedText: text, blocks: [makeBlock("paragraph", source, { text })] };
  }

  if (extension === "ppt" || extension === "xls") {
    throw new Error(`暂不解析旧版 .${extension} 二进制文件，请在 Office 中另存为 .${extension}x 后上传。`);
  }

  throw new Error(`不支持 ${file.name}。请上传图片、CSV、XLSX、DOCX、PDF、TXT、MD 或 PPTX。`);
}

async function parsePptx(file: File, attachmentId: string) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalSlideSort);
  if (!slideEntries.length) throw new Error("PPTX 中没有可读取的幻灯片。");

  const slideTexts: string[] = [];
  const blocks: ExtractedBlock[] = [];
  for (const [index, name] of slideEntries.slice(0, 40).entries()) {
    const xml = await zip.file(name)!.async("text");
    const values = xmlTextValues(xml, "t").filter(Boolean);
    if (values.length) {
      const text = values.join(" / ");
      slideTexts.push(`第 ${index + 1} 页：${text}`);
      blocks.push(makeBlock("paragraph", makeSource(attachmentId, file.name, "pptx", "native", { page: index + 1, paragraphIndex: 1 }), { text }));
    }
  }

  const mediaNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/media\//i.test(name) && imageExtensions.has(name.split(".").pop()?.toLowerCase() || ""))
    .slice(0, 4);
  const imageFiles: File[] = [];
  for (const [imageIndex, name] of mediaNames.entries()) {
    const extension = name.split(".").pop()?.toLowerCase() || "png";
    const mime = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    const bytes = await zip.file(name)!.async("uint8array");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    imageFiles.push(new File([buffer], name.split("/").pop() || `ppt-image.${extension}`, { type: mime }));
    blocks.push(makeBlock("image", makeSource(attachmentId, file.name, "pptx", "native", { imageIndex: imageIndex + 1 }), { imageFileIndex: imageIndex }));
  }

  return {
    slideCount: slideEntries.length,
    text: `【示例 PPTX：${file.name}】\n${slideTexts.join("\n")}`,
    imageFiles,
    blocks,
  };
}

async function parseDocx(file: File, attachmentId: string) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) throw new Error("DOCX 中没有可读取的正文。");
  const stylesXml = await zip.file("word/styles.xml")?.async("text");
  const relationshipsXml = await zip.file("word/_rels/document.xml.rels")?.async("text");
  const headingStyles = parseHeadingStyles(stylesXml || "");
  const relationships = parseOfficeRelationships(relationshipsXml || "", "word/");
  const doc = parseXml(documentXml);
  const body = doc.getElementsByTagNameNS("*", "body")[0];
  if (!body) throw new Error("DOCX 正文结构无效。");

  const blocks: ExtractedBlock[] = [];
  const imageFiles: File[] = [];
  const imageIndexes = new Map<string, number>();
  const sectionPath: string[] = [];
  let paragraphIndex = 0;
  let tableIndex = 0;
  let headingCount = 0;

  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    if (element.localName === "p") {
      const text = nodeText(element);
      const level = paragraphHeadingLevel(element, headingStyles);
      paragraphIndex += 1;
      if (text) {
        if (level) {
          sectionPath.splice(level - 1);
          sectionPath[level - 1] = text;
          sectionPath.splice(level);
          headingCount += 1;
        }
        const source = makeSource(attachmentId, file.name, "docx", "native", {
          sectionPath: [...sectionPath],
          paragraphIndex,
        });
        blocks.push(makeBlock(level ? "heading" : "paragraph", source, { text, level }));
      }
      await appendDocxImages(element, zip, relationships, imageIndexes, imageFiles, blocks, attachmentId, file.name, sectionPath);
    } else if (element.localName === "tbl") {
      tableIndex += 1;
      const rows = Array.from(element.getElementsByTagNameNS("*", "tr")).slice(0, 120).map((row) =>
        Array.from(row.getElementsByTagNameNS("*", "tc")).slice(0, 24).map((cell) => nodeText(cell).replace(/\s+/g, " ").trim()),
      ).filter((row) => row.some(Boolean));
      if (rows.length) {
        const source = makeSource(attachmentId, file.name, "docx", "native", { sectionPath: [...sectionPath], tableIndex });
        blocks.push(makeBlock("table", source, { rows }));
      }
      await appendDocxImages(element, zip, relationships, imageIndexes, imageFiles, blocks, attachmentId, file.name, sectionPath);
    }
  }

  return { blocks, imageFiles, headingCount, tableCount: tableIndex };
}

function parseHeadingStyles(xml: string) {
  const levels = new Map<string, number>();
  if (!xml) return levels;
  const doc = parseXml(xml);
  for (const style of Array.from(doc.getElementsByTagNameNS("*", "style"))) {
    const id = attributeValue(style, "styleId");
    if (!id) continue;
    const nameNode = style.getElementsByTagNameNS("*", "name")[0];
    const name = attributeValue(nameNode, "val");
    const outlineNode = style.getElementsByTagNameNS("*", "outlineLvl")[0];
    const outlineValue = attributeValue(outlineNode, "val");
    const outline = outlineValue === "" ? Number.NaN : Number(outlineValue);
    const named = name.match(/(?:heading|标题)\s*([1-9])/i)?.[1] || id.match(/(?:heading|标题)([1-9])/i)?.[1];
    const level = named ? Number(named) : Number.isFinite(outline) ? outline + 1 : 0;
    if (level >= 1 && level <= 9) levels.set(id, level);
  }
  return levels;
}

function paragraphHeadingLevel(paragraph: Element, styles: Map<string, number>) {
  const styleNode = paragraph.getElementsByTagNameNS("*", "pStyle")[0];
  const styleId = attributeValue(styleNode, "val");
  if (styles.has(styleId)) return styles.get(styleId)!;
  const outlineNode = paragraph.getElementsByTagNameNS("*", "outlineLvl")[0];
  const outlineValue = attributeValue(outlineNode, "val");
  const outline = outlineValue === "" ? Number.NaN : Number(outlineValue);
  return Number.isFinite(outline) && outline >= 0 && outline <= 8 ? outline + 1 : 0;
}

function parseOfficeRelationships(xml: string, prefix: string) {
  const relationships = new Map<string, string>();
  if (!xml) return relationships;
  const doc = parseXml(xml);
  for (const relationship of Array.from(doc.getElementsByTagNameNS("*", "Relationship"))) {
    const id = relationship.getAttribute("Id") || "";
    const target = relationship.getAttribute("Target") || "";
    if (!id || !target || relationship.getAttribute("TargetMode") === "External") continue;
    const normalized = normalizeOfficePath(`${prefix}${target}`);
    relationships.set(id, normalized);
  }
  return relationships;
}

function normalizeOfficePath(value: string) {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

async function appendDocxImages(
  element: Element,
  zip: JSZip,
  relationships: Map<string, string>,
  indexes: Map<string, number>,
  imageFiles: File[],
  blocks: ExtractedBlock[],
  attachmentId: string,
  filename: string,
  sectionPath: string[],
) {
  const seenHere = new Set<string>();
  for (const blip of Array.from(element.getElementsByTagNameNS("*", "blip"))) {
    const relationshipId = blip.getAttribute("r:embed") || blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") || "";
    const mediaPath = relationships.get(relationshipId);
    if (!mediaPath || seenHere.has(relationshipId)) continue;
    seenHere.add(relationshipId);
    let imageFileIndex = indexes.get(mediaPath);
    if (imageFileIndex === undefined) {
      const entry = zip.file(mediaPath);
      if (!entry || imageFiles.length >= 20) continue;
      const extension = mediaPath.split(".").pop()?.toLowerCase() || "png";
      if (!imageExtensions.has(extension)) continue;
      const bytes = await entry.async("uint8array");
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      imageFileIndex = imageFiles.length;
      imageFiles.push(new File([buffer], mediaPath.split("/").pop() || `docx-image-${imageFileIndex + 1}.${extension}`, { type: imageMime(extension) }));
      indexes.set(mediaPath, imageFileIndex);
    }
    const source = makeSource(attachmentId, filename, "docx", "native", { sectionPath: [...sectionPath], imageIndex: imageFileIndex + 1 });
    blocks.push(makeBlock("image", source, { imageFileIndex }));
  }
}

async function parsePdf(file: File, attachmentId: string, options: AttachmentParserOptions) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = options.pdfDocumentLoader ? await options.pdfDocumentLoader(data) : await loadPdfDocument(data);
  const pageCount = Math.min(pdf.numPages, 80);
  const blocks: ExtractedBlock[] = [];
  const imageFiles: File[] = [];
  let ocrPageCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      options.onProgress?.(`正在解析 ${file.name} 第 ${pageNumber}/${pageCount} 页…`);
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const nativeBlocks = pdfTextBlocks(textContent.items, attachmentId, file.name, pageNumber);
      const nativeTextLength = nativeBlocks.reduce((sum, block) => sum + (block.text?.length || 0) + (block.rows?.flat().join("").length || 0), 0);
      if (nativeTextLength >= 20) {
        blocks.push(...nativeBlocks);
      } else {
        if (nativeBlocks.length) blocks.push(...nativeBlocks);
        ocrPageCount += 1;
        options.onProgress?.(`第 ${pageNumber} 页没有足够的原生文字，正在 OCR…`);
        try {
          const result = options.ocrPage ? await options.ocrPage(page, pageNumber) : await runBrowserOcr(page);
          const text = result.text.replace(/\s+/g, " ").trim();
          const confidence = Number.isFinite(result.confidence) ? Math.max(0, Math.min(100, Number(result.confidence))) : undefined;
          const lowConfidence = confidence !== undefined && confidence < 70;
          if (text) {
            const source = makeSource(attachmentId, file.name, "pdf", "ocr", { page: pageNumber, paragraphIndex: 1, confidence, lowConfidence });
            blocks.push(makeBlock("paragraph", source, { text: lowConfidence ? `[低置信度 OCR] ${text}` : text }));
          } else {
            blocks.push(pdfNotice(attachmentId, file.name, pageNumber, "该页 OCR 未识别出文字。", confidence));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "OCR 不可用";
          blocks.push(pdfNotice(attachmentId, file.name, pageNumber, `扫描页 OCR 失败：${message}`));
        }
      }
      const extractedImages = await extractPdfImages(page, file.name, imageFiles.length);
      for (const imageFile of extractedImages.slice(0, Math.max(0, 20 - imageFiles.length))) {
        const imageFileIndex = imageFiles.length;
        imageFiles.push(imageFile);
        const source = makeSource(attachmentId, file.name, "pdf", "native", { page: pageNumber, imageIndex: imageFileIndex + 1 });
        blocks.push(makeBlock("image", source, { imageFileIndex }));
      }
    }
    if (pageCount < pdf.numPages) {
      blocks.push(pdfNotice(attachmentId, file.name, pageCount + 1, `文件共 ${pdf.numPages} 页；为控制浏览器内存，本次仅解析前 ${pageCount} 页。`));
    }
  } finally {
    await pdf.destroy?.();
  }
  return { pageCount: pdf.numPages, processedPageCount: pageCount, ocrPageCount, blocks, imageFiles };
}

async function loadPdfDocument(data: Uint8Array): Promise<PdfDocumentLike> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false }).promise as unknown as PdfDocumentLike;
}

function pdfTextBlocks(items: PdfTextItem[], attachmentId: string, filename: string, page: number) {
  const positioned = items.map((item) => ({
    text: String(item.str || "").trim(),
    x: Number(item.transform?.[4] || 0),
    y: Number(item.transform?.[5] || 0),
    size: Math.abs(Number(item.transform?.[0] || item.height || 10)),
    width: Math.abs(Number(item.width || 0)),
  })).filter((item) => item.text);
  const lines: Array<typeof positioned> = [];
  for (const item of positioned.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((candidate) => Math.abs((candidate[0]?.y || 0) - item.y) <= Math.max(2, item.size * 0.35));
    if (line) line.push(item);
    else lines.push([item]);
  }
  lines.forEach((line) => line.sort((a, b) => a.x - b.x));
  const sizes = positioned.map((item) => item.size).sort((a, b) => a - b);
  const medianSize = sizes[Math.floor(sizes.length / 2)] || 10;
  const tableRows = lines.map(lineToCells);
  const tableLineIndexes = new Set<number>();
  const blocks: ExtractedBlock[] = [];
  let tableIndex = 0;

  for (let start = 0; start < tableRows.length;) {
    let end = start;
    while (end < tableRows.length && tableRows[end].length >= 2) end += 1;
    if (end - start >= 2 && alignedTableRows(lines.slice(start, end))) {
      tableIndex += 1;
      const rows = tableRows.slice(start, end);
      const source = makeSource(attachmentId, filename, "pdf", "native", { page, tableIndex });
      blocks.push(makeBlock("table", source, { rows }));
      for (let index = start; index < end; index += 1) tableLineIndexes.add(index);
    }
    start = Math.max(end, start + 1);
  }

  let paragraphIndex = 0;
  lines.forEach((line, index) => {
    if (tableLineIndexes.has(index)) return;
    const text = joinPdfLine(line);
    if (!text) return;
    paragraphIndex += 1;
    const maxSize = Math.max(...line.map((item) => item.size));
    const isHeading = maxSize >= medianSize * 1.35 && text.length <= 120;
    const source = makeSource(attachmentId, filename, "pdf", "native", { page, paragraphIndex });
    blocks.push(makeBlock(isHeading ? "heading" : "paragraph", source, { text, level: isHeading ? 1 : undefined }));
  });
  return blocks.sort((left, right) => (left.source.paragraphIndex || left.source.tableIndex || 0) - (right.source.paragraphIndex || right.source.tableIndex || 0));
}

function lineToCells(line: Array<{ text: string; x: number; size: number; width: number }>) {
  if (line.length < 2) return [joinPdfLine(line)];
  const cells: string[] = [];
  let current = line[0].text;
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1];
    const gap = line[index].x - (previous.x + previous.width);
    if (gap > Math.max(12, previous.size * 1.4)) {
      cells.push(current);
      current = line[index].text;
    } else {
      current += needsPdfSpace(current, line[index].text) ? ` ${line[index].text}` : line[index].text;
    }
  }
  cells.push(current);
  return cells;
}

function alignedTableRows(lines: Array<Array<{ x: number; width: number; size: number; text: string }>>) {
  const starts = lines.map((line) => {
    const cells = lineToCellsWithStarts(line);
    return cells.map((cell) => cell.x);
  });
  const expected = starts[0];
  if (expected.length < 2) return false;
  return starts.slice(1).every((row) => row.length === expected.length && row.every((x, index) => Math.abs(x - expected[index]) <= 12));
}

function lineToCellsWithStarts(line: Array<{ text: string; x: number; size: number; width: number }>) {
  const values: Array<{ x: number }> = line.length ? [{ x: line[0].x }] : [];
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1];
    if (line[index].x - (previous.x + previous.width) > Math.max(12, previous.size * 1.4)) values.push({ x: line[index].x });
  }
  return values;
}

function joinPdfLine(line: Array<{ text: string }>) {
  return line.reduce((value, item) => value + (needsPdfSpace(value, item.text) ? " " : "") + item.text, "").trim();
}

function needsPdfSpace(left: string, right: string) {
  return /[A-Za-z0-9)]$/.test(left) && /^[A-Za-z0-9(]/.test(right);
}

async function runBrowserOcr(page: PdfPageLike): Promise<OcrResult> {
  if (typeof document === "undefined" || !page.getViewport || !page.render) throw new Error("当前环境不支持扫描页渲染");
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 OCR 画布");
  await page.render({ canvasContext: context, viewport }).promise;
  const tesseract = await import("tesseract.js");
  const result = await tesseract.recognize(canvas, "chi_sim+eng");
  return { text: result.data.text || "", confidence: result.data.confidence };
}

async function extractPdfImages(page: PdfPageLike, filename: string, startIndex: number) {
  if (!page.getOperatorList || !page.objs || typeof document === "undefined") return [];
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const operators = await page.getOperatorList();
    const candidates: unknown[] = [];
    for (let index = 0; index < operators.fnArray.length; index += 1) {
      const fn = operators.fnArray[index];
      const args = operators.argsArray[index] || [];
      if (fn === pdfjs.OPS.paintInlineImageXObject && args[0]) candidates.push(args[0]);
      if (fn === pdfjs.OPS.paintImageXObject && typeof args[0] === "string") {
        const value = await getPdfObject(page.objs, args[0]);
        if (value) candidates.push(value);
      }
    }
    const files: File[] = [];
    for (const candidate of candidates.slice(0, 8)) {
      const blob = await pdfImageToPng(candidate);
      if (blob) files.push(new File([blob], `${filename.replace(/\.pdf$/i, "")}-image-${startIndex + files.length + 1}.png`, { type: "image/png" }));
    }
    return files;
  } catch {
    return [];
  }
}

function getPdfObject(objects: NonNullable<PdfPageLike["objs"]>, name: string) {
  return new Promise<unknown>((resolve) => {
    let settled = false;
    const finish = (value: unknown) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const immediate = objects.get(name, finish);
      if (immediate) finish(immediate);
    } catch {
      finish(undefined);
    }
    window.setTimeout(() => finish(undefined), 1500);
  });
}

async function pdfImageToPng(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const image = value as { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number; bitmap?: CanvasImageSource };
  const width = Number(image.width || 0);
  const height = Number(image.height || 0);
  if (!width || !height || width * height > 24_000_000) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  if (image.bitmap) context.drawImage(image.bitmap, 0, 0, width, height);
  else if (image.data) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const channels = image.data.length / (width * height);
    if (![1, 3, 4].includes(channels)) return null;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const source = pixel * channels;
      const target = pixel * 4;
      if (channels >= 3) {
        rgba[target] = image.data[source]; rgba[target + 1] = image.data[source + 1]; rgba[target + 2] = image.data[source + 2];
      } else {
        rgba[target] = rgba[target + 1] = rgba[target + 2] = image.data[source];
      }
      rgba[target + 3] = channels >= 4 ? image.data[source + 3] : 255;
    }
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else return null;
  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

function pdfNotice(attachmentId: string, filename: string, page: number, text: string, confidence?: number) {
  const source = makeSource(attachmentId, filename, "pdf", "ocr", { page, confidence, lowConfidence: true });
  return makeBlock("notice", source, { text: `[低置信度内容] ${text}` });
}

async function parseXlsx(file: File) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sheetName = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(naturalSlideSort)[0];
  if (!sheetName) throw new Error("Excel 文件中没有可读取的工作表。");

  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("text");
  const sharedStrings = sharedXml ? xmlGroupedTextValues(sharedXml, "si") : [];
  const sheetXml = await zip.file(sheetName)!.async("text");
  const doc = parseXml(sheetXml);
  const rows: string[][] = [];
  const rowNodes = Array.from(doc.getElementsByTagNameNS("*", "row")).slice(0, 120);

  rowNodes.forEach((rowNode) => {
    const values: string[] = [];
    Array.from(rowNode.getElementsByTagNameNS("*", "c")).slice(0, 24).forEach((cell) => {
      const reference = cell.getAttribute("r") || "A1";
      const column = columnIndex(reference.replace(/\d+/g, ""));
      const type = cell.getAttribute("t");
      const raw = cell.getElementsByTagNameNS("*", "v")[0]?.textContent || "";
      const inline = Array.from(cell.getElementsByTagNameNS("*", "t")).map((node) => node.textContent || "").join("");
      const value = type === "s" ? sharedStrings[Number(raw)] || "" : type === "inlineStr" ? inline : raw;
      values[column] = value;
    });
    if (values.some((value) => String(value || "").trim())) rows.push(values.map((value) => String(value || "")));
  });
  return rows;
}

function xmlTextValues(xml: string, localName: string) {
  const doc = parseXml(xml);
  return Array.from(doc.getElementsByTagNameNS("*", localName)).map((node) => (node.textContent || "").trim());
}

function xmlGroupedTextValues(xml: string, groupName: string) {
  const doc = parseXml(xml);
  return Array.from(doc.getElementsByTagNameNS("*", groupName)).map((group) =>
    Array.from(group.getElementsByTagNameNS("*", "t")).map((node) => node.textContent || "").join(""),
  );
}

function parseXml(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Office 文件 XML 解析失败。");
  return doc;
}

function naturalSlideSort(left: string, right: string) {
  const leftNumber = Number(left.match(/(\d+)\.xml$/)?.[1] || 0);
  const rightNumber = Number(right.match(/(\d+)\.xml$/)?.[1] || 0);
  return leftNumber - rightNumber;
}

function columnIndex(letters: string) {
  return letters.toUpperCase().split("").reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function nodeText(element: Element) {
  return Array.from(element.getElementsByTagNameNS("*", "t")).map((node) => node.textContent || "").join("").trim();
}

function attributeValue(element: Element | undefined, localName: string) {
  if (!element) return "";
  return element.getAttribute(`w:${localName}`) || element.getAttribute(localName) || element.getAttributeNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", localName) || "";
}

function imageMime(extension: string) {
  return extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
}

function makeSource(
  attachmentId: string,
  filename: string,
  kind: SourceLocation["kind"],
  extraction: SourceLocation["extraction"],
  detail: Partial<Omit<SourceLocation, "blockId" | "attachmentId" | "filename" | "kind" | "extraction">> = {},
): SourceLocation {
  return { blockId: makeId("source"), attachmentId, filename, kind, extraction, ...detail };
}

function makeBlock(type: ExtractedBlock["type"], source: SourceLocation, detail: Omit<Partial<ExtractedBlock>, "id" | "type" | "source"> = {}): ExtractedBlock {
  return { id: source.blockId, type, source, ...detail };
}

function sourceLabel(source: SourceLocation) {
  const details = [
    source.page ? `第 ${source.page} 页` : "",
    source.sectionPath?.length ? `章节：${source.sectionPath.join(" > ")}` : "",
    source.tableIndex ? `表格 ${source.tableIndex}` : "",
    source.imageIndex ? `图片 ${source.imageIndex}` : "",
    source.extraction === "ocr" ? `OCR${source.confidence !== undefined ? ` ${Math.round(source.confidence)}%` : ""}${source.lowConfidence ? "，低置信度" : ""}` : "",
  ].filter(Boolean);
  return `[来源：${source.filename}${details.length ? `，${details.join("，")}` : ""}]`;
}

function blocksToText(blocks: ExtractedBlock[]) {
  return blocks.filter((block) => block.type !== "table" && block.type !== "image").map((block) => {
    const prefix = block.type === "heading" ? `${"#".repeat(Math.max(1, Math.min(6, block.level || 1)))} ` : "";
    return `${sourceLabel(block.source)}\n${prefix}${block.text || ""}`.trim();
  }).join("\n\n").slice(0, 160_000);
}

function blocksToTableText(blocks: ExtractedBlock[]) {
  return blocks.filter((block) => block.type === "table" && block.rows?.length).map((block) =>
    `${sourceLabel(block.source)}\n${block.rows!.map((row) => row.map(csvCell).join(",")).join("\n")}`,
  ).join("\n\n").slice(0, 120_000);
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
