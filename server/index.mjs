import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";
import { FormData as UndiciFormData, ProxyAgent, fetch as undiciFetch } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const openAiApiKey = resolveEnvironmentSecret("OPENAI_API_KEY");
const openAiApiBase = resolveEnvironmentSecret("OPENAI_API_BASE") || resolveEnvironmentSecret("OPENAI_BASE_URL");
const explicitTextApiBase = resolveEnvironmentSecret("TEXT_API_BASE_URL");
const explicitImageApiBase = resolveEnvironmentSecret("IMAGE_API_BASE_URL");
const explicitTextModel = resolveEnvironmentSecret("TEXT_MODEL");
const explicitImageModel = resolveEnvironmentSecret("IMAGE_MODEL");
const textApiBaseUrl = explicitTextApiBase || openAiApiBase || "https://api.openai.com/v1";
const imageApiBaseUrl = explicitImageApiBase || openAiApiBase || "https://api.openai.com/v1";
const textModel = explicitTextModel || "gpt-5.6-terra";
const imageModel = explicitImageModel || "gpt-image-2";
const apiDefaultsFromEnvironment = Boolean(openAiApiBase || explicitTextApiBase || explicitImageApiBase || explicitTextModel || explicitImageModel);
const defaultApiProvider = isOfficialOpenAIBase(textApiBaseUrl) ? "openai" : "compatible";
const outboundProxyUrl = resolveProxyUrl();
const outboundProxyAgent = outboundProxyUrl ? new ProxyAgent(outboundProxyUrl) : null;

const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");
const portArgIndex = process.argv.indexOf("--port");
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : Number(process.env.PORT || 5173);

const app = express();
app.use(express.json({ limit: "42mb" }));

const rectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "w", "h"],
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    w: { type: "number" },
    h: { type: "number" },
  },
};

const deckSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "theme", "story", "slides"],
  properties: {
    title: { type: "string" },
    theme: { type: "string", enum: ["dark-executive", "light-consulting", "editorial-visual"] },
    story: {
      type: "object",
      additionalProperties: false,
      required: ["thesis", "audienceInsight", "narrativeArc", "evidenceGaps", "styleId"],
      properties: {
        thesis: { type: "string" },
        audienceInsight: { type: "string" },
        narrativeArc: { type: "array", items: { type: "string" }, maxItems: 8 },
        evidenceGaps: { type: "array", items: { type: "string" }, maxItems: 6 },
        styleId: { type: "string" },
      },
    },
    slides: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title", "subtitle", "layout", "claim", "bullets", "speakerNotes", "sourceNotes",
          "imageIndex", "callouts", "visualBrief", "imagePrompt",
        ],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          layout: { type: "string", enum: ["cover", "two-column", "visual-left", "visual-right", "section", "takeaway"] },
          claim: { type: "string" },
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
              properties: { label: { type: "string" }, value: { type: "string" } },
            },
          },
          visualBrief: { type: "string" },
          imagePrompt: { type: "string" },
        },
      },
    },
  },
};

const decompositionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slides"],
  properties: {
    slides: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slideIndex", "composition", "safeArea", "parts"],
        properties: {
          slideIndex: { type: "integer" },
          composition: { type: "string" },
          safeArea: rectSchema,
          parts: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "role", "x", "y", "w", "h"],
              properties: {
                label: { type: "string" },
                role: { type: "string" },
                x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
              },
            },
          },
        },
      },
    },
  },
};

const styleGuides = {
  blank: { file: null, label: "空白模板", direction: "content-led neutral composition with no prescribed palette or decorative style" },
  "product-calm": { file: "product-calm.png", label: "沉静产品", direction: "off-white product workspace, ink structure, electric blue and chartreuse accents" },
  "consulting-grid": { file: "consulting-grid.png", label: "咨询网格", direction: "Swiss business grid, white, charcoal, cobalt blue and signal red" },
  "editorial-tech": { file: "editorial-tech.png", label: "编辑科技", direction: "asymmetric technology editorial, black and white, cyan and vermilion" },
  "cinematic-dark": { file: "cinematic-dark.png", label: "电影感数据", direction: "cinematic graphite data story, luminous cyan and restrained amber" },
};

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "hybrid",
    envKeyConfigured: Boolean(openAiApiKey),
    proxyConfigured: Boolean(outboundProxyAgent),
    apiDefaults: {
      source: apiDefaultsFromEnvironment ? "environment" : "default",
      provider: defaultApiProvider,
      baseUrl: textApiBaseUrl,
      model: textModel,
      imageBaseUrl: imageApiBaseUrl,
      imageModel,
    },
    pipeline: ["logic-planner", "image-2-reference-edit", "vision-decomposition", "native-assembly", "editable-pptx"],
  });
});

app.post("/api/ai/test", async (req, res) => {
  const startedAt = Date.now();
  try {
    const config = normalizeTextConfig(req.body?.config || {});
    const response = await fetchWithTimeout(`${config.baseUrl}/models`, { headers: authHeaders(config), method: "GET" }, 20_000);
    const payload = await readJson(response);
    if (!response.ok) throw upstreamError(response.status, payload);
    res.json({ ok: true, model: config.model, provider: config.provider, latencyMs: Date.now() - startedAt, keySource: config.keySource });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/generate-deck", async (req, res) => {
  try {
    const config = normalizeTextConfig(req.body?.config || {});
    const source = normalizeSource(req.body?.source || {});
    const prompt = buildDeckPrompt(source);
    const result = config.provider === "openai"
      ? await requestOpenAIResponses(config, prompt, deckSchema, "deck_spec", source.images)
      : await requestChatCompletions(config, prompt, source.images, "deck_spec");
    res.json({
      ok: true,
      deck: normalizeDeck(result.value, source),
      meta: { provider: config.provider, model: config.model, apiCalls: result.apiCalls, keySource: config.keySource },
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/generate-images", async (req, res) => {
  try {
    const config = normalizeImageConfig(req.body?.config || {});
    const styleId = styleGuides[req.body?.styleId] ? req.body.styleId : "product-calm";
    const jobs = Array.isArray(req.body?.jobs)
      ? req.body.jobs.map((job) => ({
          slideIndex: Number(job?.slideIndex),
          prompt: cleanText(job?.prompt, 1_800),
          layout: cleanText(job?.layout, 40),
        })).filter((job) => Number.isInteger(job.slideIndex) && job.prompt).slice(0, 4)
      : [];
    if (!jobs.length) throw new HttpError(400, "至少需要一个图片任务。");
    const references = normalizeImages(req.body?.referenceImages).slice(0, 3);
    const guide = styleGuides[styleId];
    const guideBytes = guide.file ? await fs.readFile(path.join(root, "public", "style-guides", guide.file)) : null;
    const images = [];

    for (const job of jobs) {
      const officialImageApi = isOfficialOpenAIBase(config.baseUrl);
      let response;
      let prompt;
      if (!guideBytes && !references.length) {
        prompt = buildImagePrompt(job, guide, 0, "none");
        const generationBody = {
          model: config.model,
          prompt,
          size: "1536x1024",
          ...(officialImageApi ? { quality: config.quality, output_format: "png" } : {}),
        };
        response = await fetchWithTimeout(`${config.baseUrl}/images/generations`, {
          method: "POST",
          headers: { ...authHeaders(config), "Content-Type": "application/json" },
          body: JSON.stringify(generationBody),
        }, 240_000);
      } else {
        const form = new UndiciFormData();
        form.append("model", config.model);
        form.append("size", "1536x1024");
        let referenceMode = "style-single";
        if (officialImageApi) {
          form.append("quality", config.quality);
          form.append("output_format", "png");
          if (guideBytes) form.append("image[]", new Blob([guideBytes], { type: "image/png" }), `style-${styleId}.png`);
          references.forEach((reference, index) => {
            const decoded = decodeDataUrl(reference.dataUrl);
            form.append("image[]", new Blob([decoded.bytes], { type: decoded.mime }), `user-reference-${index + 1}.${mimeExtension(decoded.mime)}`);
          });
          referenceMode = guideBytes ? "style-and-user-multi" : "user-multi";
        } else if (references.length) {
          const decoded = decodeDataUrl(references[0].dataUrl);
          form.append("image", new Blob([decoded.bytes], { type: decoded.mime }), `user-reference-1.${mimeExtension(decoded.mime)}`);
          referenceMode = "user-single";
        } else if (guideBytes) {
          form.append("image", new Blob([guideBytes], { type: "image/png" }), `style-${styleId}.png`);
        }
        prompt = buildImagePrompt(job, guide, references.length, referenceMode);
        form.append("prompt", prompt);
        response = await fetchWithTimeout(`${config.baseUrl}/images/edits`, {
          method: "POST",
          headers: authHeaders(config),
          body: form,
        }, 240_000);
      }
      const payload = await readJson(response);
      if (!response.ok) throw upstreamError(response.status, payload);
      const item = payload?.data?.[0];
      const url = await imageResultToDataUrl(item);
      if (!url) throw new HttpError(502, "Image 2 没有返回可用图片。");
      images.push({ slideIndex: job.slideIndex, url, prompt, revisedPrompt: item?.revised_prompt || "" });
    }

    res.json({ ok: true, images, meta: { model: config.model, apiCalls: images.length, keySource: config.keySource } });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/decompose-images", async (req, res) => {
  try {
    const config = normalizeTextConfig(req.body?.config || {});
    const images = Array.isArray(req.body?.images)
      ? req.body.images.map((image) => ({ slideIndex: Number(image?.slideIndex), dataUrl: cleanDataUrl(image?.url) }))
          .filter((image) => Number.isInteger(image.slideIndex) && image.dataUrl).slice(0, 4)
      : [];
    if (!images.length) throw new HttpError(400, "没有可拆解的生成图。");
    const prompt = buildDecompositionPrompt(images);
    const result = config.provider === "openai"
      ? await requestOpenAIResponses(config, prompt, decompositionSchema, "image_decomposition", images.map((item) => ({ name: `slide-${item.slideIndex}`, dataUrl: item.dataUrl, summary: "generated slide visual" })))
      : await requestChatCompletions(config, prompt, images.map((item) => ({ name: `slide-${item.slideIndex}`, dataUrl: item.dataUrl, summary: "generated slide visual" })), "image_decomposition");
    res.json({
      ok: true,
      decompositions: normalizeDecompositions(result.value, images),
      meta: { provider: config.provider, model: config.model, apiCalls: result.apiCalls, keySource: config.keySource },
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

function normalizeTextConfig(raw) {
  const provider = ["openai", "compatible", "ollama"].includes(raw.provider) ? raw.provider : "openai";
  const fallbackBase = provider === "ollama" ? "http://127.0.0.1:11434/v1" : textApiBaseUrl;
  const fallbackModel = provider === "ollama" ? "qwen3:8b" : textModel;
  return finishConfig({ provider, baseUrl: raw.baseUrl || fallbackBase, model: raw.model || fallbackModel, apiKey: raw.apiKey, allowNoKey: provider === "ollama" });
}

function normalizeImageConfig(raw) {
  return finishConfig({
    provider: "openai",
    baseUrl: raw.baseUrl || imageApiBaseUrl,
    model: raw.model || imageModel,
    apiKey: raw.apiKey,
    allowNoKey: false,
    quality: ["low", "medium", "high"].includes(raw.quality) ? raw.quality : "medium",
  });
}

function finishConfig({ provider, baseUrl, model, apiKey, allowNoKey, quality }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  let parsedUrl;
  try { parsedUrl = new URL(normalizedBaseUrl); } catch { throw new HttpError(400, "API Base URL 格式不正确。"); }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new HttpError(400, "API Base URL 只支持 http 或 https。");
  const requestKey = String(apiKey || "").trim();
  const envKey = openAiApiKey;
  const resolvedKey = requestKey || envKey;
  if (!allowNoKey && !resolvedKey) throw new HttpError(400, "缺少 API Key。请在页面填写，或在 .env.local 配置 OPENAI_API_KEY。");
  return {
    provider,
    baseUrl: normalizedBaseUrl,
    model: cleanText(model, 120),
    apiKey: resolvedKey,
    keySource: requestKey ? "session" : resolvedKey ? "environment" : "none",
    quality,
  };
}

function normalizeSource(raw) {
  const audience = cleanText(raw.audience, 180);
  if (!audience) throw new HttpError(400, "请明确填写目标受众，例如：董事会、投资人、客户或内部团队。");
  return {
    topic: cleanText(raw.topic, 180) || "未命名演示文稿",
    audience,
    slideCount: Math.max(1, Math.min(50, Math.round(Number(raw.slideCount) || 7))),
    textInput: cleanText(raw.textInput, 28_000),
    tableInput: cleanText(raw.tableInput, 14_000),
    imageBrief: cleanText(raw.imageBrief, 3_000),
    styleId: styleGuides[raw.styleId] ? raw.styleId : "product-calm",
    images: normalizeImages(raw.images),
  };
}

function normalizeImages(raw) {
  return Array.isArray(raw)
    ? raw.map((item, index) => ({
        name: cleanText(item?.name, 160) || `image-${index + 1}`,
        dataUrl: cleanDataUrl(item?.dataUrl),
        summary: cleanText(item?.summary, 500),
      })).filter((item) => item.dataUrl).slice(0, 4)
    : [];
}

function buildDeckPrompt(source) {
  const system = `你是资深演示文稿策略师和信息设计师。任务不是总结材料，而是建立一条可辩护的演示逻辑。先识别受众要做的决定，再区分事实、判断、证据和行动。使用“核心结论 -> 背景矛盾 -> 关键证据 -> 方案 -> 行动”的结构，但根据材料调整。不得编造数字、案例或来源；材料不足时写入 evidenceGaps。每页标题必须表达观点，每页只承担一个论证任务。图片只是证据和视觉参考，不要从图片中臆测看不清的信息。严格输出 JSON。`;
  const imageList = source.images.map((image, index) => `图片 ${index + 1}: ${image.name}；${image.summary || "用户上传的内容参考"}`).join("\n");
  const styleLabel = source.styleId === "blank" ? "未指定，使用空白模板" : styleGuides[source.styleId].label;
  const user = `主题：${source.topic}\n受众：${source.audience}\n页数：严格 ${source.slideCount} 页\n选定风格：${styleLabel}\n\n文字材料：\n${source.textInput || "（无）"}\n\n表格材料：\n${source.tableInput || "（无）"}\n\n图片使用说明：\n${source.imageBrief || "（无）"}\n${imageList || "（未上传图片）"}\n\n请先在 story 中给出核心主张、受众洞察、叙事弧和证据缺口，再生成恰好 ${source.slideCount} 页。imageIndex 只引用从 1 开始的用户图片序号，没有合适图片时为 null。visualBrief 描述该页需要表达什么，imagePrompt 是给图像模型的中文提示词，必须要求 16:9、无文字、为原生文字保留清晰留白。`;
  return { system, user };
}

function buildImagePrompt(job, guide, userReferenceCount, referenceMode) {
  const referenceInstruction = referenceMode === "style-and-user-multi"
    ? `Image 1 是内置“${guide.label}”风格引导图，只学习其视觉语法，不复制具体内容。${userReferenceCount ? `Image 2 到 Image ${userReferenceCount + 1} 是用户内容参考，必须保留主体身份和事实属性。` : "没有用户内容参考。"}`
    : referenceMode === "user-multi"
      ? `所有输入图片都是用户内容参考，必须保留主体身份和事实属性；不要套用额外风格。`
    : referenceMode === "user-single"
      ? `Image 1 是用户提供的内容参考，必须保留主体身份和事实属性。${guide.file ? `内置“${guide.label}”风格通过文字描述提供，不要改变用户主体。` : "不要套用额外风格。"}`
      : referenceMode === "none"
        ? "没有风格图或用户参考图，请只根据内容任务组织中性、清楚的视觉。"
      : `Image 1 是内置“${guide.label}”风格引导图，只学习其视觉语法、构图节奏、配色关系和材质，不复制具体内容。`;
  return `画一个适合第 ${job.slideIndex + 1} 页的 16:9 高端演示视觉。\n内容任务：${job.prompt}\n页面布局：${job.layout || "visual-right"}。\n${referenceInstruction}\n整体方向：${guide.direction}。画面必须是可拆分的演示视觉素材，主体清楚，最多 3 个主要视觉区域。禁止任何文字、字母、数字、标志、水印和伪界面文案。为后续叠加原生 PowerPoint 标题与正文保留一块干净、低细节、高对比的负空间。`;
}

function buildDecompositionPrompt(images) {
  return {
    system: "你是演示文稿视觉拆解器。请分析每张生成图的构图，不做内容改写。所有坐标使用 0 到 1 的归一化值。",
    user: `依次分析所附的 ${images.length} 张图片，对应 slideIndex：${images.map((item) => item.slideIndex).join(", ")}。为每张图返回：1) composition，一句话说明构图；2) safeArea，可叠加原生文字的最大低细节矩形；3) parts，最多三个值得独立裁出的主体区域。裁剪框必须在画布内，不能过小，尽量不重叠。parts 的 role 使用 hero、evidence、detail 或 texture。不要把文字区域作为视觉部件。`,
  };
}

async function requestOpenAIResponses(config, prompt, schema, schemaName, images = []) {
  const userContent = [{ type: "input_text", text: prompt.user }];
  images.forEach((image) => {
    userContent.push({ type: "input_text", text: `附件：${image.name}${image.summary ? `；${image.summary}` : ""}` });
    userContent.push({ type: "input_image", image_url: image.dataUrl, detail: "high" });
  });
  const response = await fetchWithTimeout(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: { ...authHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: [
        { role: "system", content: [{ type: "input_text", text: prompt.system }] },
        { role: "user", content: userContent },
      ],
      text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    }),
  }, 150_000);
  const payload = await readJson(response);
  if (!response.ok) throw upstreamError(response.status, payload);
  return { value: parseModelJson(extractResponseText(payload)), apiCalls: 1 };
}

async function requestChatCompletions(config, prompt, images = [], schemaName = "deck_spec") {
  const userContent = images.length
    ? [{ type: "text", text: prompt.user }, ...images.flatMap((image) => [
        { type: "text", text: `附件：${image.name}${image.summary ? `；${image.summary}` : ""}` },
        { type: "image_url", image_url: { url: image.dataUrl } },
      ])]
    : prompt.user;
  const body = {
    model: config.model,
    messages: [{ role: "system", content: prompt.system }, { role: "user", content: userContent }],
    response_format: { type: "json_object" },
    temperature: 0.25,
  };
  let response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST", headers: { ...authHeaders(config), "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, 150_000);
  let payload = await readJson(response);
  if (!response.ok && response.status === 400) {
    delete body.response_format;
    response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers: { ...authHeaders(config), "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, 150_000);
    payload = await readJson(response);
  }
  if (!response.ok) throw upstreamError(response.status, payload);
  let apiCalls = 1;
  const firstText = extractChatCompletionText(payload);
  const firstValue = tryParseModelJson(firstText);
  if (hasStructuredContent(firstValue, schemaName)) return { value: firstValue, apiCalls };

  const repairInstruction = schemaName === "deck_spec"
    ? "请修复上一次输出。只返回一个有效 JSON 对象，根对象必须包含 title、theme、story 和非空 slides 数组。slides 必须严格遵守用户指定页数，每页包含 title、subtitle、layout、claim、bullets、speakerNotes、sourceNotes、imageIndex、callouts、visualBrief、imagePrompt。不要输出解释、Markdown 或代码围栏。"
    : "请修复上一次输出。只返回一个有效 JSON 对象，根对象必须包含非空 slides 数组，每项包含 slideIndex、composition、safeArea 和 parts。不要输出解释、Markdown 或代码围栏。";
  const repairMessages = [...body.messages];
  if (firstText) repairMessages.push({ role: "assistant", content: firstText });
  repairMessages.push({ role: "user", content: repairInstruction });
  const repairBody = { ...body, messages: repairMessages, temperature: 0 };
  response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST", headers: { ...authHeaders(config), "Content-Type": "application/json" }, body: JSON.stringify(repairBody),
  }, 150_000);
  payload = await readJson(response);
  if (!response.ok) throw upstreamError(response.status, payload);
  apiCalls += 1;
  const repairedValue = tryParseModelJson(extractChatCompletionText(payload));
  if (!hasStructuredContent(repairedValue, schemaName)) {
    throw new HttpError(502, schemaName === "deck_spec"
      ? "模型连续两次没有返回可用的幻灯片结构。请确认文本模型支持 JSON 输出，或在 API 设置中更换模型。"
      : "模型连续两次没有返回可用的视觉拆解结构。请更换支持图片理解和 JSON 输出的模型。");
  }
  return { value: repairedValue, apiCalls };
}

function normalizeDeck(raw, source) {
  const rawSlides = Array.isArray(raw?.slides) ? raw.slides : [];
  if (!rawSlides.length) throw new HttpError(502, "模型没有返回幻灯片内容。");
  const layouts = new Set(["cover", "two-column", "visual-left", "visual-right", "section", "takeaway"]);
  const slides = rawSlides.slice(0, source.slideCount).map((slide, index) => ({
    title: cleanText(slide?.title, 120) || `第 ${index + 1} 页`,
    subtitle: cleanText(slide?.subtitle, 220),
    layout: layouts.has(slide?.layout) ? slide.layout : index === 0 ? "cover" : "two-column",
    claim: cleanText(slide?.claim, 320),
    bullets: Array.isArray(slide?.bullets) ? slide.bullets.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 6) : [],
    speakerNotes: cleanText(slide?.speakerNotes, 1_500),
    sourceNotes: Array.isArray(slide?.sourceNotes) ? slide.sourceNotes.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 5) : [],
    imageIndex: Number.isInteger(slide?.imageIndex) && slide.imageIndex > 0 ? slide.imageIndex : undefined,
    callouts: Array.isArray(slide?.callouts) ? slide.callouts.slice(0, 3).map((item) => ({ label: cleanText(item?.label, 40), value: cleanText(item?.value, 80) })).filter((item) => item.label || item.value) : [],
    visualBrief: cleanText(slide?.visualBrief, 800),
    imagePrompt: cleanText(slide?.imagePrompt, 1_200),
  }));
  while (slides.length < source.slideCount) {
    slides.push({
      title: `补充页 ${slides.length + 1}`, subtitle: "用于承接上一页并补足行动信息", layout: "two-column",
      claim: "需要补充材料以完成这一页", bullets: ["请在预览区编辑这一页"], speakerNotes: "模型返回页数不足，已创建可编辑占位页。",
      sourceNotes: ["系统补页"], callouts: [], visualBrief: "简洁的过渡视觉", imagePrompt: `${source.topic}，简洁过渡视觉，无文字`,
    });
  }
  const rawStory = raw?.story || {};
  return {
    title: cleanText(raw?.title, 180) || source.topic,
    theme: ["dark-executive", "light-consulting", "editorial-visual"].includes(raw?.theme) ? raw.theme : "light-consulting",
    story: {
      thesis: cleanText(rawStory.thesis, 500) || slides[0].claim || source.topic,
      audienceInsight: cleanText(rawStory.audienceInsight, 500) || `${source.audience}需要清楚的结论和行动。`,
      narrativeArc: Array.isArray(rawStory.narrativeArc) ? rawStory.narrativeArc.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 8) : [],
      evidenceGaps: Array.isArray(rawStory.evidenceGaps) ? rawStory.evidenceGaps.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 6) : [],
      styleId: source.styleId,
    },
    slides,
  };
}

function normalizeDecompositions(raw, images) {
  const values = Array.isArray(raw?.slides) ? raw.slides : [];
  return images.map((image, index) => {
    const item = values.find((candidate) => Number(candidate?.slideIndex) === image.slideIndex) || values[index] || {};
    return {
      slideIndex: image.slideIndex,
      composition: cleanText(item?.composition, 500) || "视觉主体与文字留白分区",
      safeArea: normalizeRect(item?.safeArea, { x: 0.06, y: 0.08, w: 0.4, h: 0.82 }),
      parts: Array.isArray(item?.parts) ? item.parts.slice(0, 3).map((part, partIndex) => ({
        label: cleanText(part?.label, 80) || `视觉部件 ${partIndex + 1}`,
        role: ["hero", "evidence", "detail", "texture"].includes(part?.role) ? part.role : "detail",
        ...normalizeRect(part, { x: 0.5, y: 0.12 + partIndex * 0.24, w: 0.42, h: 0.22 }),
      })) : [],
    };
  });
}

function normalizeRect(value, fallback) {
  const x = clamp01(Number(value?.x));
  const y = clamp01(Number(value?.y));
  const w = Math.max(0.08, Math.min(1 - x, Number(value?.w) || fallback.w));
  const h = Math.max(0.08, Math.min(1 - y, Number(value?.h) || fallback.h));
  return { x: Number.isFinite(x) ? x : fallback.x, y: Number.isFinite(y) ? y : fallback.y, w, h };
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new HttpError(400, "参考图片格式不正确。");
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

function cleanDataUrl(value) {
  const text = String(value || "").trim();
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(text)) return "";
  if (text.length > 9_000_000) throw new HttpError(413, "单张图片过大，请压缩到约 6MB 以内。");
  return text;
}

async function imageResultToDataUrl(item) {
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  const remoteUrl = String(item?.url || "").trim();
  if (!remoteUrl) return "";
  if (remoteUrl.startsWith("data:image/")) return cleanDataUrl(remoteUrl);
  let parsed;
  try { parsed = new URL(remoteUrl); } catch { throw new HttpError(502, "Image 2 返回了无效图片地址。"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new HttpError(502, "Image 2 返回了不支持的图片地址。");
  const response = await fetchWithTimeout(remoteUrl, { method: "GET" }, 90_000);
  if (!response.ok) throw new HttpError(502, `无法下载 Image 2 返回的图片 (${response.status})。`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 12_000_000) throw new HttpError(502, "Image 2 返回的图片为空或过大。");
  const rawMime = String(response.headers.get("content-type") || "image/png").split(";")[0].toLowerCase();
  const mime = ["image/png", "image/jpeg", "image/webp"].includes(rawMime) ? rawMime : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function mimeExtension(mime) {
  return mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
}

function authHeaders(config) { return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}; }
function clamp01(value) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || []).flatMap((item) => item?.content || []).map((item) => item?.text || item?.value || "").filter(Boolean).join("\n");
}

function extractChatCompletionText(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = flattenTextContent(message.content);
  if (content) return content;
  const reasoning = flattenTextContent(message.reasoning_content);
  if (reasoning) return reasoning;
  if (typeof choice.text === "string") return choice.text;
  return extractResponseText(payload);
}

function flattenTextContent(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(flattenTextContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.value === "string") return value.value.trim();
  if (typeof value.content === "string") return value.content.trim();
  return "";
}

function tryParseModelJson(text) {
  try { return parseModelJson(text); } catch { return null; }
}

function hasStructuredContent(value, schemaName) {
  if (!value || typeof value !== "object") return false;
  if (schemaName === "deck_spec") return Array.isArray(value.slides) && value.slides.length > 0;
  return Array.isArray(value.slides) && value.slides.length > 0;
}

function parseModelJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* handled below */ }
    }
    throw new HttpError(502, "模型返回的不是有效 JSON，请换用支持结构化输出的模型。");
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  try {
    const host = new URL(url).hostname;
    const dispatcher = outboundProxyAgent && !["127.0.0.1", "localhost", "::1"].includes(host)
      ? outboundProxyAgent
      : undefined;
    return await undiciFetch(url, { ...options, dispatcher, signal: AbortSignal.timeout(timeoutMs) });
  }
  catch (error) {
    if (error?.name === "TimeoutError") throw new HttpError(504, "模型服务响应超时。");
    throw new HttpError(502, `无法连接模型服务：${error?.message || "网络错误"}`);
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 500) } }; }
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

function cleanText(value, maxLength) { return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength); }
function isOfficialOpenAIBase(value) {
  try { return new URL(value).hostname.toLowerCase() === "api.openai.com"; }
  catch { return false; }
}
function resolveEnvironmentSecret(name) {
  const inherited = String(process.env[name] || "").trim();
  if (inherited || process.platform !== "win32") return inherited;
  try {
    const script = `$user=[Environment]::GetEnvironmentVariable('${name}','User'); if($user){$user}else{[Environment]::GetEnvironmentVariable('${name}','Machine')}`;
    return String(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    }) || "").trim();
  } catch {
    return "";
  }
}
function resolveProxyUrl() {
  const envProxy = resolveEnvironmentSecret("HTTPS_PROXY") || resolveEnvironmentSecret("HTTP_PROXY") || resolveEnvironmentSecret("ALL_PROXY");
  if (envProxy) return envProxy;
  try {
    const gitProxy = String(execFileSync("git", ["config", "--get", "http.proxy"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    }) || "").trim();
    return /^https?:\/\//i.test(gitProxy) ? gitProxy : "";
  } catch {
    return "";
  }
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (_req, res) => res.sendFile(path.join(root, "dist", "index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, host: "0.0.0.0", watch: { ignored: ["**/artifacts/**", "**/dist/**"] } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(port, "0.0.0.0", () => console.log(`DeckForge running at http://127.0.0.1:${port}`));
