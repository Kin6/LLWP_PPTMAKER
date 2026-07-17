import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

globalThis.DOMParser = DOMParser;

const { parseAttachment } = await import("../src/lib/attachmentParser.ts");

const csv = await parseAttachment(new File(["quarter,revenue\nQ1,120\nQ2,180"], "growth.csv", { type: "text/csv" }));
assert.equal(csv.kind, "table");
assert.match(csv.tableText, /Q2,180/);

const workbook = new JSZip();
workbook.file(
  "xl/sharedStrings.xml",
  '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>quarter</t></si><si><t>revenue</t></si><si><t>Q1</t></si></sst>',
);
workbook.file(
  "xl/worksheets/sheet1.xml",
  '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>120</v></c></row></sheetData></worksheet>',
);
const workbookBytes = await workbook.generateAsync({ type: "uint8array" });
const xlsx = await parseAttachment(new File([workbookBytes], "growth.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
assert.equal(xlsx.kind, "table");
assert.equal(xlsx.tableText, "quarter,revenue\nQ1,120");

const presentation = new JSZip();
presentation.file(
  "ppt/slides/slide1.xml",
  '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Reference title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
);
presentation.file("ppt/media/image1.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcX8AAAAASUVORK5CYII=", "base64"));
const presentationBytes = await presentation.generateAsync({ type: "uint8array" });
const pptx = await parseAttachment(new File([presentationBytes], "reference.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
assert.equal(pptx.kind, "pptx");
assert.match(pptx.extractedText, /Reference title/);
assert.equal(pptx.imageFiles.length, 1);

const document = new JSZip();
document.file(
  "word/document.xml",
  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>市场分析</w:t></w:r></w:p>
    <w:p><w:r><w:t>市场规模正在扩大。</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>增长驱动</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>季度</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>收入</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Q1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
  </w:body></w:document>`,
);
document.file(
  "word/styles.xml",
  '<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>',
);
document.file(
  "word/_rels/document.xml.rels",
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
);
document.file("word/media/image1.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcX8AAAAASUVORK5CYII=", "base64"));
const documentBytes = await document.generateAsync({ type: "uint8array" });
const docx = await parseAttachment(new File([documentBytes], "strategy.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
assert.equal(docx.kind, "docx");
assert.deepEqual(docx.blocks.filter((block) => block.type === "heading").map((block) => [block.level, block.text]), [[1, "市场分析"], [2, "增长驱动"]]);
assert.deepEqual(docx.blocks.find((block) => block.type === "table")?.rows, [["季度", "收入"], ["Q1", "120"]]);
assert.deepEqual(docx.blocks.find((block) => block.type === "table")?.source.sectionPath, ["市场分析", "增长驱动"]);
assert.equal(docx.blocks.find((block) => block.type === "image")?.source.imageIndex, 1);
assert.equal(docx.imageFiles.length, 1);
assert.match(docx.extractedText, /章节：市场分析 > 增长驱动/);

const pdfPages = [
  {
    getTextContent: async () => ({ items: [
      { str: "Revenue evidence", transform: [18, 0, 0, 18, 40, 760], width: 150 },
      { str: "Quarter", transform: [10, 0, 0, 10, 40, 700], width: 38 },
      { str: "Revenue", transform: [10, 0, 0, 10, 180, 700], width: 42 },
      { str: "Q1", transform: [10, 0, 0, 10, 40, 680], width: 12 },
      { str: "120", transform: [10, 0, 0, 10, 180, 680], width: 18 },
    ] }),
  },
  { getTextContent: async () => ({ items: [] }) },
  { getTextContent: async () => ({ items: [] }) },
];
let destroyed = false;
const ocrCalls = [];
const pdf = await parseAttachment(new File(["mock"], "report.pdf", { type: "application/pdf" }), {
  pdfDocumentLoader: async () => ({
    numPages: pdfPages.length,
    getPage: async (pageNumber) => pdfPages[pageNumber - 1],
    destroy: async () => { destroyed = true; },
  }),
  ocrPage: async (_page, pageNumber) => {
    ocrCalls.push(pageNumber);
    if (pageNumber === 3) throw new Error("language data unavailable");
    return { text: "扫描得到的待核实数字 42", confidence: 64 };
  },
});
assert.equal(pdf.kind, "pdf");
assert.deepEqual(ocrCalls, [2, 3], "text page must not run OCR");
assert.equal(destroyed, true);
assert.deepEqual(pdf.blocks.find((block) => block.type === "table")?.rows, [["Quarter", "Revenue"], ["Q1", "120"]]);
const lowConfidence = pdf.blocks.find((block) => block.source.page === 2);
assert.equal(lowConfidence?.source.extraction, "ocr");
assert.equal(lowConfidence?.source.confidence, 64);
assert.equal(lowConfidence?.source.lowConfidence, true);
assert.match(lowConfidence?.text || "", /低置信度 OCR/);
const failedOcr = pdf.blocks.find((block) => block.source.page === 3);
assert.equal(failedOcr?.type, "notice");
assert.match(failedOcr?.text || "", /OCR 失败/);
assert.match(pdf.extractedText, /report\.pdf，第 2 页，OCR 64%，低置信度/);

const nativePdf = await parseAttachment(new File([makeSimplePdf("Native PDF text source")], "native.pdf", { type: "application/pdf" }));
assert.equal(nativePdf.kind, "pdf");
assert.match(nativePdf.extractedText, /Native PDF text source/);
assert.equal(nativePdf.blocks.find((block) => block.text?.includes("Native PDF"))?.source.page, 1);

console.log("Attachment parser tests passed: CSV, XLSX, PPTX, structured DOCX, text PDF, selective OCR, confidence and provenance.");

function makeSimplePdf(text) {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 18 Tf 50 750 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return body;
}
