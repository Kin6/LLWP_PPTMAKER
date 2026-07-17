import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MOCK_PORT || 4010);
const disableImageFailures = process.env.MOCK_DISABLE_IMAGE_FAILURES === "1";
const forcedImageFailureMode = process.env.MOCK_IMAGE_FAILURE_MODE || "";
const streamDelayMs = Math.max(0, Number(process.env.MOCK_STREAM_DELAY_MS) || 0);
const expectedImageSize = "1536x864";
const imageBase64 = (await fs.readFile(path.join(root, "public", "style-guides", "product-calm.png"))).toString("base64");
const failedImageTokens = new Set();

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
    sourceBlockIds: [],
    imageIndex: null,
    callouts: index === 6 ? [{ label: "交付格式", value: "PPTX" }] : [],
    visualBrief: "清晰的产品工作流与信息结构视觉",
    imagePrompt: `第 ${index + 1} 页，智能演示文稿工作流，留出原生文字空间，无任何文字`,
  })),
};

function deckForRequest(text) {
  const match = String(text || "").match(/(?:必须恰好|严格)\s*(\d+)\s*页/);
  const count = Math.max(1, Math.min(50, Number(match?.[1]) || deck.slides.length));
  const failureMatch = String(text).match(/FAIL_IMAGE_ONCE_PAGE_(\d+)/);
  const failurePage = Number(failureMatch?.[1]) || 0;
  const blockIds = [...new Set([
    ...[...String(text).matchAll(/\[blockId:\s*([^\]]+)\]/g)].map((match) => match[1]),
    ...[...String(text).matchAll(/"blockId"\s*:\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...String(text).matchAll(/\b(?:source|block)-[A-Za-z0-9-]{3,}\b/g)].map((match) => match[0]),
  ])];
  const slides = Array.from({ length: count }, (_, index) => {
    const base = deck.slides[index % deck.slides.length];
    const isLast = index === count - 1;
    return {
      ...base,
      title: isLast && count > 1 ? "把前述证据收束为下一步行动" : base.title,
      subtitle: `模拟服务返回的第 ${index + 1}/${count} 页`,
      speakerNotes: `承接第 ${Math.max(1, index)} 页，并引向第 ${Math.min(count, index + 2)} 页。`,
      sourceBlockIds: blockIds.length ? [blockIds[index % blockIds.length]] : [],
      imagePrompt: `${base.imagePrompt}${index + 1 === failurePage ? ` FAIL_IMAGE_ONCE_PAGE_${failurePage}` : ""}`,
    };
  });
  if (String(text).includes("RETURN_OBJECT_FIELDS")) {
    slides[0] = {
      ...slides[0],
      title: { text: "对象字段已安全转成标题" },
      bullets: [{ text: "对象要点一" }, { content: "对象要点二" }, { label: "对象要点三" }],
      sourceNotes: [{ text: "对象来源" }],
    };
  }
  return { ...deck, slides };
}

function outlineForRequest(text) {
  const fullDeck = deckForRequest(text);
  return {
    title: fullDeck.title,
    theme: fullDeck.theme,
    story: fullDeck.story,
    slides: fullDeck.slides.map((slide) => ({
      title: slide.title,
      purpose: "推进一项必要判断，并为下一页建立前提。",
      evidence: slide.bullets.slice(0, 2),
      sourceBlockIds: slide.sourceBlockIds,
      visualAnchor: "与本页判断直接相关的真实项目证据",
    })),
  };
}

function htmlDeckForRequest(text) {
  const notebook = deckForRequest(text);
  return {
    id: "mock-html-deck",
    title: notebook.title,
    width: 1600,
    height: 900,
    revision: 2,
    theme: {
      name: "模拟交互演示",
      background: "#F8F8F4",
      surface: "#FFFFFF",
      text: "#111820",
      muted: "#667078",
      primary: "#0E6CFF",
      accent: "#E74C36",
      fontFamily: "Microsoft YaHei, sans-serif",
    },
    slides: notebook.slides.map((slide, index) => {
      const titleId = `slide-${index + 1}-title`;
      const chartId = `slide-${index + 1}-chart`;
      return {
        id: `slide-${index + 1}`,
        title: slide.title,
        background: index % 2 ? "#111820" : "#F8F8F4",
        transition: "fade",
        nodes: [
          {
            id: titleId, type: "text", name: "页面标题", x: 0.06, y: 0.08, w: 0.54, h: 0.18, zIndex: 2,
            animation: "rise", animationDelay: 0, text: slide.title, role: "title",
            style: { fontSize: 54, fontWeight: 760, lineHeight: 1.1, color: index % 2 ? "#FFFFFF" : "#111820", align: "left", verticalAlign: "middle", backgroundColor: "transparent", borderColor: "transparent", borderWidth: 0, radius: 0, opacity: 1, padding: 0 },
          },
          {
            id: chartId, type: "chart", name: "核心数据图", x: 0.46, y: 0.34, w: 0.46, h: 0.48, zIndex: 3,
            animation: "fade", animationDelay: 0.15, chartType: "bar", labels: ["内容", "视觉", "交付"],
            series: [{ name: "质量", values: [72, 86, 94], color: "#0E6CFF" }], showLegend: false, showValues: true, accentColor: "#0E6CFF",
          },
        ],
        interactions: [{ id: `slide-${index + 1}-highlight`, trigger: "click", action: "highlight", sourceId: titleId, targetId: chartId, variableId: null, value: null }],
        speakerNotes: slide.speakerNotes,
      };
    }),
    variables: [
      { id: "primary-color", label: "主色", type: "color", value: "#0E6CFF", min: null, max: null, step: null, options: null },
      { id: "accent-color", label: "强调色", type: "color", value: "#E74C36", min: null, max: null, step: null, options: null },
      { id: "motion-enabled", label: "动画", type: "boolean", value: true, min: null, max: null, step: null, options: null },
    ],
    comments: [],
    drawings: [],
  };
}

function htmlPatchForRequest(text) {
  const slideId = String(text).match(/目标页面[：:]\s*([\w-]+)/)?.[1] || "slide-1";
  const nodeId = String(text).match(/目标节点[：:]\s*([\w-]+)/)?.[1] || `${slideId}-title`;
  return {
    summary: "已放大选中标题并保留原有内容。",
    patches: [{ slideId, nodeId, operation: "update-node", changesJson: JSON.stringify({ style: { fontSize: 60 } }) }],
  };
}

function imageFailureMode(prompt) {
  if (disableImageFailures) return "";
  if (forcedImageFailureMode === "html-524" || forcedImageFailureMode === "json-timeout") return forcedImageFailureMode;
  const text = String(prompt || "");
  const htmlMatch = text.match(/FAIL_HTML_524_ONCE_PAGE_(\d+)/);
  const match = htmlMatch || text.match(/FAIL_IMAGE_ONCE_PAGE_(\d+)/);
  if (!match || failedImageTokens.has(match[0])) return false;
  failedImageTokens.add(match[0]);
  return htmlMatch ? "html-524" : "json-timeout";
}

async function streamJsonText(res, text, kind) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  for (let offset = 0; offset < text.length; offset += 96) {
    const delta = text.slice(offset, offset + 96);
    if (kind === "responses") {
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
    }
    if (streamDelayMs) await new Promise((resolve) => setTimeout(resolve, streamDelayMs));
  }
  if (kind === "responses") {
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output_text: text } })}\n\n`);
  } else {
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

const decomposition = {
  slides: [
    { slideIndex: 0, composition: "左侧留白，右侧为界面主体", safeArea: { x: 0.05, y: 0.12, w: 0.42, h: 0.74 }, parts: [{ label: "主界面", role: "hero", x: 0.48, y: 0.08, w: 0.47, h: 0.78 }, { label: "数据卡片", role: "detail", x: 0.08, y: 0.12, w: 0.27, h: 0.3 }] },
    { slideIndex: 1, composition: "中央产品界面与右侧证据模块", safeArea: { x: 0.05, y: 0.08, w: 0.35, h: 0.82 }, parts: [{ label: "产品界面", role: "hero", x: 0.4, y: 0.08, w: 0.52, h: 0.72 }, { label: "图表证据", role: "evidence", x: 0.55, y: 0.55, w: 0.3, h: 0.3 }] },
  ],
};

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/mock-image.png") {
    res.setHeader("Content-Type", "image/png");
    return res.end(Buffer.from(imageBase64, "base64"));
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "GET" && req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "mock-vision" }] }));
  if (req.method === "POST" && req.url === "/v1/images/edits") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const multipart = Buffer.concat(chunks).toString("latin1");
    const fieldNames = [...multipart.matchAll(/;\s*name="([^"]+)"/g)].map((match) => match[1]);
    if (!multipart.includes('name="image"') || multipart.includes('name="image[]"')) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `Missing request parameter: image (received: ${fieldNames.join(", ")})` } }));
    }
    if (!multipart.includes(`name="size"\r\n\r\n${expectedImageSize}`)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `Expected 16:9 image size ${expectedImageSize}` } }));
    }
    const explicitDrawInstruction = Buffer.from("画一个", "utf8").toString("latin1");
    if (!multipart.includes(explicitDrawInstruction)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "Prompt must contain an explicit drawing instruction" } }));
    }
    const promptMatch = multipart.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/);
    const decodedPrompt = promptMatch ? Buffer.from(promptMatch[1], "latin1").toString("utf8") : "";
    const failureMode = imageFailureMode(decodedPrompt);
    if (failureMode === "html-524") {
      res.statusCode = 524;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<!DOCTYPE html><html><head><title>524: A timeout occurred</title></head><body>gateway timeout</body></html>");
    }
    if (failureMode === "json-timeout") {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout" } }));
    }
    return res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/mock-image.png` }] }));
  }
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    if (parsed.size !== expectedImageSize) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `Expected 16:9 image size ${expectedImageSize}` } }));
    }
    if (!String(parsed.prompt || "").includes("画一个")) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "Prompt must contain an explicit drawing instruction" } }));
    }
    const failureMode = imageFailureMode(parsed.prompt);
    if (failureMode === "html-524") {
      res.statusCode = 524;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<!DOCTYPE html><html><head><title>524: A timeout occurred</title></head><body>gateway timeout</body></html>");
    }
    if (failureMode === "json-timeout") {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout" } }));
    }
    return res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/mock-image.png` }] }));
  }
  if (req.method === "POST" && req.url === "/v1/responses") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const name = parsed?.text?.format?.name;
    const requestText = JSON.stringify(parsed?.input || []);
    if (name === "html_deck" && (parsed.model === "mock-html-timeout" || requestText.includes("mock-html-timeout"))) {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout" } }));
    }
    if (["html_deck", "html_patch"].includes(name) && /data:image\/(?:png|jpe?g|webp);base64,/i.test(requestText)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "HTML text prompt must not contain inline image data" } }));
    }
    const payload = name === "image_decomposition"
      ? decomposition
      : name === "deck_outline"
        ? outlineForRequest(requestText)
      : name === "html_deck"
        ? htmlDeckForRequest(requestText)
        : name === "html_patch"
          ? htmlPatchForRequest(requestText)
          : deckForRequest(requestText);
    if (parsed.stream) return streamJsonText(res, JSON.stringify(payload), "responses");
    return res.end(JSON.stringify({ output_text: JSON.stringify(payload) }));
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const text = JSON.stringify(parsed?.messages || []);
    if (text.includes("完整 HtmlDeckSpec") && (parsed.model === "mock-html-timeout" || text.includes("mock-html-timeout"))) {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout" } }));
    }
    if (parsed.model === "mock-timeout" && text.includes("依次分析所附")) {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "Model service timed out" } }));
    }
    if (text.includes("FORCE_EMPTY_DECK") && parsed.messages.length <= 2) {
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ title: "empty", slides: [] }) }] } }] }));
    }
    const payload = text.includes("changesJson 必须")
      ? htmlPatchForRequest(text)
      : text.includes("DECK_OUTLINE_JSON")
        ? outlineForRequest(text)
      : text.includes("完整 HtmlDeckSpec")
        ? htmlDeckForRequest(text)
        : text.includes("依次分析所附")
          ? decomposition
          : deckForRequest(text);
    if (parsed.stream) return streamJsonText(res, JSON.stringify(payload), "chat");
    return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: "Mock route not found" } }));
});

server.listen(port, "127.0.0.1", () => console.log(`Mock OpenAI service running at http://127.0.0.1:${port}/v1`));
