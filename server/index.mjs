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
    pipeline: ["logic-planner", "image-2-reference-edit", "object-validation", "native-assembly", "editable-pptx"],
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
    let result = config.provider === "openai"
      ? await requestOpenAIResponses(config, prompt, deckSchema, "deck_spec", source.images)
      : await requestChatCompletions(config, prompt, source.images, "deck_spec");
    if (!hasExactSlideCount(result.value, source.slideCount)) {
      const retryPrompt = {
        ...prompt,
        user: `${prompt.user}\n\n纠错要求：上一次没有返回恰好 ${source.slideCount} 页。请重新规划完整叙事并返回恰好 ${source.slideCount} 个 slides；不要复用占位页，不要省略结尾，不要输出任何解释。`,
      };
      const retry = config.provider === "openai"
        ? await requestOpenAIResponses(config, retryPrompt, deckSchema, "deck_spec", source.images)
        : await requestChatCompletions(config, retryPrompt, source.images, "deck_spec");
      result = { value: retry.value, apiCalls: result.apiCalls + retry.apiCalls };
    }
    if (!hasExactSlideCount(result.value, source.slideCount)) {
      const returned = Array.isArray(result.value?.slides) ? result.value.slides.length : 0;
      throw new HttpError(502, `模型连续两次未返回指定的 ${source.slideCount} 页（当前 ${returned} 页），已停止生成以避免拼接无关页面。`);
    }
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
          prompt: cleanDisplayText(job?.prompt, 1_800),
          layout: cleanDisplayText(job?.layout, 40),
          deckTitle: cleanDisplayText(job?.deckTitle, 120),
          title: cleanDisplayText(job?.title, 120),
          subtitle: cleanDisplayText(job?.subtitle, 180),
          claim: cleanDisplayText(job?.claim, 220),
          bullets: Array.isArray(job?.bullets) ? job.bullets.map((item) => cleanDisplayText(item, 120)).filter(Boolean).slice(0, 4) : [],
          callouts: Array.isArray(job?.callouts) ? job.callouts.map((item) => ({
            label: cleanDisplayText(item?.label, 50),
            value: cleanDisplayText(item?.value, 50),
          })).filter((item) => item.label || item.value).slice(0, 3) : [],
          tableRows: Array.isArray(job?.tableRows) ? job.tableRows.slice(0, 5).map((row) => Array.isArray(row)
            ? row.slice(0, 4).map((cell) => cleanDisplayText(cell, 60))
            : []) : [],
          pageNumber: Math.max(1, Number(job?.pageNumber) || Number(job?.slideIndex) + 1),
          totalPages: Math.max(1, Number(job?.totalPages) || 1),
          textMode: job?.textMode === "native" ? "native" : "integrated",
          deckThesis: cleanDisplayText(job?.deckThesis, 400),
          audienceInsight: cleanDisplayText(job?.audienceInsight, 400),
          narrativeArc: Array.isArray(job?.narrativeArc) ? job.narrativeArc.map((item) => cleanDisplayText(item, 100)).filter(Boolean).slice(0, 12) : [],
          previousSlideTitle: cleanDisplayText(job?.previousSlideTitle, 120),
          nextSlideTitle: cleanDisplayText(job?.nextSlideTitle, 120),
        })).filter((job) => Number.isInteger(job.slideIndex) && job.prompt).slice(0, 50)
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
  const system = `你是资深演示文稿策略师和信息设计师。先定义沟通任务：演示结束时，目标受众应该理解、相信、选择或行动什么，以及为什么。任务不是逐段总结材料，而是建立一条累积推进、可被证据支持的叙事链。每页只承担一个论证任务，标题必须是受众能直接理解的观点。上一页提出的问题必须由下一页回答或推进，开场建立问题与价值，结尾必须解决开场并给出结论、决策或行动。不得编造数字、案例、来源和用户没有提供的表格。

所有可见文案只能面向演示受众，禁止泄露制作过程、模型指令和内部脚手架。除非用户材料本身明确讨论这些概念，否则不要出现 DeckSpec、Image 2、API、提示词、工作流、如何生成 PPT、页面组装、视觉拆解等生产术语。图片只是证据和视觉参考，不要从图片中臆测看不清的信息。严格输出 JSON。`;
  const imageList = source.images.map((image, index) => `图片 ${index + 1}: ${image.name}；${image.summary || "用户上传的内容参考"}`).join("\n");
  const styleLabel = source.styleId === "blank" ? "未指定，使用空白模板" : styleGuides[source.styleId].label;
  const user = `主题：${source.topic}\n受众：${source.audience}\n页数：必须恰好 ${source.slideCount} 页，不得少页、补占位页或额外增加附录\n选定风格：${styleLabel}\n\n文字材料：\n${source.textInput || "（无）"}\n\n用户提供的表格材料：\n${source.tableInput || "（无，禁止自行创建表格内容）"}\n\n图片使用说明：\n${source.imageBrief || "（无）"}\n${imageList || "（未上传图片）"}\n\n先在 story 中给出唯一核心主张、受众洞察、完整叙事弧和证据缺口，再生成恰好 ${source.slideCount} 页。整套页面必须形成连续链条：第 1 页建立核心问题或判断；中间页面依次给出背景、机制、证据、影响或方案，每页都承接上一页并为下一页制造必要性；最后 1 页解决开场问题并收束为明确结论或行动。不要把同一个观点换词重复。speakerNotes 可以记录“承接上一页”和“引向下一页”的过渡逻辑，但这些制作说明不能进入可见标题、正文或图片文案。

imageIndex 只引用从 1 开始的用户图片序号，没有合适图片时为 null。visualBrief 描述该页要用什么视觉证据支持当前观点；imagePrompt 只描述与当前页面直接相关的主体、场景、数据关系和视觉隐喻，不规定有字或无字，最终文字呈现由后续模式决定。`;
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
  return job.textMode === "native"
    ? buildNativeTextImagePrompt(job, guide, referenceInstruction)
    : buildIntegratedTextImagePrompt(job, guide, referenceInstruction);
}

function buildIntegratedTextImagePrompt(job, guide, referenceInstruction) {
  const page = `${String(job.pageNumber).padStart(2, "0")}/${String(job.totalPages).padStart(2, "0")}`;
  const bullets = job.bullets.slice(0, 3).map((item, index) => `${index + 1}. ${item}`).join("\n") || "（无）";
  const callouts = job.callouts.map((item) => `${item.label}：${item.value}`).join("；") || "（无）";
  const table = job.tableRows.length ? job.tableRows.map((row) => row.join(" | ")).join("\n") : "（无）";
  const archetype = imagePageArchetype(job.layout, job.pageNumber);
  return `画一个完整的 16:9 高端 PowerPoint 成品页面，用于第 ${job.pageNumber} 页。它属于同一套 ${job.totalPages} 页演示中的连续一页，不是独立海报。重点不是生成背景图，而是让文字本身参与构图：标题、关键词、图像、图标、数据和装饰结构必须共同讲清这一页的观点。视觉完成度要达到顶级发布会、竞赛路演或品牌提案主视觉的水准，但不要复制任何特定题材或现成作品。\n\n【整套叙事位置】\n${buildSequenceContext(job)}\n\n【页面文案，必须逐字呈现，不得改写、翻译或虚构】\n演示名称：${job.deckTitle || "（不显示）"}\n主标题：${job.title}\n副标题：${job.subtitle || "（无）"}\n核心句：${job.claim || "（无）"}\n短要点：\n${bullets}\n数据标注：${callouts}\n表格数据：\n${table}\n页码：${page}\n\n【内容与构图任务】\n${job.prompt}\n页面原型：${archetype}\n布局线索：${job.layout || "visual-right"}。\n${referenceInstruction}\n整体审美方向：${guide.direction}。\n\n【图文融合规则】\n1. 主标题是第一视觉元素，占据约 20% 到 30% 的页面，最多两到三行，按语义主动断行。选择一到两个关键词，通过明显的字号、重量、颜色、材质、描边或空间层级形成对比，但所有字仍需清晰可读。\n2. 不要把文字放进一个孤立的白框。让标题与主体轮廓、光影、构图轴线或信息图结构发生关系；短要点可以变成带图标的功能带、边注、标签、数据面板或因果链。文字和视觉必须互相解释。\n3. 至少包含一个与内容直接相关的强主视觉，以及两种辅助信息形态，例如真实摄影或高质量 3D 主体、示意图、数据曲线、图标、局部特写、流程箭头、对比面板。不能只有大字加抽象背景。\n4. 信息丰富但秩序清楚：一眼先读主标题，随后看到核心视觉，再读核心句与最多三个短要点。使用非对称网格、前中后景、尺度反差和精确对齐建立高级感。与整套其他页面保持同一字体家族、色彩系统、图标线宽、页码位置、边距和材质语言，但每页构图应随论证任务变化，不能机械复制同一模板。\n5. 只使用上面提供的文字。没有提供的品牌、统计数字、按钮、网址、免责声明和伪界面文案一律不要生成。禁止从风格参考图中抄写任何文字。除非本页文案明确包含，否则严禁出现 DeckSpec、Image 2、API、Prompt、工作流、生成 PPT、视觉拆解、页面组装等制作过程内容。若文字过多，优先完整呈现主标题、核心句、页码和最短的两个要点，不得自行缩写或编造。\n6. 中文使用清晰、粗壮、现代的简体中文字体效果，笔画完整；数字和英文保持准确。小字号也要高对比，不要出现乱码、随机字符、[object Object] 或无意义占位文字。\n7. 参考图式视觉机制是“巨型标题 + 叙事主视觉 + 模块化证据 + 底部总结带”，只借鉴其图文结合、材质和层级，不要固定使用扑克、红黑金、机械臂或赛事元素；题材、色彩和材质必须服从当前内容与选定风格。\n8. 整张图就是幻灯片本身，满画布、无白边。不要画投影幕、电脑屏幕、PPT 编辑器边框或页面外环境。关键文字与主体必须位于中央 16:9 安全裁切区；最上方和最下方只能放可被裁掉的延展背景。`;
}

function buildNativeTextImagePrompt(job, guide, referenceInstruction) {
  const visualSide = job.layout === "visual-left" ? "主体靠左构图" : "主体靠右构图";
  return `画一个用于 PowerPoint 第 ${job.pageNumber}/${job.totalPages} 页的高质量独立主视觉资产。它不是整页 PPT、不是带文字的信息图、不是界面截图，而是一张可以在 PowerPoint 中单独移动、缩放和裁切的视觉图片。\n\n【整套叙事位置】\n${buildSequenceContext(job)}\n\n【当前页视觉任务】\n${job.prompt}\n\n构图要求：${visualSide}，主体完整，轮廓清楚，背景简洁且容易与页面底色融合；为页面另一侧的原生标题、正文、表格和形状留出呼吸空间。\n${referenceInstruction}\n整体审美方向：${guide.direction}。\n\n根据内容选择真实摄影、高质量 3D、科学可视化或简洁概念场景，必须有一个明确主体和清晰视觉焦点。与整套其他页面保持相同的色彩系统、材质、光线方向、镜头语言和图标风格，但当前画面必须服务于这一页独有的论证任务。禁止生成任何可读文字、字母、数字、标志、水印、表格、卡片墙、按钮、伪界面文案、[object Object] 或 PPT 制作流程。不要画投影幕、电脑屏幕、PPT 编辑器边框或页面外环境。`;
}

function buildSequenceContext(job) {
  return [
    `整套核心主张：${job.deckThesis || job.deckTitle}`,
    `受众需要：${job.audienceInsight || "理解当前观点并知道下一步"}`,
    `叙事弧：${job.narrativeArc.join(" → ") || "问题 → 证据 → 结论"}`,
    `上一页：${job.previousSlideTitle || "这是开场页，需要建立问题与期待"}`,
    `当前页：${job.title}`,
    `下一页：${job.nextSlideTitle || "这是收束页，需要解决开场并给出结论或行动"}`,
    "当前页必须承接上一页的已知信息，并自然制造阅读下一页的必要性；不得重复上一页，也不得提前讲完下一页。",
  ].join("\n");
}

function imagePageArchetype(layout, pageNumber) {
  if (layout === "cover" || pageNumber === 1) return "封面型：巨型主标题与英雄主体互相穿插，副标题紧贴标题，底部用一条能力或价值总结带收束。";
  if (layout === "section") return "章节型：单一核心判断占主导，中央场景建立情绪，四周只有少量方向性注释与章节标记。";
  if (layout === "takeaway") return "结论型：一个强象征画面承载最终判断，核心句成为视觉锚点，底部用两到三个行动或指标收束。";
  if (layout === "visual-left") return "证据型：左侧主视觉或数据场景占主导，右侧用短要点和数据标注解释证据，形成清楚的阅读路径。";
  return "叙事型：主标题与核心句建立观点，中央或右侧强主视觉承担故事，周围用模块化证据、图标和底部因果链补足信息。";
}

function buildDecompositionPrompt(images) {
  return {
    system: "你是演示文稿视觉拆解器。请分析每张生成图的构图，不做内容改写。所有坐标使用 0 到 1 的归一化值。",
    user: `依次分析所附的 ${images.length} 张图片，对应 slideIndex：${images.map((item) => item.slideIndex).join(", ")}。为每张图返回：1) composition，一句话说明构图；2) safeArea，可叠加原生文字的最大低细节矩形；3) parts，最多三个值得独立裁出的主体区域。裁剪框必须在画布内，不能过小，尽量不重叠。parts 的 role 使用 hero、evidence、detail 或 texture。不要把文字区域作为视觉部件。`,
  };
}

async function requestOpenAIResponses(config, prompt, schema, schemaName, images = []) {
  const timeoutMs = schemaName === "image_decomposition" ? 60_000 : 150_000;
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
  }, timeoutMs);
  const payload = await readJson(response);
  if (!response.ok) throw upstreamError(response.status, payload);
  return { value: parseModelJson(extractResponseText(payload)), apiCalls: 1 };
}

async function requestChatCompletions(config, prompt, images = [], schemaName = "deck_spec") {
  const timeoutMs = schemaName === "image_decomposition" ? 60_000 : 150_000;
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
  }, timeoutMs);
  let payload = await readJson(response);
  if (!response.ok && response.status === 400) {
    delete body.response_format;
    response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers: { ...authHeaders(config), "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, timeoutMs);
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
  }, timeoutMs);
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
  if (rawSlides.length !== source.slideCount) throw new HttpError(502, `模型没有返回恰好 ${source.slideCount} 页。`);
  const layouts = new Set(["cover", "two-column", "visual-left", "visual-right", "section", "takeaway"]);
  const slides = rawSlides.slice(0, source.slideCount).map((slide, index) => ({
    title: cleanDisplayText(slide?.title, 120) || `第 ${index + 1} 页`,
    subtitle: cleanDisplayText(slide?.subtitle, 220),
    layout: layouts.has(slide?.layout) ? slide.layout : index === 0 ? "cover" : "two-column",
    claim: cleanDisplayText(slide?.claim, 320),
    bullets: Array.isArray(slide?.bullets) ? slide.bullets.map((item) => cleanDisplayText(item, 240)).filter(Boolean).slice(0, 6) : [],
    speakerNotes: cleanDisplayText(slide?.speakerNotes, 1_500),
    sourceNotes: Array.isArray(slide?.sourceNotes) ? slide.sourceNotes.map((item) => cleanDisplayText(item, 240)).filter(Boolean).slice(0, 5) : [],
    imageIndex: Number.isInteger(slide?.imageIndex) && slide.imageIndex > 0 ? slide.imageIndex : undefined,
    callouts: Array.isArray(slide?.callouts) ? slide.callouts.slice(0, 3).map((item) => ({
      label: cleanDisplayText(item?.label, 40),
      value: cleanDisplayText(item?.value ?? item, 80),
    })).filter((item) => item.label || item.value) : [],
    visualBrief: cleanDisplayText(slide?.visualBrief, 800),
    imagePrompt: cleanDisplayText(slide?.imagePrompt, 1_200),
  }));
  const rawStory = raw?.story || {};
  return {
    title: cleanDisplayText(raw?.title, 180) || source.topic,
    theme: ["dark-executive", "light-consulting", "editorial-visual"].includes(raw?.theme) ? raw.theme : "light-consulting",
    story: {
      thesis: cleanDisplayText(rawStory.thesis, 500) || slides[0].claim || source.topic,
      audienceInsight: cleanDisplayText(rawStory.audienceInsight, 500) || `${source.audience}需要清楚的结论和行动。`,
      narrativeArc: Array.isArray(rawStory.narrativeArc) ? rawStory.narrativeArc.map((item) => cleanDisplayText(item, 80)).filter(Boolean).slice(0, 12) : [],
      evidenceGaps: Array.isArray(rawStory.evidenceGaps) ? rawStory.evidenceGaps.map((item) => cleanDisplayText(item, 240)).filter(Boolean).slice(0, 6) : [],
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
      composition: cleanDisplayText(item?.composition, 500) || "视觉主体与文字留白分区",
      safeArea: normalizeRect(item?.safeArea, { x: 0.06, y: 0.08, w: 0.4, h: 0.82 }),
      parts: Array.isArray(item?.parts) ? item.parts.slice(0, 3).map((part, partIndex) => ({
        label: cleanDisplayText(part?.label, 80) || `视觉部件 ${partIndex + 1}`,
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

function hasExactSlideCount(value, expected) {
  return Array.isArray(value?.slides) && value.slides.length === expected;
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
function cleanDisplayText(value, maxLength) {
  return cleanText(extractDisplayText(value), maxLength)
    .replace(/\[object Object\]/gi, "")
    .replace(/\b(?:undefined|null)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function extractDisplayText(value, depth = 0) {
  if (depth > 3 || value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map((item) => extractDisplayText(item, depth + 1)).filter(Boolean).join("；");
  if (typeof value !== "object") return "";
  const preferredKeys = ["text", "content", "title", "point", "claim", "description", "name", "value", "label"];
  for (const key of preferredKeys) {
    const text = extractDisplayText(value[key], depth + 1);
    if (text) return text;
  }
  return Object.values(value).map((item) => extractDisplayText(item, depth + 1)).filter(Boolean).slice(0, 2).join("：");
}
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
