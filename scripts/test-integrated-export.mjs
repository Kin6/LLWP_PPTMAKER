import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts");
await fs.mkdir(artifacts, { recursive: true });
process.chdir(artifacts);

class NodeFileReader {
  result = null;
  onload = null;
  onerror = null;

  readAsDataURL(blob) {
    blob.arrayBuffer()
      .then((buffer) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload?.();
      })
      .catch((error) => this.onerror?.(error));
  }
}

globalThis.FileReader = NodeFileReader;

const { exportNotebookDeck } = await import("../src/lib/exportDeck.ts");
const image = await fs.readFile(path.join(root, "public", "style-guides", "product-calm.png"));
const imageUrl = `data:image/png;base64,${image.toString("base64")}`;
const title = "图文融合导出验收";
const filename = `${title}.pptx`;
const deck = {
  title,
  theme: "editorial-visual",
  story: {
    thesis: "文字与视觉共同完成论证。",
    audienceInsight: "决策者需要先看观点，再看证据。",
    narrativeArc: ["观点", "证据"],
    evidenceGaps: [],
    styleId: "blank",
  },
  slides: [{
    title: "文字本身就是主视觉",
    subtitle: "图像、标题与证据共同叙事",
    layout: "cover",
    claim: "完整页面不是背景图加文本框",
    bullets: ["巨型标题建立层级", "主视觉解释观点"],
    speakerNotes: "验收讲稿",
    sourceNotes: ["自动化测试"],
    imageIndex: 1,
    visualMode: "full-slide-text",
  }],
};
const assets = [{
  id: "generated-1",
  filename: "integrated.png",
  url: imageUrl,
  prompt: "test",
  index: 1,
  kind: "generated",
}];

await exportNotebookDeck(deck, assets);
const pptx = await fs.readFile(path.join(artifacts, filename));
const zip = await JSZip.loadAsync(pptx);
const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
const notesXml = await zip.file("ppt/notesSlides/notesSlide1.xml")?.async("string");

if (!slideXml || !notesXml) throw new Error("PPTX 缺少第一页或讲稿备注 XML。");
if ((slideXml.match(/<a:t>/g) || []).length !== 0) throw new Error("融合页面不应叠加重复文字框。");
if ((slideXml.match(/<p:pic>/g) || []).length < 1) throw new Error("融合页面缺少整页图片对象。");
for (const expected of ["文字本身就是主视觉", "图像、标题与证据共同叙事", "完整页面不是背景图加文本框", "巨型标题建立层级"]) {
  if (!notesXml.includes(expected)) throw new Error(`讲稿备注缺少内容源：${expected}`);
}

await fs.unlink(path.join(artifacts, filename));
console.log("Integrated export smoke test passed: image-only page with complete source text in speaker notes.");
