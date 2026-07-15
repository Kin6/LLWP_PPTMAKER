import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imageBase64 = (await fs.readFile(path.join(root, "public", "style-guides", "product-calm.png"))).toString("base64");

const deck = {
  title: "模拟 API：五阶段 PPT 工作流",
  theme: "light-consulting",
  story: {
    thesis: "高质量 PPT 需要把内容逻辑、视觉生成和原生对象交付串成一条流程。",
    audienceInsight: "决策者希望先看到结论，再检查证据和可执行动作。",
    narrativeArc: ["核心判断", "当前问题", "关键证据", "五阶段方案", "交付价值"],
    evidenceGaps: ["正式版本需要补充真实用户质量评测"],
    styleId: "product-calm",
  },
  slides: Array.from({ length: 7 }, (_, index) => ({
    title: [
      "把内容、视觉与交付串成一条闭环",
      "多数工具只优化版式，没有先解决论证",
      "三类输入需要先被转成可追溯证据",
      "风格参考图让 Image 2 获得稳定审美方向",
      "视觉拆解让图片成为可独立移动的对象",
      "原生组装保留文字、表格和图片的编辑能力",
      "以可编辑 PPTX 作为最终质量验收",
    ][index],
    subtitle: `模拟服务返回的第 ${index + 1} 页`,
    layout: index === 0 ? "cover" : index % 2 ? "visual-right" : "visual-left",
    claim: "这一页只承担一个清晰的论证任务。",
    bullets: ["结论先行，证据紧随其后", "视觉服务于信息而不是替代文字", "最终对象可以在 PowerPoint 中继续修改"],
    speakerNotes: "用于自动化验收的模拟讲稿备注。",
    sourceNotes: ["用户文字", index === 2 ? "用户表格" : "流程设计"],
    imageIndex: null,
    callouts: index === 6 ? [{ label: "交付格式", value: "PPTX" }] : [],
    visualBrief: "清晰的产品工作流与信息结构视觉",
    imagePrompt: `第 ${index + 1} 页，智能演示文稿工作流，留出原生文字空间，无任何文字`,
  })),
};

const decomposition = {
  slides: [
    { slideIndex: 0, composition: "左侧留白，右侧为界面主体", safeArea: { x: 0.05, y: 0.12, w: 0.42, h: 0.74 }, parts: [{ label: "主界面", role: "hero", x: 0.48, y: 0.08, w: 0.47, h: 0.78 }, { label: "数据卡片", role: "detail", x: 0.08, y: 0.12, w: 0.27, h: 0.3 }] },
    { slideIndex: 1, composition: "中央产品界面与右侧证据模块", safeArea: { x: 0.05, y: 0.08, w: 0.35, h: 0.82 }, parts: [{ label: "产品界面", role: "hero", x: 0.4, y: 0.08, w: 0.52, h: 0.72 }, { label: "图表证据", role: "evidence", x: 0.55, y: 0.55, w: 0.3, h: 0.3 }] },
  ],
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "GET" && req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "mock-vision" }] }));
  if (req.method === "POST" && req.url === "/v1/images/edits") {
    for await (const _chunk of req) { /* consume multipart request */ }
    return res.end(JSON.stringify({ data: [{ b64_json: imageBase64 }] }));
  }
  if (req.method === "POST" && req.url === "/v1/responses") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const name = parsed?.text?.format?.name;
    const payload = name === "image_decomposition" ? decomposition : deck;
    return res.end(JSON.stringify({ output_text: JSON.stringify(payload) }));
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const text = JSON.stringify(parsed?.messages || []);
    const payload = text.includes("依次分析所附") ? decomposition : deck;
    return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: "Mock route not found" } }));
});

server.listen(4010, "127.0.0.1", () => console.log("Mock OpenAI service running at http://127.0.0.1:4010/v1"));
