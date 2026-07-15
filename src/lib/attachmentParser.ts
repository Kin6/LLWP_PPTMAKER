import JSZip from "jszip";

export type AttachmentKind = "image" | "table" | "pptx" | "text";

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
};

const imageExtensions = new Set(["png", "jpg", "jpeg", "webp"]);

export async function parseAttachment(file: File): Promise<ParsedAttachment> {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const base = {
    id: makeId("attachment"),
    name: file.name,
    size: file.size,
    imageFiles: [] as File[],
    assetIds: [] as string[],
  };

  if (file.type.startsWith("image/") || imageExtensions.has(extension)) {
    return { ...base, kind: "image", detail: "内容参考图", imageFiles: [file] };
  }

  if (extension === "csv" || extension === "tsv") {
    const text = (await file.text()).replace(/^\uFEFF/, "").slice(0, 120_000);
    return { ...base, kind: "table", detail: `${extension.toUpperCase()} 表格`, tableText: text };
  }

  if (extension === "xlsx") {
    const rows = await parseXlsx(file);
    return {
      ...base,
      kind: "table",
      detail: `Excel · ${Math.max(0, rows.length - 1)} 行`,
      tableText: rows.map((row) => row.map(csvCell).join(",")).join("\n"),
    };
  }

  if (extension === "pptx") {
    const result = await parsePptx(file);
    return {
      ...base,
      kind: "pptx",
      detail: `示例 PPTX · ${result.slideCount} 页 · ${result.imageFiles.length} 张图`,
      extractedText: result.text,
      imageFiles: result.imageFiles,
    };
  }

  if (extension === "txt" || extension === "md") {
    const text = (await file.text()).slice(0, 120_000);
    return { ...base, kind: "text", detail: "文字材料", extractedText: text };
  }

  if (extension === "ppt" || extension === "xls") {
    throw new Error(`暂不解析旧版 .${extension} 二进制文件，请在 Office 中另存为 .${extension}x 后上传。`);
  }

  throw new Error(`不支持 ${file.name}。请上传图片、CSV、XLSX、TXT、MD 或 PPTX。`);
}

async function parsePptx(file: File) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalSlideSort);
  if (!slideEntries.length) throw new Error("PPTX 中没有可读取的幻灯片。");

  const slideTexts: string[] = [];
  for (const [index, name] of slideEntries.slice(0, 40).entries()) {
    const xml = await zip.file(name)!.async("text");
    const values = xmlTextValues(xml, "t").filter(Boolean);
    if (values.length) slideTexts.push(`第 ${index + 1} 页：${values.join(" / ")}`);
  }

  const mediaNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/media\//i.test(name) && imageExtensions.has(name.split(".").pop()?.toLowerCase() || ""))
    .slice(0, 4);
  const imageFiles: File[] = [];
  for (const name of mediaNames) {
    const extension = name.split(".").pop()?.toLowerCase() || "png";
    const mime = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    const bytes = await zip.file(name)!.async("uint8array");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    imageFiles.push(new File([buffer], name.split("/").pop() || `ppt-image.${extension}`, { type: mime }));
  }

  return {
    slideCount: slideEntries.length,
    text: `【示例 PPTX：${file.name}】\n${slideTexts.join("\n")}`,
    imageFiles,
  };
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

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
