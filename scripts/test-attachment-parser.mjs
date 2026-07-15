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

console.log("Attachment parser smoke test passed: CSV, XLSX, PPTX text and PPTX image extraction.");
