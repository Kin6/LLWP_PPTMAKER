import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const isProduction =
  process.env.NODE_ENV === "production" || process.argv.includes("--production");
const portArgIndex = process.argv.indexOf("--port");
const port =
  portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : Number(process.env.PORT || 5173);

const app = express();
app.use(express.json({ limit: "12mb" }));

const deckSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "theme", "slides"],
  properties: {
    title: { type: "string" },
    theme: {
      type: "string",
      enum: ["dark-executive", "light-consulting", "editorial-visual"],
    },
    slides: {
      type: "array",
      minItems: 4,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "subtitle",
          "layout",
          "bullets",
          "speakerNotes",
          "sourceNotes",
          "imageIndex",
          "callouts",
        ],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          layout: {
            type: "string",
            enum: ["cover", "two-column", "visual-left", "visual-right", "section", "takeaway"],
          },
          bullets: { type: "array", items: { type: "string" }, maxItems: 6 },
          speakerNotes: { type: "string" },
          sourceNotes: { type: "array", items: { type: "string" }, maxItems: 5 },
          imageIndex: { anyOf: [{ type: "integer" }, { type: "null" }] },
          callouts: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "value"],
              properties: {
                label: { type: "string" },
                value: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "hybrid",
    externalApiCalls: "optional",
    envKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    note: "Local generation always works. AI routes are called only after the user enables AI mode.",
  });
});

app.post("/api/ai/test", async (req, res) => {
  const startedAt = Date.now();
  try {
    const config = normalizeTextConfig(req.body?.config || {});
    const headers = authHeaders(config);
    const response = await fetchWithTimeout(`${config.baseUrl}/models`, {
      headers,
      method: "GET",
    }, 20_000);
    const payload = await readJson(response);
    if (!response.ok) throw upstreamError(response.status, payload);
    res.json({
      ok: true,
      model: config.model,
      provider: config.provider,
      latencyMs: Date.now() - startedAt,
      keySource: config.keySource,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/generate-deck", async (req, res) => {
  try {
    const config = normalizeTextConfig(req.body?.config || {});
    const source = normalizeSource(req.body?.source || {});
    const prompt = buildDeckPrompt(source);
    const deck = config.provider === "openai"
      ? await requestOpenAIResponses(config, prompt)
      : await requestChatCompletions(config, prompt);

    res.json({
      ok: true,
      deck: normalizeDeck(deck, source),
      meta: {
        provider: config.provider,
        model: config.model,
        apiCalls: 1,
        keySource: config.keySource,
      },
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/generate-images", async (req, res) => {
  try {
    const config = normalizeImageConfig(req.body?.config || {});
    const prompts = Array.isArray(req.body?.prompts)
      ? req.body.prompts.map((item) => cleanText(item, 900)).filter(Boolean).slice(0, 3)
      : [];
    if (!prompts.length) throw new HttpError(400, "至少需要一个图片提示词。");

    const images = [];
    for (const prompt of prompts) {
      const response = await fetchWithTimeout(`${config.baseUrl}/images/generations`, {
        method: "POST",
        headers: { ...authHeaders(config), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          prompt,
          n: 1,
          size: "1536x1024",
          quality: config.quality,
          output_format: "png",
        }),
      }, 180_000);
      const payload = await readJson(response);
      if (!response.ok) throw upstreamError(response.status, payload);
      const item = payload?.data?.[0];
      const url = item?.b64_json
        ? `data:image/png;base64,${item.b64_json}`
        : item?.url;
      if (!url) throw new HttpError(502, "图片 API 没有返回可用图片。");
      images.push({ url, prompt, revisedPrompt: item?.revised_prompt || "" });
    }

    res.json({
      ok: true,
      images,
      meta: { model: config.model, apiCalls: images.length, keySource: config.keySource },
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

function normalizeTextConfig(raw) {
  const provider = ["openai", "compatible", "ollama"].includes(raw.provider)
    ? raw.provider
    : "openai";
  const fallbackBase = provider === "ollama"
    ? "http://127.0.0.1:11434/v1"
    : process.env.TEXT_API_BASE_URL || "https://api.openai.com/v1";
  const fallbackModel = provider === "ollama"
    ? "qwen3:8b"
    : process.env.TEXT_MODEL || "gpt-5.4-mini";
  return finishConfig({
    provider,
    baseUrl: raw.baseUrl || fallbackBase,
    model: raw.model || fallbackModel,
    apiKey: raw.apiKey,
    allowNoKey: provider === "ollama",
  });
}

function normalizeImageConfig(raw) {
  return finishConfig({
    provider: "openai",
    baseUrl: raw.baseUrl || process.env.TEXT_API_BASE_URL || "https://api.openai.com/v1",
    model: raw.model || process.env.IMAGE_MODEL || "gpt-image-2",
    apiKey: raw.apiKey,
    allowNoKey: false,
    quality: ["low", "medium", "high"].includes(raw.quality) ? raw.quality : "medium",
  });
}

function finishConfig({ provider, baseUrl, model, apiKey, allowNoKey, quality }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedBaseUrl);
  } catch {
    throw new HttpError(400, "API Base URL 格式不正确。");
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new HttpError(400, "API Base URL 只支持 http 或 https。");
  }
  const requestKey = String(apiKey || "").trim();
  const envKey = String(process.env.OPENAI_API_KEY || "").trim();
  const resolvedKey = requestKey || envKey;
  if (!allowNoKey && !resolvedKey) {
    throw new HttpError(400, "缺少 API Key。请在页面填写，或在 .env.local 配置 OPENAI_API_KEY。");
  }
  return {
    provider,
    baseUrl: normalizedBaseUrl,
    model: cleanText(model, 120),
    apiKey: resolvedKey,
    keySource: requestKey ? "session" : resolvedKey ? "environment" : "none",
    quality,
  };
}

function authHeaders(config) {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

function normalizeSource(raw) {
  return {
    topic: cleanText(raw.topic, 180) || "未命名演示文稿",
    audience: cleanText(raw.audience, 180) || "通用受众",
    slideCount: Math.max(4, Math.min(12, Number(raw.slideCount) || 7)),
    textInput: cleanText(raw.textInput, 24_000),
    tableInput: cleanText(raw.tableInput, 12_000),
    imageBrief: cleanText(raw.imageBrief, 3_000),
    imageSummaries: Array.isArray(raw.imageSummaries)
      ? raw.imageSummaries.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 10)
      : [],
  };
}

function buildDeckPrompt(source) {
  const system = `你是资深演示文稿策划师。请把用户材料转成一份中文 DeckSpec。先建立“结论 -> 证据 -> 行动”的叙事，再设计页面。不要编造事实或数字；材料不足时明确写成假设。每页标题必须表达观点，不要只写类别名。每页 2 到 5 个要点，每个要点尽量短。sourceNotes 要指出依据来自文字、表格或图片说明。严格输出 JSON，不要 Markdown。`;
  const user = `主题：${source.topic}\n受众：${source.audience}\n目标页数：${source.slideCount}\n\n文字材料：\n${source.textInput || "（无）"}\n\n表格材料：\n${source.tableInput || "（无）"}\n\n图片说明：\n${source.imageBrief || "（无）"}\n${source.imageSummaries.join("\n")}\n\n请生成恰好 ${source.slideCount} 页。封面后应依次覆盖核心结论、问题或背景、主要证据、方案或洞察、行动建议。imageIndex 只能引用从 1 开始的已上传图片序号，没有合适图片时为 null。`;
  return { system, user };
}

async function requestOpenAIResponses(config, prompt) {
  const response = await fetchWithTimeout(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: { ...authHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: [
        { role: "system", content: [{ type: "input_text", text: prompt.system }] },
        { role: "user", content: [{ type: "input_text", text: prompt.user }] },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "deck_spec",
          strict: true,
          schema: deckSchema,
        },
      },
    }),
  }, 120_000);
  const payload = await readJson(response);
  if (!response.ok) throw upstreamError(response.status, payload);
  return parseModelJson(extractResponseText(payload));
}

async function requestChatCompletions(config, prompt) {
  const url = `${config.baseUrl}/chat/completions`;
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.35,
  };
  let response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { ...authHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 120_000);
  let payload = await readJson(response);
  if (!response.ok && response.status === 400) {
    delete body.response_format;
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { ...authHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 120_000);
    payload = await readJson(response);
  }
  if (!response.ok) throw upstreamError(response.status, payload);
  return parseModelJson(payload?.choices?.[0]?.message?.content || "");
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .map((item) => item?.text || item?.value || "")
    .filter(Boolean)
    .join("\n");
}

function parseModelJson(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // Fall through to the user-facing error below.
      }
    }
    throw new HttpError(502, "模型返回的不是有效 DeckSpec JSON。请换用支持结构化输出的模型。");
  }
}

function normalizeDeck(raw, source) {
  const rawSlides = Array.isArray(raw?.slides) ? raw.slides : [];
  if (!rawSlides.length) throw new HttpError(502, "模型没有返回幻灯片内容。");
  const layouts = new Set(["cover", "two-column", "visual-left", "visual-right", "section", "takeaway"]);
  const slides = rawSlides.slice(0, source.slideCount).map((slide, index) => ({
    title: cleanText(slide?.title, 120) || `第 ${index + 1} 页`,
    subtitle: cleanText(slide?.subtitle, 220),
    layout: layouts.has(slide?.layout) ? slide.layout : index === 0 ? "cover" : "two-column",
    bullets: Array.isArray(slide?.bullets)
      ? slide.bullets.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 6)
      : [],
    speakerNotes: cleanText(slide?.speakerNotes, 1_500),
    sourceNotes: Array.isArray(slide?.sourceNotes)
      ? slide.sourceNotes.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 5)
      : [],
    imageIndex: Number.isInteger(slide?.imageIndex) && slide.imageIndex > 0
      ? slide.imageIndex
      : undefined,
    callouts: Array.isArray(slide?.callouts)
      ? slide.callouts.slice(0, 3).map((item) => ({
          label: cleanText(item?.label, 40),
          value: cleanText(item?.value, 80),
        })).filter((item) => item.label || item.value)
      : [],
  }));
  return {
    title: cleanText(raw?.title, 180) || source.topic,
    theme: ["dark-executive", "light-consulting", "editorial-visual"].includes(raw?.theme)
      ? raw.theme
      : "light-consulting",
    slides,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new HttpError(504, "模型服务响应超时。");
    throw new HttpError(502, `无法连接模型服务：${error?.message || "网络错误"}`);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function upstreamError(status, payload) {
  const message = payload?.error?.message || payload?.message || `模型服务返回 ${status}`;
  return new HttpError(status >= 500 ? 502 : status, cleanText(message, 500));
}

function sendApiError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "未知服务错误。";
  res.status(status).json({ ok: false, error: message });
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(root, "dist", "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root,
    server: {
      middlewareMode: true,
      host: "0.0.0.0",
      watch: { ignored: ["**/artifacts/**", "**/dist/**"] },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(port, "0.0.0.0", () => {
  console.log(`DeckForge running at http://127.0.0.1:${port}`);
});
