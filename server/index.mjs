import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { FormData as UndiciFormData, ProxyAgent, fetch as undiciFetch } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const openAiApiKey = resolveEnvironmentSecret("OPENAI_API_KEY");
const openAiApiBase = resolveEnvironmentSecret("OPENAI_API_BASE") || resolveEnvironmentSecret("OPENAI_BASE_URL");
const explicitOpenAiApiFallbackBase = resolveEnvironmentSecret("OPENAI_API_FALLBACK_BASE");
const explicitTextApiBase = resolveEnvironmentSecret("TEXT_API_BASE_URL");
const explicitImageApiBase = resolveEnvironmentSecret("IMAGE_API_BASE_URL");
const explicitImageApiFallbackBase = resolveEnvironmentSecret("IMAGE_API_FALLBACK_BASE_URL");
const explicitTextModel = resolveEnvironmentSecret("TEXT_MODEL");
const explicitImageModel = resolveEnvironmentSecret("IMAGE_MODEL");
const configuredImageTimeoutMs = boundedInteger(resolveEnvironmentSecret("IMAGE_API_TIMEOUT_MS"), 240_000, 900_000, 600_000);
const configuredImageMaxRetries = boundedInteger(resolveEnvironmentSecret("IMAGE_API_MAX_RETRIES"), 0, 2, 1);
const imageOutputSize = "1536x864";
const maxModelTextInputLength = 8_000_000;
const textApiBaseUrl = explicitTextApiBase || openAiApiBase || "https://api.openai.com/v1";
const imageApiBaseUrl = explicitImageApiBase || openAiApiBase || "https://api.openai.com/v1";
const imageApiFallbackBaseUrl = explicitImageApiFallbackBase || explicitOpenAiApiFallbackBase || defaultGatewayFallback(imageApiBaseUrl);
const textModel = explicitTextModel || "gpt-5.6-terra";
const imageModel = explicitImageModel || "gpt-image-2";
const defaultApiProvider = isOfficialOpenAIBase(textApiBaseUrl) ? "openai" : "compatible";
const outboundProxyUrl = resolveProxyUrl();
const outboundProxyAgent = outboundProxyUrl ? new ProxyAgent(outboundProxyUrl) : null;

const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");
const portArgIndex = process.argv.indexOf("--port");
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : Number(process.env.PORT || 5173);
const host = String(process.env.HOST || "127.0.0.1").trim();

const app = express();
app.use(express.json({ limit: "42mb" }));

app.get("/api/html-runtime/reveal.js", (_req, res) => sendRuntimeAsset(res, "reveal.js/dist/reveal.js", "application/javascript; charset=utf-8"));
app.get("/api/html-runtime/reveal.css", (_req, res) => sendRuntimeAsset(res, "reveal.js/dist/reveal.css", "text/css; charset=utf-8"));
app.get("/api/html-runtime/echarts.js", (_req, res) => sendRuntimeAsset(res, "echarts/dist/echarts.min.js", "application/javascript; charset=utf-8"));

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
          "sourceBlockIds", "imageIndex", "callouts", "visualBrief", "imagePrompt",
        ],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          layout: { type: "string", enum: ["cover", "two-column", "visual-left", "visual-right", "section", "takeaway"] },
          claim: { type: "string" },
          bullets: { type: "array", items: { type: "string" }, maxItems: 6 },
          speakerNotes: { type: "string" },
          sourceNotes: { type: "array", items: { type: "string" }, maxItems: 5 },
          sourceBlockIds: { type: "array", items: { type: "string" }, maxItems: 8 },
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

const deckOutlineSchema = {
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
        required: ["title", "purpose", "evidence", "sourceBlockIds", "visualAnchor"],
        properties: {
          title: { type: "string" },
          purpose: { type: "string" },
          evidence: { type: "array", items: { type: "string" }, maxItems: 4 },
          sourceBlockIds: { type: "array", items: { type: "string" }, maxItems: 8 },
          visualAnchor: { type: "string" },
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

const htmlNodeBaseProperties = {
  id: { type: "string" },
  name: { type: "string" },
  x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
  zIndex: { type: "integer" },
  animation: { type: "string", enum: ["none", "fade", "rise", "scale", "draw"] },
  animationDelay: { type: "number" },
};
const htmlNodeBaseRequired = ["id", "type", "name", "x", "y", "w", "h", "zIndex", "animation", "animationDelay"];
const htmlNodeSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      required: [...htmlNodeBaseRequired, "text", "role", "style"],
      properties: {
        ...htmlNodeBaseProperties, type: { type: "string", enum: ["text"] },
        text: { type: "string" },
        role: { type: "string", enum: ["title", "subtitle", "body", "caption", "metric", "source"] },
        style: {
          type: "object", additionalProperties: false,
          required: ["fontSize", "fontWeight", "lineHeight", "color", "align", "verticalAlign", "backgroundColor", "borderColor", "borderWidth", "radius", "opacity", "padding"],
          properties: {
            fontSize: { type: "number" }, fontWeight: { type: "number" }, lineHeight: { type: "number" }, color: { type: "string" },
            align: { type: "string", enum: ["left", "center", "right"] }, verticalAlign: { type: "string", enum: ["top", "middle", "bottom"] },
            backgroundColor: { type: "string" }, borderColor: { type: "string" }, borderWidth: { type: "number" }, radius: { type: "number" }, opacity: { type: "number" }, padding: { type: "number" },
          },
        },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: [...htmlNodeBaseRequired, "shape", "fill", "stroke", "strokeWidth", "radius", "opacity"],
      properties: {
        ...htmlNodeBaseProperties, type: { type: "string", enum: ["shape"] },
        shape: { type: "string", enum: ["rect", "circle", "line"] }, fill: { type: "string" }, stroke: { type: "string" },
        strokeWidth: { type: "number" }, radius: { type: "number" }, opacity: { type: "number" },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: [...htmlNodeBaseRequired, "src", "alt", "objectFit", "prompt", "assetId", "opacity"],
      properties: {
        ...htmlNodeBaseProperties, type: { type: "string", enum: ["image"] }, src: { type: "string" }, alt: { type: "string" },
        objectFit: { type: "string", enum: ["cover", "contain"] }, prompt: { type: "string" }, assetId: { type: "string" }, opacity: { type: "number" },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: [...htmlNodeBaseRequired, "chartType", "labels", "series", "showLegend", "showValues", "accentColor"],
      properties: {
        ...htmlNodeBaseProperties, type: { type: "string", enum: ["chart"] },
        chartType: { type: "string", enum: ["bar", "line", "pie", "scatter", "radar"] },
        labels: { type: "array", items: { type: "string" }, maxItems: 50 },
        series: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["name", "values", "color"], properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" }, maxItems: 50 }, color: { type: "string" } } } },
        showLegend: { type: "boolean" }, showValues: { type: "boolean" }, accentColor: { type: "string" },
      },
    },
    {
      type: "object", additionalProperties: false,
      required: [...htmlNodeBaseRequired, "widgetType", "props"],
      properties: {
        ...htmlNodeBaseProperties, type: { type: "string", enum: ["widget"] },
        widgetType: { type: "string", enum: ["counter", "progress", "particle-field", "timeline"] },
        props: { type: "object", additionalProperties: false, required: ["label", "value", "max"], properties: { label: { type: "string" }, value: { type: "number" }, max: { type: "number" } } },
      },
    },
  ],
};
const htmlDeckSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "title", "width", "height", "revision", "theme", "slides", "variables", "comments", "drawings"],
  properties: {
    id: { type: "string" }, title: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, revision: { type: "integer" },
    theme: {
      type: "object", additionalProperties: false,
      required: ["name", "background", "surface", "text", "muted", "primary", "accent", "fontFamily"],
      properties: { name: { type: "string" }, background: { type: "string" }, surface: { type: "string" }, text: { type: "string" }, muted: { type: "string" }, primary: { type: "string" }, accent: { type: "string" }, fontFamily: { type: "string" } },
    },
    slides: {
      type: "array", minItems: 1, maxItems: 50,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "title", "background", "transition", "nodes", "interactions", "speakerNotes"],
        properties: {
          id: { type: "string" }, title: { type: "string" }, background: { type: "string" }, transition: { type: "string", enum: ["none", "fade", "slide", "zoom"] },
          nodes: { type: "array", maxItems: 120, items: htmlNodeSchema },
          interactions: { type: "array", maxItems: 120, items: { type: "object", additionalProperties: false, required: ["id", "trigger", "action", "sourceId", "targetId", "variableId", "value"], properties: { id: { type: "string" }, trigger: { type: "string", enum: ["click", "hover", "enter", "key"] }, action: { type: "string", enum: ["next", "previous", "toggle", "highlight", "set-variable", "animate"] }, sourceId: { type: ["string", "null"] }, targetId: { type: ["string", "null"] }, variableId: { type: ["string", "null"] }, value: { type: ["string", "number", "boolean", "null"] } } } },
          speakerNotes: { type: "string" },
        },
      },
    },
    variables: { type: "array", maxItems: 80, items: { type: "object", additionalProperties: false, required: ["id", "label", "type", "value", "min", "max", "step", "options"], properties: { id: { type: "string" }, label: { type: "string" }, type: { type: "string", enum: ["number", "color", "boolean", "select"] }, value: { type: ["string", "number", "boolean"] }, min: { type: ["number", "null"] }, max: { type: ["number", "null"] }, step: { type: ["number", "null"] }, options: { type: ["array", "null"], items: { type: "string" } } } } },
    comments: { type: "array", maxItems: 0, items: { type: "object", additionalProperties: false, properties: {}, required: [] } },
    drawings: { type: "array", maxItems: 0, items: { type: "object", additionalProperties: false, properties: {}, required: [] } },
  },
};
const htmlPatchSchema = {
  type: "object", additionalProperties: false,
  required: ["summary", "patches"],
  properties: {
    summary: { type: "string" },
    patches: {
      type: "array", maxItems: 40,
      items: {
        type: "object", additionalProperties: false,
        required: ["slideId", "nodeId", "operation", "changesJson"],
        properties: {
          slideId: { type: "string" },
          nodeId: { type: ["string", "null"] },
          operation: { type: "string", enum: ["update-node", "add-node", "update-slide", "remove-node", "reorder-slides"] },
          changesJson: { type: "string" },
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
      imageTimeoutMs: configuredImageTimeoutMs,
      imageMaxRetries: configuredImageMaxRetries,
    },
    pipeline: ["story-outline", "story-compose", "image-2-art-direction", "full-slide-assembly", "pptx-export"],
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
    res.json(await generateDeckPayload(req.body));
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/generate-deck-stream", (req, res) => {
  sendNdjsonStream(res, (emit) => generateDeckPayload(req.body, emit));
});

app.post("/api/ai/generate-html-deck", async (req, res) => {
  try {
    res.json(await generateHtmlDeckPayload(req.body));
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/generate-html-deck-stream", (req, res) => {
  sendNdjsonStream(res, (emit) => generateHtmlDeckPayload(req.body, emit));
});

app.post("/api/ai/patch-html-deck", async (req, res) => {
  try {
    res.json(await patchHtmlDeckPayload(req.body));
  } catch (error) {
    sendApiError(res, error);
  }
});

app.post("/api/ai/patch-html-deck-stream", (req, res) => {
  sendNdjsonStream(res, (emit) => patchHtmlDeckPayload(req.body, emit));
});

async function generateDeckPayload(body, emit) {
  const config = normalizeTextConfig(body?.config || {});
  const source = normalizeSource(body?.source || {});
  const outlinePrompt = buildDeckOutlinePrompt(source);
  emit?.({ type: "phase", phase: "story-outline", message: "正在规划叙事大纲与证据顺序" });
  let outlineResult = await requestDeckOutlineModel(config, outlinePrompt, source.images, phaseProgress(emit, "story-outline"));
  if (!hasExactSlideCount(outlineResult.value, source.slideCount)) {
    emit?.({ type: "phase", phase: "story-outline-retry", message: "大纲页数未对齐，正在自动修复" });
    const retryPrompt = {
      ...outlinePrompt,
      user: `${outlinePrompt.user}\n\n纠错要求：上一次没有返回恰好 ${source.slideCount} 页。请重新规划轻量大纲并返回恰好 ${source.slideCount} 个 slides；不要补占位页，不要输出完整页面文案。`,
    };
    const retry = await requestDeckOutlineModel(config, retryPrompt, source.images, phaseProgress(emit, "story-outline-retry"));
    outlineResult = { value: retry.value, apiCalls: outlineResult.apiCalls + retry.apiCalls };
  }
  if (!hasExactSlideCount(outlineResult.value, source.slideCount)) {
    const returned = Array.isArray(outlineResult.value?.slides) ? outlineResult.value.slides.length : 0;
    throw new HttpError(502, `模型连续两次未返回指定的 ${source.slideCount} 页大纲（当前 ${returned} 页）。`);
  }
  const outline = normalizeDeckOutline(outlineResult.value, source);
  const composePrompt = buildDeckFromOutlinePrompt(source, outline);
  emit?.({ type: "phase", phase: "story-compose", message: "大纲已完成，正在扩展完整页面内容" });
  let result = await requestDeckModel(config, composePrompt, [], phaseProgress(emit, "story-compose"));
  if (!hasExactSlideCount(result.value, source.slideCount)) {
    emit?.({ type: "phase", phase: "story-compose-retry", message: "完整页面页数未对齐，正在自动修复" });
    const retryPrompt = {
      ...composePrompt,
      user: `${composePrompt.user}\n\n纠错要求：必须返回恰好 ${source.slideCount} 个完整 slides。保持既定大纲顺序，不要省略任何页面，不要输出解释。`,
    };
    const retry = await requestDeckModel(config, retryPrompt, [], phaseProgress(emit, "story-compose-retry"));
    result = { value: retry.value, apiCalls: result.apiCalls + retry.apiCalls };
  }
  if (!hasExactSlideCount(result.value, source.slideCount)) {
    const returned = Array.isArray(result.value?.slides) ? result.value.slides.length : 0;
    throw new HttpError(502, `模型连续两次未返回指定的 ${source.slideCount} 个完整页面（当前 ${returned} 页）。`);
  }
  return {
    ok: true,
    deck: normalizeDeck(result.value, source),
    meta: {
      provider: config.provider,
      model: config.model,
      apiCalls: outlineResult.apiCalls + result.apiCalls,
      keySource: config.keySource,
      refinementApplied: true,
      planningMode: "outline-first",
    },
  };
}

async function generateHtmlDeckPayload(body, emit) {
  const config = normalizeTextConfig(body?.config || {});
  const notebook = compactNotebookForHtml(body?.deck);
  const draft = compactHtmlDraft(body?.draft);
  if (!notebook.slides.length || !draft.slides.length) throw new HttpError(400, "没有可用于 HTML 编排的演示内容。");
  emit?.({ type: "phase", phase: "html-layout", message: "安全初稿已显示，正在优化 HTML 对象与交互" });
  const prompt = buildHtmlDeckPrompt(notebook, draft, cleanDisplayText(body?.styleId, 80));
  const forwardProgress = phaseProgress(emit, "html-layout");
  let observedApiCalls = 0;
  const progress = forwardProgress ? (event) => {
    if (event?.type === "request") observedApiCalls += 1;
    forwardProgress(event);
  } : undefined;
  let result = { value: draft, apiCalls: 0 };
  let fallbackReason = "";
  try {
    result = config.provider === "openai"
      ? await requestOpenAIResponses(config, prompt, htmlDeckSchema, "html_deck", [], progress)
      : await requestChatCompletions(config, prompt, [], "html_deck", progress);
  } catch (error) {
    fallbackReason = cleanDisplayText(error instanceof Error ? error.message : "AI HTML 编排未完成", 500);
    result = { value: draft, apiCalls: Math.max(1, observedApiCalls) };
    console.warn("HTML layout enhancement skipped:", fallbackReason);
    emit?.({ type: "phase", phase: "html-layout", message: "AI 编排未完成，已保留可编辑的安全初稿，继续初始化编辑器" });
  }
  const exact = Array.isArray(result.value?.slides) && result.value.slides.length === notebook.slides.length;
  const designApplied = !fallbackReason && exact;
  const htmlDeck = designApplied ? result.value : draft;
  return {
    ok: true,
    deck: {
      ...htmlDeck,
      id: draft.id,
      title: notebook.title,
      width: 1600,
      height: 900,
      revision: Math.max(1, Number(draft.revision) || 1) + (exact ? 1 : 0),
      slides: htmlDeck.slides.map((slide, index) => ({ ...slide, sourceRefs: notebook.slides[index]?.sourceRefs || [] })),
      comments: [],
      drawings: [],
    },
    meta: { provider: config.provider, model: config.model, apiCalls: result.apiCalls, keySource: config.keySource, designApplied, fallbackReason },
  };
}

async function patchHtmlDeckPayload(body, emit) {
  const config = normalizeTextConfig(body?.config || {});
  const draft = compactHtmlDraft(body?.deck);
  const instruction = cleanDisplayText(body?.instruction, 4_000);
  const slideId = cleanDisplayText(body?.slideId, 120);
  const nodeId = cleanDisplayText(body?.nodeId, 120);
  if (!instruction || !slideId) throw new HttpError(400, "请提供修改要求和目标页面。");
  emit?.({ type: "phase", phase: "html-patch", message: "正在生成局部安全修改" });
  const prompt = buildHtmlPatchPrompt(draft, instruction, slideId, nodeId);
  const progress = phaseProgress(emit, "html-patch");
  const result = config.provider === "openai"
    ? await requestOpenAIResponses(config, prompt, htmlPatchSchema, "html_patch", [], progress)
    : await requestChatCompletions(config, prompt, [], "html_patch", progress);
  return {
    ok: true,
    summary: cleanDisplayText(result.value?.summary, 500),
    patches: normalizeHtmlPatches(result.value?.patches, draft),
    meta: { provider: config.provider, model: config.model, apiCalls: result.apiCalls, keySource: config.keySource },
  };
}

function phaseProgress(emit, phase) {
  return emit ? (event) => emit({ ...event, phase }) : undefined;
}

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
          bullets: Array.isArray(job?.bullets) ? job.bullets.map((item) => cleanDisplayText(item, 120)).filter(Boolean).slice(0, 5) : [],
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
    let apiCalls = 0;

    for (const job of jobs) {
      let prompt;
      const maxAttempts = config.maxRetries + 1;
      const fallbackBaseUrl = retryGatewayBase(config.baseUrl, imageApiFallbackBaseUrl);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const attemptBaseUrl = attempt > 1 && fallbackBaseUrl ? fallbackBaseUrl : config.baseUrl;
          const officialImageApi = isOfficialOpenAIBase(attemptBaseUrl);
          let response;
          if (!guideBytes && !references.length) {
            prompt = buildImagePrompt(job, guide, 0, "none");
            const generationBody = {
              model: config.model,
              prompt,
              size: imageOutputSize,
              quality: config.quality,
              ...(officialImageApi ? { output_format: "png" } : {}),
            };
            apiCalls += 1;
            response = await fetchWithTimeout(`${attemptBaseUrl}/images/generations`, {
              method: "POST",
              headers: { ...authHeaders(config), "Content-Type": "application/json" },
              body: JSON.stringify(generationBody),
            }, config.timeoutMs);
          } else {
            const form = new UndiciFormData();
            form.append("model", config.model);
            form.append("size", imageOutputSize);
            form.append("quality", config.quality);
            let referenceMode = "style-single";
            if (officialImageApi) {
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
            apiCalls += 1;
            response = await fetchWithTimeout(`${attemptBaseUrl}/images/edits`, {
              method: "POST",
              headers: authHeaders(config),
              body: form,
            }, config.timeoutMs);
          }
          const payload = await readJson(response);
          if (!response.ok) throw upstreamError(response.status, payload);
          const item = payload?.data?.[0];
          const url = await imageResultToDataUrl(item);
          if (!url) throw new HttpError(502, "Image 2 没有返回可用图片。");
          images.push({ slideIndex: job.slideIndex, url, prompt, revisedPrompt: item?.revised_prompt || "" });
          break;
        } catch (error) {
          const canRetry = attempt < maxAttempts && isRetryableImageError(error);
          if (canRetry) {
            await delay(Math.min(6_000, 1_500 * attempt));
            continue;
          }
          if (attempt > 1 && error instanceof HttpError) {
            const prefix = fallbackBaseUrl ? "备用网关重试后仍失败" : `已自动重试 ${attempt - 1} 次`;
            throw new HttpError(error.status, `${prefix}：${error.message}`);
          }
          throw error;
        }
      }
    }

    res.json({ ok: true, images, meta: { model: config.model, apiCalls, keySource: config.keySource } });
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

function normalizeTextConfig() {
  return finishConfig({
    provider: defaultApiProvider,
    baseUrl: textApiBaseUrl,
    model: textModel,
    allowNoKey: isLocalApiBase(textApiBaseUrl),
  });
}

function normalizeImageConfig(raw) {
  return finishConfig({
    provider: "openai",
    baseUrl: imageApiBaseUrl,
    model: imageModel,
    allowNoKey: isLocalApiBase(imageApiBaseUrl),
    quality: ["low", "medium", "high"].includes(raw.quality) ? raw.quality : "medium",
    timeoutMs: boundedInteger(raw.timeoutMs, 240_000, 900_000, configuredImageTimeoutMs),
    maxRetries: boundedInteger(raw.maxRetries, 0, 2, configuredImageMaxRetries),
  });
}

function finishConfig({ provider, baseUrl, model, allowNoKey, quality, timeoutMs, maxRetries }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  let parsedUrl;
  try { parsedUrl = new URL(normalizedBaseUrl); } catch { throw new HttpError(400, "API Base URL 格式不正确。"); }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new HttpError(400, "API Base URL 只支持 http 或 https。");
  const envKey = openAiApiKey;
  if (!allowNoKey && !envKey) throw new HttpError(400, "缺少系统环境变量 OPENAI_API_KEY。请在本机用户或计算机环境变量中设置后重启服务。");
  return {
    provider,
    baseUrl: normalizedBaseUrl,
    model: cleanText(model, 120),
    apiKey: envKey,
    keySource: envKey ? "environment" : "none",
    quality,
    timeoutMs,
    maxRetries,
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
    sourceBlocks: normalizeSourceBlocks(raw.sourceBlocks),
  };
}

function normalizeSourceBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  const allowedTypes = new Set(["heading", "paragraph", "table", "image", "notice"]);
  const allowedKinds = new Set(["docx", "pdf", "pptx", "xlsx", "text", "image"]);
  return raw.slice(0, 320).map((block) => {
    const source = block?.source || {};
    const blockId = cleanText(block?.id || source.blockId, 120);
    if (!blockId || !allowedTypes.has(block?.type)) return null;
    const rows = Array.isArray(block?.rows) ? block.rows.slice(0, 80).map((row) =>
      Array.isArray(row) ? row.slice(0, 20).map((cell) => cleanText(cell, 500)) : [],
    ).filter((row) => row.some(Boolean)) : undefined;
    return {
      id: blockId,
      type: block.type,
      text: cleanText(block?.text, 4_000),
      level: Number.isInteger(block?.level) ? Math.max(1, Math.min(9, block.level)) : undefined,
      rows,
      assetId: cleanText(block?.assetId, 120),
      source: {
        blockId,
        attachmentId: cleanText(source.attachmentId, 120),
        filename: cleanText(source.filename, 220) || "未命名材料",
        kind: allowedKinds.has(source.kind) ? source.kind : "text",
        extraction: source.extraction === "ocr" ? "ocr" : "native",
        page: positiveInteger(source.page),
        sectionPath: Array.isArray(source.sectionPath) ? source.sectionPath.map((item) => cleanText(item, 180)).filter(Boolean).slice(0, 9) : undefined,
        paragraphIndex: positiveInteger(source.paragraphIndex),
        tableIndex: positiveInteger(source.tableIndex),
        imageIndex: positiveInteger(source.imageIndex),
        confidence: Number.isFinite(Number(source.confidence)) ? Math.max(0, Math.min(100, Number(source.confidence))) : undefined,
        lowConfidence: Boolean(source.lowConfidence),
      },
    };
  }).filter(Boolean);
}

function positiveInteger(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : undefined;
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

function buildDeckOutlinePrompt(source) {
  const structuredMaterials = formatSourceBlocks(source.sourceBlocks);
  const imageList = source.images.map((image, index) => `图片 ${index + 1}: ${image.name}；${image.summary || "用户上传的内容参考"}`).join("\n");
  return {
    system: `你是演示文稿叙事规划师。先用轻量结构确定受众、核心主张、证据顺序和每页唯一任务，再由后续编辑器扩展完整文案。只返回 DECK_OUTLINE_JSON 对象；不要生成 subtitle、claim、bullets、speakerNotes、sourceNotes、imagePrompt 等完整页面字段。`,
    user: `主题：${source.topic}
受众：${source.audience}
页数：必须恰好 ${source.slideCount} 页

用户任务说明：
${source.textInput || "（请根据上传材料组织演示）"}

结构化材料：
${structuredMaterials || "（无结构化附件）"}

表格材料：
${source.tableInput || "（无）"}

图片线索：
${imageList || "（无）"}

请生成轻量叙事大纲：
1. story 只概括唯一核心主张、受众洞察、因果叙事弧和证据缺口。
2. slides 必须恰好 ${source.slideCount} 页，每页只返回 title、purpose、evidence、sourceBlockIds、visualAnchor。
3. title 是可直接展示的结论句；把所有 title 连读时必须形成不可打乱的因果论证，最后一页回答第一页并给出行动。
4. purpose 用一句短句说明本页在论证链中的职责；evidence 保留 1 到 3 条最关键的材料证据，不展开完整正文。
5. sourceBlockIds 只能引用材料中真实存在的 blockId；visualAnchor 只点名真实人物身份、项目、产品、作品、数据或场景，不写详细绘图提示词。
6. 不得编造材料中没有的数字、案例、品牌、客户、人物或产品界面。`,
  };
}

function buildDeckPrompt(source) {
  const system = `你是资深演示文稿策略师和信息设计师。先定义沟通任务：演示结束时，目标受众应该理解、相信、选择或行动什么，以及为什么。任务不是逐段总结材料，而是建立一条累积推进、可被证据支持的叙事链。每页只承担一个论证任务，标题必须是受众能直接理解的观点。上一页提出的问题必须由下一页回答或推进，开场建立问题与价值，结尾必须解决开场并给出结论、决策或行动。不得编造数字、案例、来源和用户没有提供的表格。

所有可见文案只能面向演示受众，禁止泄露制作过程、模型指令和内部脚手架。除非用户材料本身明确讨论这些概念，否则不要出现 DeckSpec、Image 2、API、提示词、工作流、如何生成 PPT、页面组装、视觉拆解等生产术语。图片只是证据和视觉参考，不要从图片中臆测看不清的信息。严格输出 JSON。`;
  const imageList = source.images.map((image, index) => `图片 ${index + 1}: ${image.name}；${image.summary || "用户上传的内容参考"}`).join("\n");
  const styleLabel = source.styleId === "blank" ? "未指定，使用空白模板" : styleGuides[source.styleId].label;
  const structuredMaterials = formatSourceBlocks(source.sourceBlocks);
  const user = `主题：${source.topic}\n受众：${source.audience}\n页数：必须恰好 ${source.slideCount} 页，不得少页、补占位页或额外增加附录\n选定风格：${styleLabel}\n\n用户任务说明：\n${source.textInput || "（请根据上传材料组织演示）"}\n\n结构化材料（blockId 是唯一可引用证据标识）：\n${structuredMaterials || "（无结构化附件）"}\n\n兼容表格输入：\n${source.tableInput || "（无，禁止自行创建表格内容）"}\n\n图片使用说明：\n${source.imageBrief || "（无）"}\n${imageList || "（未上传图片）"}\n\n先在 story 中给出唯一核心主张、受众洞察、完整叙事弧和证据缺口，再生成恰好 ${source.slideCount} 页。整套页面必须形成连续链条：第 1 页建立核心问题或判断；中间页面依次给出背景、机制、证据、影响或方案，每页都承接上一页并为下一页制造必要性；最后 1 页解决开场问题并收束为明确结论或行动。不要把同一个观点换词重复。speakerNotes 可以记录“承接上一页”和“引向下一页”的过渡逻辑，但这些制作说明不能进入可见标题、正文或图片文案。

每页 sourceBlockIds 只能填写上面实际存在的 blockId；sourceNotes 写成可读出处，例如“report.pdf，第 12 页”或“strategy.docx，章节：市场分析，表格 2”。没有附件依据时两个数组都为空。低置信度 OCR 只能作为待核实线索，不得把其中数字写成确定事实。

imageIndex 只引用从 1 开始的用户图片序号，没有合适图片时为 null。visualBrief 描述该页要用什么视觉证据支持当前观点；imagePrompt 只描述与当前页面直接相关的主体、场景、数据关系和视觉隐喻，不规定有字或无字，最终文字呈现由后续模式决定。`;
  const qualityRules = `【成片级内容约束】
1. 先在内部完成“受众要改变什么看法 -> 需要什么证据 -> 每页如何推进”的推演，再输出 JSON；不要把素材按段落平均切页。
2. 每页标题必须是结论句而不是栏目名。把所有 slides.title 按顺序单独读出来时，必须像一段完整、不可打乱的论证：上一句提供前提，下一句回答问题或推出后果。相邻页面必须构成因为、所以、但是、因此或下一步的关系，删除换词重复。
3. 可见文案要达到高信息密度演示页：主标题尽量不超过 24 个汉字且最多两行，subtitle 不超过 34 个汉字，claim 不超过 48 个汉字；正文页提供 3 到 5 个 bullets，每条尽量不超过 22 个汉字，封面或章节页可适当减少。每个 bullet 必须补充新的证据、机制、对比或含义，不能换词重复标题。更长解释放入 speakerNotes。
4. 三页演示严格使用“定义关键判断 -> 给出机制或证据 -> 推导结论与下一步”；更多页数则在中间增加必要的背景、机制、证据、对比、方案和影响，不得增加空泛过渡页。
5. visualBrief 必须说明哪一种可见证据能证明本页观点。imagePrompt 必须写清主体、动作、环境、视觉隐喻、与文字发生关系的位置，以及贯穿全套的连续视觉母题；禁止只写科技感、未来感、高级感等空泛形容词。
6. story.narrativeArc 要概括“起点认知 -> 新证据 -> 推导 -> 受众行动”的因果路径；每页 speakerNotes 必须分别写明“承接了什么、证明了什么、下一页为什么必要”。
7. 除非用户给出表格数据，否则不要创建表格。数据页应优先提炼一个关键数字、一个趋势或一个对比，而不是把整张电子表格照搬进画面。
8. 先识别材料中的真实主角和内容锚点，例如人物、产品、项目、组织、地点、行业对象、作品或实验对象。每页 visualBrief 和 imagePrompt 至少绑定一个本页材料里真实出现的锚点，并说明它如何证明标题；不得用“机器人、发光大脑、抽象 AI 芯片、握手、火箭、假仪表盘”等通用符号替代具体内容，除非材料本身明确要求。
9. 如果材料是个人履历、作品集或人物介绍，视觉必须围绕此人的真实专业身份、项目产物、工作环境和能力证据展开，不能擅自生成陌生人物肖像；如果材料是产品或项目，优先表现真实使用场景、结构、流程和结果，不得编造 UI、设备、客户或品牌。
10. 为整套演示定义一个可复用的视觉连续性描述，并写入每页 imagePrompt：同一主角或对象身份、同一时代与环境、同一材质和光线、同一色彩系统、同一镜头语言。每页改变的是论证状态和动作，不是重新换一套无关题材。`;
  return { system, user: `${user}\n\n${qualityRules}` };
}

function formatSourceBlocks(blocks) {
  return blocks.map((block) => {
    const source = block.source;
    const location = [
      source.page ? `第 ${source.page} 页` : "",
      source.sectionPath?.length ? `章节：${source.sectionPath.join(" > ")}` : "",
      source.tableIndex ? `表格 ${source.tableIndex}` : "",
      source.imageIndex ? `图片 ${source.imageIndex}` : "",
      source.extraction === "ocr" ? `OCR${source.confidence !== undefined ? ` ${Math.round(source.confidence)}%` : ""}${source.lowConfidence ? "，低置信度" : ""}` : "",
    ].filter(Boolean).join("，");
    const content = block.type === "table"
      ? (block.rows || []).map((row) => row.join(" | ")).join("\n")
      : block.type === "image" ? `图片素材${block.assetId ? `（assetId: ${block.assetId}）` : ""}` : block.text;
    return `[blockId: ${block.id}] [来源：${source.filename}${location ? `，${location}` : ""}] [类型：${block.type}]\n${content || "（无文字内容）"}`;
  }).join("\n\n").slice(0, 48_000);
}

function sourceReferenceLabel(source) {
  const location = [
    source.page ? `第 ${source.page} 页` : "",
    source.sectionPath?.length ? `章节：${source.sectionPath.join(" > ")}` : "",
    source.tableIndex ? `表格 ${source.tableIndex}` : "",
    source.imageIndex ? `图片 ${source.imageIndex}` : "",
    source.extraction === "ocr" ? `OCR${source.confidence !== undefined ? ` ${Math.round(source.confidence)}%` : ""}${source.lowConfidence ? "，低置信度，待核实" : ""}` : "",
  ].filter(Boolean);
  return `${source.filename}${location.length ? `，${location.join("，")}` : ""}`;
}

function buildDeckFromOutlinePrompt(source, outline) {
  const sourceSummary = {
    topic: source.topic,
    audience: source.audience,
    slideCount: source.slideCount,
    textInput: source.textInput.slice(0, 14_000),
    tableInput: source.tableInput.slice(0, 6_000),
    sourceBlocks: compactSourceBlocksForRefinement(source.sourceBlocks),
    imageBrief: source.imageBrief,
    images: source.images.map((image) => ({ name: image.name, summary: image.summary })),
  };
  return {
    system: `你是顶级演示文稿总编辑和视觉创意总监。你收到原始材料和一份已经锁定页序的轻量叙事大纲，需要一次性扩展为完整 DeckSpec。保留大纲的因果结构，在不虚构事实的前提下补齐可见文案、讲稿、来源和图像模型可执行的艺术导演意图。只返回严格 JSON。`,
    user: `原始材料：\n${JSON.stringify(sourceSummary)}\n\n轻量叙事大纲：\n${JSON.stringify(outline)}\n\n请返回完整 DeckSpec，并严格满足：
1. slides 必须恰好 ${source.slideCount} 页，保留所有有来源的关键事实，不得新增数字、案例、品牌或结论。
2. 每页只推进一个判断，标题直接说结论；把所有标题连读时必须形成一段完整的因果论证，任意交换两页都会破坏逻辑。上一页建立的认知必须成为下一页的前提，最后一页必须回答第一页并给出受众可执行的结论。
3. 删除重复观点和同义改写。${source.slideCount === 3 ? "三页分别承担：关键判断、机制或证据、由证据推出的结论与下一步。第二页必须证明第一页，第三页必须由第二页推出。" : "中间页只保留完成论证真正需要的背景、机制、证据、对比、方案或影响，并按认知依赖排序。"}
4. 为高信息密度演示页面组织可见文字：title 尽量不超过 24 个汉字且最多两行，subtitle 不超过 34 个汉字，claim 不超过 48 个汉字；正文页保留 3 到 5 条 bullets，每条尽量不超过 22 个汉字。每条必须承担不同证据、步骤、能力或影响，不能重复标题。长解释移入 speakerNotes。
5. 每页 imagePrompt 都必须包含：与观点直接相关的主体、正在发生的动作、环境、可视化关系或隐喻、文字与主体穿插的构图机会、贯穿全套的连续视觉母题。禁止写成普通左文右图、卡片墙、白底信息框或模板化商务页面。
6. speakerNotes 必须用“承接 -> 本页证明 -> 下一页必要性”的顺序说明过渡。story.narrativeArc 必须与最终页面顺序一致。可见标题和正文不得出现 DeckSpec、Image 2、API、提示词、PPT 制作流程或内部工作流。
7. 保留并校正每页 sourceBlockIds：只能引用原始材料中存在的 blockId；sourceNotes 必须与所选 blockId 的页码、章节、表格或图片位置一致。低置信度 OCR 内容必须标记待核实。
8. 逐页检查 visualBrief 和 imagePrompt：必须点名本页材料中的真实人物身份、产品、项目、组织、地点、行业对象、作品或实验对象，并说明该对象如何证明标题。没有材料依据时不要编造人物肖像、产品界面、客户、设备或数字。
9. 删除泛化视觉捷径。除非原材料明确出现，否则禁止机器人、类人 AI、发光大脑、抽象芯片、握手、火箭、漂浮屏幕、假仪表盘和无意义科技图标。个人履历或作品集要围绕真实专业角色、项目产物和工作场景；产品材料要围绕真实任务、流程和结果。
10. 每页 imagePrompt 都要复述同一套视觉连续性：固定主角或核心对象身份、环境、材质、主辅色、光线方向和镜头语言；只让动作、状态和证据随叙事推进。`,
  };
}

function compactSourceBlocksForRefinement(blocks) {
  const result = [];
  let budget = 24_000;
  for (const block of blocks) {
    const compact = {
      id: block.id,
      type: block.type,
      source: block.source,
      text: block.text?.slice(0, 1_500),
      rows: block.rows?.slice(0, 20).map((row) => row.slice(0, 10)),
    };
    const size = JSON.stringify(compact).length;
    if (size > budget) break;
    result.push(compact);
    budget -= size;
  }
  return result;
}

function buildHtmlDeckPrompt(notebook, draft, styleId) {
  return {
    system: `你是代码驱动演示文稿的设计架构师。请把已经完成内容策划的 DeckSpec 重构为可编辑、可交互的 HtmlDeckSpec。你设计的是 1600×900 的 16:9 网页演示，不是 PPT 截图，也不是营销落地页。所有文字、图形、图表、图片槽和互动部件必须是独立对象，坐标使用 0 到 1。只返回严格 JSON。`,
    user: `内容 DeckSpec：\n${JSON.stringify(notebook)}\n\n可用的安全初稿：\n${JSON.stringify(draft)}\n\n风格 ID：${styleId || "blank"}\n\n请返回完整 HtmlDeckSpec，并遵守：
1. slides 必须恰好 ${notebook.slides.length} 页，id 与初稿对应页面保持一致；所有可见文字必须来自内容 DeckSpec，不得虚构事实、数字或品牌。
2. 每页使用 4 到 14 个独立节点。标题、正文、关键数字、图形、图表和图片必须分别建模；不要用一个巨型文本节点模拟整页。
3. 坐标必须位于 0 到 1，且 x+w≤1、y+h≤1。所有关键内容位于 x=0.05..0.95、y=0.06..0.94；节点不能大面积互相遮挡。
4. 视觉层级要像设计竞赛或高质量作品集：一个明确焦点，一条阅读路径，统一对齐基线，避免卡片墙、白色页面套框和通用 SaaS 仪表盘。
5. 有真实表格或数据时使用 chart 节点，chartType 从 bar、line、pie、scatter、radar 中选择。不得为无数据页面编造图表。
6. 初稿中的 image 节点代表已生成或上传素材。保留 image 节点的 id、assetId 和 prompt，只能调整位置、尺寸和 objectFit；src 必须保持为空字符串，真实图片由本地资源层按稳定标识回填；不要编造网络 URL。
7. 每页至少包含一个轻量动画。交互只使用 next、previous、toggle、highlight、set-variable 或 animate，默认空白处点击翻到下一页。
8. variables 提供 3 到 8 个真正有用的微调参数，至少保留 primary-color、accent-color 和 motion-enabled。comments 与 drawings 必须为空数组。
9. fontSize 使用适合 1600×900 画布的像素值：标题 34–72，正文 16–28，说明 12–18。中文字体效果清楚，所有颜色使用六位十六进制。
10. speakerNotes 保留内容草案中的讲稿逻辑。不要输出 HTML、CSS、JavaScript、Markdown 或解释。`,
  };
}

function buildHtmlPatchPrompt(deck, instruction, slideId, nodeId) {
  const targetSlide = deck.slides.find((slide) => slide.id === slideId);
  const targetNode = nodeId ? targetSlide?.nodes.find((node) => node.id === nodeId) : null;
  return {
    system: `你是交互式 HTML 演示的精修编辑器。你只能返回结构化 Patch，不能输出 HTML、CSS、JavaScript 或解释。所有修改必须保持事实不变，保留稳定 slideId/nodeId，并尽可能缩小影响范围。changesJson 必须是可被 JSON.parse 解析的 JSON 对象字符串。`,
    user: `用户要求：${instruction}\n\n目标页面：${slideId}\n目标节点：${nodeId || "未指定，允许修改当前页多个相关节点"}\n\n当前页面：\n${JSON.stringify(targetSlide || {})}\n\n选中节点：\n${JSON.stringify(targetNode || {})}\n\n整套页面顺序：\n${deck.slides.map((slide, index) => `${index + 1}. ${slide.id} — ${slide.title}`).join("\n")}\n\n规则：
1. 选中节点存在时，默认只返回一个 update-node Patch；只有用户明确要求联动时才修改其他节点。
2. update-node 的 changesJson 只能包含节点可编辑字段，例如 text、x、y、w、h、zIndex、animation、style、chartType、labels、series、fill、stroke、opacity、props。
3. update-slide 只能修改 title、background、transition 或 speakerNotes。
4. add-node 只用于新增 text、shape、chart 或 widget，changesJson 格式为 {"node":完整节点对象}；禁止新增 image、video 或任何 URL。
5. remove-node 只在用户明确要求删除时使用，changesJson 返回 {}。
6. 跨页移动或重排使用 reorder-slides，changesJson 格式为 {"order":["slide-1","slide-3","slide-2"]}，必须包含当前所有 slideId 且不能重复。
7. 坐标使用 0 到 1；颜色使用六位十六进制；不得加入脚本、事件处理器、URL 或未知字段。`,
  };
}

function normalizeHtmlPatches(raw, deck) {
  if (!Array.isArray(raw)) return [];
  const slideIds = new Set(deck.slides.map((slide) => slide.id));
  return raw.slice(0, 40).map((patch) => {
    const slideId = cleanDisplayText(patch?.slideId, 120);
    const nodeId = cleanDisplayText(patch?.nodeId, 120);
    const operation = ["update-node", "add-node", "update-slide", "remove-node", "reorder-slides"].includes(patch?.operation) ? patch.operation : "update-node";
    if (!slideIds.has(slideId)) return null;
    let changes = {};
    try { changes = JSON.parse(String(patch?.changesJson || "{}")); } catch { return null; }
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
    return { slideId, nodeId: nodeId || undefined, operation, changes };
  }).filter(Boolean);
}

function compactNotebookForHtml(raw) {
  const slides = Array.isArray(raw?.slides) ? raw.slides.slice(0, 50).map((slide, index) => ({
    id: cleanDisplayText(slide?.id, 120) || `slide-${index + 1}`,
    title: cleanDisplayText(slide?.title, 180),
    subtitle: cleanDisplayText(slide?.subtitle, 240),
    claim: cleanDisplayText(slide?.claim, 320),
    bullets: Array.isArray(slide?.bullets) ? slide.bullets.map((item) => cleanDisplayText(item, 180)).filter(Boolean).slice(0, 6) : [],
    layout: cleanDisplayText(slide?.layout, 60),
    tableRows: Array.isArray(slide?.tableRows) ? slide.tableRows.slice(0, 12).map((row) => Array.isArray(row) ? row.slice(0, 8).map((cell) => cleanDisplayText(cell, 100)) : []) : [],
    callouts: Array.isArray(slide?.callouts) ? slide.callouts.slice(0, 4).map((item) => ({ label: cleanDisplayText(item?.label, 80), value: cleanDisplayText(item?.value, 80) })) : [],
    speakerNotes: cleanDisplayText(slide?.speakerNotes, 2_000),
    sourceNotes: Array.isArray(slide?.sourceNotes) ? slide.sourceNotes.map((item) => cleanDisplayText(item, 240)).filter(Boolean).slice(0, 5) : [],
    sourceRefs: compactSourceRefs(slide?.sourceRefs),
  })) : [];
  return {
    title: cleanDisplayText(raw?.title, 180) || "未命名交互演示",
    theme: cleanDisplayText(raw?.theme, 80),
    story: {
      thesis: cleanDisplayText(raw?.story?.thesis, 500),
      audienceInsight: cleanDisplayText(raw?.story?.audienceInsight, 500),
      narrativeArc: Array.isArray(raw?.story?.narrativeArc) ? raw.story.narrativeArc.map((item) => cleanDisplayText(item, 140)).filter(Boolean).slice(0, 12) : [],
    },
    slides,
  };
}

function compactHtmlDraft(raw) {
  const slides = Array.isArray(raw?.slides) ? raw.slides.slice(0, 50).map((slide, slideIndex) => ({
    id: cleanDisplayText(slide?.id, 120) || `slide-${slideIndex + 1}`,
    title: cleanDisplayText(slide?.title, 180),
    background: cleanDisplayText(slide?.background, 80) || "#f8f8f4",
    transition: ["none", "fade", "slide", "zoom"].includes(slide?.transition) ? slide.transition : "fade",
    nodes: Array.isArray(slide?.nodes) ? slide.nodes.slice(0, 40).map((node, nodeIndex) => ({
      ...node,
      id: cleanDisplayText(node?.id, 120) || `slide-${slideIndex + 1}-node-${nodeIndex + 1}`,
      name: cleanDisplayText(node?.name, 160) || `对象 ${nodeIndex + 1}`,
      ...(node?.type === "image" ? { src: "", prompt: cleanDisplayText(node?.prompt, 1_200), alt: cleanDisplayText(node?.alt, 300) } : {}),
      ...(node?.type === "video" ? { src: "", poster: "" } : {}),
    })) : [],
    interactions: Array.isArray(slide?.interactions) ? slide.interactions.slice(0, 40) : [],
    speakerNotes: cleanDisplayText(slide?.speakerNotes, 2_000),
    sourceRefs: compactSourceRefs(slide?.sourceRefs),
  })) : [];
  return {
    id: cleanDisplayText(raw?.id, 120) || `html-deck-${Date.now()}`,
    title: cleanDisplayText(raw?.title, 180) || "未命名交互演示",
    width: 1600,
    height: 900,
    revision: Math.max(1, Number(raw?.revision) || 1),
    theme: raw?.theme || { name: "清晰咨询", background: "#f8f8f4", surface: "#ffffff", text: "#111820", muted: "#667078", primary: "#0e6cff", accent: "#e74c36", fontFamily: "Microsoft YaHei, sans-serif" },
    slides,
    variables: Array.isArray(raw?.variables) ? raw.variables.slice(0, 20) : [],
    comments: [],
    drawings: [],
  };
}

function compactSourceRefs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map((source) => ({
    blockId: cleanDisplayText(source?.blockId, 120),
    attachmentId: cleanDisplayText(source?.attachmentId, 120),
    filename: cleanDisplayText(source?.filename, 220),
    kind: ["docx", "pdf", "pptx", "xlsx", "text", "image"].includes(source?.kind) ? source.kind : "text",
    extraction: source?.extraction === "ocr" ? "ocr" : "native",
    page: positiveInteger(source?.page),
    sectionPath: Array.isArray(source?.sectionPath) ? source.sectionPath.map((item) => cleanDisplayText(item, 180)).filter(Boolean).slice(0, 9) : undefined,
    paragraphIndex: positiveInteger(source?.paragraphIndex),
    tableIndex: positiveInteger(source?.tableIndex),
    imageIndex: positiveInteger(source?.imageIndex),
    confidence: Number.isFinite(Number(source?.confidence)) ? Math.max(0, Math.min(100, Number(source.confidence))) : undefined,
    lowConfidence: Boolean(source?.lowConfidence),
  })).filter((source) => source.blockId && source.filename);
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
  if (job.textMode === "native") return buildNativeTextImagePrompt(job, guide, referenceInstruction);
  const integratedJob = {
    ...job,
    deckTitle: job.pageNumber === 1 ? job.deckTitle : "",
    subtitle: job.subtitle,
    bullets: job.bullets.slice(0, 5),
    callouts: job.callouts.slice(0, 3),
  };
  return buildIntegratedTextImagePrompt(integratedJob, guide, referenceInstruction);
}

function buildIntegratedTextImagePrompt(job, guide, referenceInstruction) {
  const page = `${String(job.pageNumber).padStart(2, "0")}/${String(job.totalPages).padStart(2, "0")}`;
  const bullets = job.bullets.slice(0, 5).map((item, index) => `${index + 1}. ${item}`).join("\n") || "（无）";
  const callouts = job.callouts.slice(0, 3).map((item) => `${item.label}：${item.value}`).join("；") || "（无）";
  const table = job.tableRows.length ? job.tableRows.slice(0, 4).map((row) => row.slice(0, 3).join(" | ")).join("\n") : "（无）";
  const archetype = imagePageArchetype(job.layout, job.pageNumber);
  return `画一个完整协调、无边框、全画布的 16:9 高信息密度 PowerPoint 成品页面，用于第 ${job.pageNumber} 页。第一眼必须明确看出这是经过专业信息设计的演示页，而不是电影海报、广告 KV、游戏宣传图或一张铺满文字的插画。背景、主视觉、光影、文字、数据和解释性标注必须属于同一个连续画面，不得把幻灯片画成白色纸张、相框或嵌套在另一张背景图中的矩形。页面使用不可见的演示文稿网格组织标题、主场景、三到五项证据、数据与页码；信息丰富，但每块内容都必须服务于同一个观点。\n\n【整套叙事位置】\n${buildSequenceContext(job)}\n\n【页面文案，必须逐字呈现，不得改写、翻译或虚构】\n演示名称：${job.deckTitle || "（不显示）"}\n主标题：${job.title}\n副标题：${job.subtitle || "（无）"}\n核心句：${job.claim || "（无）"}\n短要点：\n${bullets}\n数据标注：${callouts}\n表格数据：\n${table}\n页码：${page}\n\n【内容与构图任务】\n${job.prompt}\n页面原型：${archetype}\n布局线索：${job.layout || "visual-right"}。\n${referenceInstruction}\n整体审美方向：${guide.direction}。\n\n【图文融合规则】\n1. 使用高信息密度 PPT 层级：顶部或上侧给出最多两行的结论标题，随后是副标题或核心解释句；围绕主视觉安排三到五个互不重复的证据点、步骤、能力、对比或影响，并允许一到两个关键数字或数据标注。阅读顺序必须是“结论 -> 主视觉 -> 分项证据 -> 含义或行动”。\n2. 背景与主视觉必须连续铺满整张画布，在内部使用低细节区域、透视线、半透明信息层和负空间承载文字，不在画布四周绘制可见页边框。可以使用两到四个内部证据模块、流程节点、图表、局部特写或标注区，但这些模块要直接依附于场景和统一网格，不能把整张幻灯片套进相框、白纸页面或第二层画布。\n3. 保留一个明确主视觉，并增加两到四种有内容依据的辅助信息形态，例如趋势图、关键数字、流程节点、能力标签、局部放大、状态对比或因果箭头。优先复用上面提供的 bullets、callouts 和表格数据；禁止为了显得丰富而编造数据、堆叠无关图标或生成无意义小字。\n4. 文字密度向高质量技术路演、咨询分析和竞赛答辩页面看齐。标题字号最大，核心句次之，证据点和数据标注使用清楚的小一级字体；可使用细分隔线、图标、低透明底色或局部暗角增强阅读，但不能形成整页外框、框中框或机械重复的卡片墙。\n5. 只使用上面提供的文字。没有提供的品牌、统计数字、按钮、网址、免责声明和伪界面文案一律不要生成。禁止从风格参考图中抄写任何文字。除非本页文案明确包含，否则严禁出现 DeckSpec、Image 2、API、Prompt、工作流、生成 PPT、视觉拆解、页面组装等制作过程内容。若空间不足，优先完整呈现主标题、核心句、三个最重要要点、关键数字和页码，不得自行缩写或编造。\n6. 中文使用清晰、粗壮、现代的简体中文字体效果，笔画完整；数字和英文保持准确。小字号仍需高对比和足够字重，不要出现乱码、随机字符、[object Object] 或无意义占位文字。\n7. 风格参考图只用于学习色彩、材质、字体气质、信息密度和图文层级，不要复制其中的题材、品牌、边框和巨型标题比例。目标是把“结论 + 主视觉 + 多项证据 + 含义”融合为一个完整页面。\n8. 整张图就是幻灯片本身，不要画投影幕、电脑屏幕、PPT 编辑器边框、白色纸张、双层画布或页面外环境。背景必须自然延伸到四条边。所有文字、人物头部、机械主体、图表、图标和关键标注必须完整位于 x=7% 到 93%、y=10% 到 88% 的不可见安全区内；任何字形、页码或主体都不得接触或越过画布边缘。最上方 10% 和最下方 12% 只允许连续背景或可安全延展的纹理。`;
}

function buildNativeTextImagePrompt(job, guide, referenceInstruction) {
  const visualSide = job.layout === "visual-left" ? "主体靠左构图" : "主体靠右构图";
  return `画一个用于 PowerPoint 第 ${job.pageNumber}/${job.totalPages} 页的高质量独立主视觉资产。它不是整页 PPT、不是带文字的信息图、不是界面截图，而是一张可以在 PowerPoint 中单独移动、缩放和裁切的视觉图片。\n\n【整套叙事位置】\n${buildSequenceContext(job)}\n\n【当前页视觉任务】\n${job.prompt}\n\n【内容锚定规则】\n先从当前页任务中识别真实主角或核心对象，例如人物的专业身份、具体产品、项目产物、组织、地点、行业对象、作品或实验对象。画面必须让这个真实锚点成为视觉焦点，并用动作、空间关系、前后状态或结果证明本页观点。个人履历或作品集不得擅自生成陌生人物肖像，应优先表现真实专业角色、项目产物和工作场景；产品或项目材料不得编造界面、设备、客户和品牌。除非材料明确出现，否则禁止机器人、类人 AI、发光大脑、抽象芯片、握手、火箭、漂浮屏幕、假仪表盘和无意义科技图标。\n\n构图要求：${visualSide}，主体完整，轮廓清楚，背景简洁且容易与页面底色融合；为页面另一侧的原生标题、正文、表格和形状留出呼吸空间。\n${referenceInstruction}\n整体审美方向：${guide.direction}。\n\n根据内容选择真实摄影、高质量 3D、科学可视化或简洁概念场景，必须有一个明确主体和清晰视觉焦点。与整套其他页面保持同一主角或核心对象身份、时代与环境、色彩系统、材质、光线方向和镜头语言；只让动作、状态与证据随叙事推进，不能每页换成无关题材。当前画面必须服务于这一页独有的论证任务。禁止生成任何可读文字、字母、数字、标志、水印、表格、卡片墙、按钮、伪界面文案、[object Object] 或 PPT 制作流程。不要画投影幕、电脑屏幕、PPT 编辑器边框或页面外环境。`;
}

function buildIntegratedArtDirection(job) {
  const role = narrativeRole(job.pageNumber, job.totalPages);
  const bridge = job.previousSlideTitle
    ? `把上一页“${job.previousSlideTitle}”留下的认知转化为本页画面的起点`
    : "用一个瞬间可懂的强场景建立整套演示的核心冲突与期待";
  const exit = job.nextSlideTitle
    ? `并用视线、动作、路径或未完成的视觉关系自然引向下一页“${job.nextSlideTitle}”`
    : "并让最终画面形成明确闭环与可执行的结束感";
  return [
    `本页叙事角色：${role}。${bridge}，${exit}。`,
    "用不可见对齐网格和内部负空间安排标题、视觉证据与解释；背景与主视觉必须自然延伸到四边，严禁可见页框、白色纸张、相框、框中框、卡片墙、仪表盘外壳和 SaaS 界面拼贴。",
    "标题与视觉通过对齐、留白、视线、动作方向或因果轴建立联系；可以有轻微的前后景穿插，但任何主体都不得遮挡完整字形，任何文字都不得触碰画布边缘。",
    "画面保留一个主视觉焦点和一条清楚的主阅读路径。主标题先给结论，主视觉负责证明，三到五个短证据点分别解释机制、步骤、对比、能力或影响；证据点可以分布在场景周围，但必须共同服务于同一个结论。不要把整页做成只有大标题和氛围图的电影海报。",
    job.tableRows.length
      ? "把表格提炼成一到两个关键对比、趋势或数量关系并嵌入场景，配合三到五个解释点形成证据链，不要照搬电子表格式网格。"
      : "辅助信息使用三到五个有实质内容的标注、流程节点、能力标签、局部数据或状态对比；它们应依附于主场景和统一网格，不要堆叠无关面板。",
    "整套页面共享同一主体身份、环境、色彩、字体气质、标题基线、图标线宽、页码位置和连续视觉母题；下一页要像同一场景或同一系统状态的自然推进，而不是重新生成一张无关插画。把所有页缩略图并排时必须显然属于同一套 PPT。",
  ].join("\n");
}

function narrativeRole(pageNumber, totalPages) {
  if (pageNumber === 1) return "开场定题，用一个清楚判断建立冲突、价值与观看期待";
  if (pageNumber === totalPages) return "结论收束，回答第一页并把证据推导为决定或下一步";
  if (totalPages === 3) return "核心证明，用机制、证据或因果关系支撑第一页的判断";
  if (pageNumber === 2) return "问题深化，解释为什么旧认知或当前状态不足";
  if (pageNumber === totalPages - 1) return "综合推导，把前面证据汇聚为方案、影响或选择";
  return "论证推进，只增加一项完成整套推理不可缺少的新证据或机制";
}

function buildSequenceContext(job) {
  return [
    `整套核心主张：${job.deckThesis || job.deckTitle}`,
    `受众需要：${job.audienceInsight || "理解当前观点并知道下一步"}`,
    `叙事弧：${job.narrativeArc.join(" → ") || "问题 → 证据 → 结论"}`,
    `上一页：${job.previousSlideTitle || "这是开场页，需要建立问题与期待"}`,
    `当前页：${job.title}`,
    `下一页：${job.nextSlideTitle || "这是收束页，需要解决开场并给出结论或行动"}`,
    "逻辑桥接要求：把上一页的结论当作本页前提；本页只增加一项新的证据、机制、比较或决定；下一页必须依赖本页新增的信息才能成立。把上一页、当前页、下一页三个标题连读时，应像连续三句话而不是三个并列主题。不得重复上一页，也不得提前讲完下一页。",
    ...(job.textMode === "integrated" ? ["本页艺术导演指令：", buildIntegratedArtDirection(job)] : []),
  ].join("\n");
}

function imagePageArchetype(layout, pageNumber) {
  if (layout === "cover" || pageNumber === 1) return "全画布演示封面：标题最多两行，稳定落在不可见安全区内；一个英雄主体或关键场景建立主题，副标题与价值句直接融入同一画面，不绘制任何页框或内嵌画布。";
  if (layout === "section") return "章节转折：一个短结论配一个核心视觉，用大面积留白改变节奏；标题与主体完整可见，不使用密集信息模块。";
  if (layout === "takeaway") return "结论收束：清楚的结论标题、一个证明性或象征性主视觉、三个证据摘要与一到两项行动；视觉方向把前页推理收束到最终决定。";
  if (layout === "visual-left") return "左侧证据页：主视觉占左侧约 50%，右侧用结论标题、核心句和三到五个证据点完成解释；关键数字、局部标注或短流程直接依附于主场景，不绘制整页外框。";
  if (layout === "visual-right") return "右侧证据页：标题与核心句在左侧形成清楚层级，右侧主视觉负责证明；围绕视觉安排三到五个证据点以及一到两个关键数字，背景和光影贯穿全画布，不绘制可见页框。";
  return "高信息密度证据页：顶部或左侧给出结论标题，一个主视觉占 45% 到 60%，三到五个短证据点、一个关键数字或小型关系图补足论证；所有内容遵循同一演示网格，不做满屏电影海报。";
}

function buildDecompositionPrompt(images) {
  return {
    system: "你是演示文稿视觉拆解器。请分析每张生成图的构图，不做内容改写。所有坐标使用 0 到 1 的归一化值。",
    user: `依次分析所附的 ${images.length} 张图片，对应 slideIndex：${images.map((item) => item.slideIndex).join(", ")}。为每张图返回：1) composition，一句话说明构图；2) safeArea，可叠加原生文字的最大低细节矩形；3) parts，最多三个值得独立裁出的主体区域。裁剪框必须在画布内，不能过小，尽量不重叠。parts 的 role 使用 hero、evidence、detail 或 texture。不要把文字区域作为视觉部件。`,
  };
}

function requestDeckModel(config, prompt, images = [], onProgress) {
  return config.provider === "openai"
    ? requestOpenAIResponses(config, prompt, deckSchema, "deck_spec", images, onProgress)
    : requestChatCompletions(config, prompt, images, "deck_spec", onProgress);
}

function requestDeckOutlineModel(config, prompt, images = [], onProgress) {
  return config.provider === "openai"
    ? requestOpenAIResponses(config, prompt, deckOutlineSchema, "deck_outline", images, onProgress)
    : requestChatCompletions(config, prompt, images, "deck_outline", onProgress);
}

async function requestOpenAIResponses(config, prompt, schema, schemaName, images = [], onProgress) {
  const timeoutMs = schemaName === "image_decomposition" ? 60_000 : 150_000;
  assertModelTextInputWithinLimit(prompt);
  const userContent = [{ type: "input_text", text: prompt.user }];
  images.forEach((image) => {
    userContent.push({ type: "input_text", text: `附件：${image.name}${image.summary ? `；${image.summary}` : ""}` });
    userContent.push({ type: "input_image", image_url: image.dataUrl, detail: "high" });
  });
  const requestBody = {
    model: config.model,
    input: [
      { role: "system", content: [{ type: "input_text", text: prompt.system }] },
      { role: "user", content: userContent },
    ],
    text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    ...(onProgress ? { stream: true } : {}),
  };
  onProgress?.({ type: "request", message: "模型请求已发送" });
  const response = await fetchWithTimeout(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: { ...authHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  }, timeoutMs);
  if (onProgress) {
    if (!response.ok) throw upstreamError(response.status, await readJson(response));
    const text = await readResponsesStream(response, onProgress);
    return { value: parseModelJson(text), apiCalls: 1 };
  }
  const payload = await readJson(response);
  if (!response.ok) throw upstreamError(response.status, payload);
  return { value: parseModelJson(extractResponseText(payload)), apiCalls: 1 };
}

async function requestChatCompletions(config, prompt, images = [], schemaName = "deck_spec", onProgress) {
  const timeoutMs = schemaName === "image_decomposition" ? 60_000 : 150_000;
  assertModelTextInputWithinLimit(prompt);
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
    ...(onProgress ? { stream: true } : {}),
  };
  onProgress?.({ type: "request", message: "模型请求已发送" });
  let apiCalls = 1;
  let response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST", headers: { ...authHeaders(config), "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, timeoutMs);
  if (!response.ok && response.status === 400) {
    const firstError = await readJson(response);
    delete body.response_format;
    onProgress?.({ type: "request", message: "兼容模式正在重试" });
    apiCalls += 1;
    response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers: { ...authHeaders(config), "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, timeoutMs);
    if (!response.ok) throw upstreamError(response.status, await readJson(response) || firstError);
  }
  if (!response.ok) throw upstreamError(response.status, await readJson(response));
  const firstText = onProgress
    ? await readChatCompletionStream(response, onProgress)
    : extractChatCompletionText(await readJson(response));
  const firstValue = tryParseModelJson(firstText);
  if (hasStructuredContent(firstValue, schemaName)) return { value: firstValue, apiCalls };

  const repairInstruction = schemaName === "deck_spec"
    ? "请修复上一次输出。只返回一个有效 JSON 对象，根对象必须包含 title、theme、story 和非空 slides 数组。slides 必须严格遵守用户指定页数，每页包含 title、subtitle、layout、claim、bullets、speakerNotes、sourceNotes、sourceBlockIds、imageIndex、callouts、visualBrief、imagePrompt。不要输出解释、Markdown 或代码围栏。"
    : schemaName === "deck_outline"
      ? "请修复上一次输出。只返回轻量 DECK_OUTLINE_JSON 对象，根对象必须包含 title、theme、story 和非空 slides 数组；每页只包含 title、purpose、evidence、sourceBlockIds、visualAnchor，并严格遵守指定页数。"
    : schemaName === "html_deck"
      ? "请修复上一次输出。只返回完整 HtmlDeckSpec JSON，根对象必须包含 id、title、width、height、revision、theme、非空 slides、variables、comments 和 drawings。不要输出 HTML、解释、Markdown 或代码围栏。"
      : schemaName === "html_patch"
        ? "请修复上一次输出。只返回 JSON 对象，根对象必须包含 summary 和非空 patches 数组；每个 Patch 包含 slideId、nodeId、operation 和 changesJson。不要输出解释、Markdown 或代码围栏。"
        : "请修复上一次输出。只返回一个有效 JSON 对象，根对象必须包含非空 slides 数组，每项包含 slideIndex、composition、safeArea 和 parts。不要输出解释、Markdown 或代码围栏。";
  const repairMessages = [...body.messages];
  if (firstText) repairMessages.push({ role: "assistant", content: firstText });
  repairMessages.push({ role: "user", content: repairInstruction });
  const repairBody = { ...body, messages: repairMessages, temperature: 0 };
  onProgress?.({ type: "phase", message: "结构校验未通过，正在自动修复" });
  onProgress?.({ type: "request", message: "结构修复请求已发送" });
  response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST", headers: { ...authHeaders(config), "Content-Type": "application/json" }, body: JSON.stringify(repairBody),
  }, timeoutMs);
  if (!response.ok) throw upstreamError(response.status, await readJson(response));
  apiCalls += 1;
  const repairedText = onProgress
    ? await readChatCompletionStream(response, onProgress)
    : extractChatCompletionText(await readJson(response));
  const repairedValue = tryParseModelJson(repairedText);
  if (!hasStructuredContent(repairedValue, schemaName)) {
    const message = schemaName === "deck_spec"
      ? "模型连续两次没有返回可用的幻灯片结构。请确认文本模型支持 JSON 输出，或在 API 设置中更换模型。"
      : schemaName === "deck_outline"
        ? "模型连续两次没有返回可用的叙事大纲。请确认文本模型支持 JSON 输出，或在 API 设置中更换模型。"
      : schemaName === "html_deck"
        ? "模型连续两次没有返回可用的 HtmlDeckSpec。已保留安全初稿。"
        : schemaName === "html_patch"
          ? "模型连续两次没有返回可用的局部修改 Patch，原稿未改变。"
          : "模型连续两次没有返回可用的视觉拆解结构。请更换支持图片理解和 JSON 输出的模型。";
    throw new HttpError(502, message);
  }
  return { value: repairedValue, apiCalls };
}

function normalizeDeckOutline(raw, source) {
  const rawSlides = Array.isArray(raw?.slides) ? raw.slides : [];
  if (rawSlides.length !== source.slideCount) throw new HttpError(502, `模型没有返回恰好 ${source.slideCount} 页大纲。`);
  const sourceBlockIds = new Set(source.sourceBlocks.map((block) => block.id));
  const slides = rawSlides.map((slide, index) => ({
    title: cleanDisplayText(slide?.title, 120) || `第 ${index + 1} 页`,
    purpose: cleanDisplayText(slide?.purpose, 240),
    evidence: Array.isArray(slide?.evidence)
      ? slide.evidence.map((item) => cleanDisplayText(item, 180)).filter(Boolean).slice(0, 4)
      : [],
    sourceBlockIds: Array.isArray(slide?.sourceBlockIds)
      ? [...new Set(slide.sourceBlockIds.map((item) => cleanDisplayText(item, 120)).filter((id) => sourceBlockIds.has(id)))].slice(0, 8)
      : [],
    visualAnchor: cleanDisplayText(slide?.visualAnchor, 240),
  }));
  const story = raw?.story || {};
  return {
    title: cleanDisplayText(raw?.title, 180) || source.topic,
    theme: ["dark-executive", "light-consulting", "editorial-visual"].includes(raw?.theme) ? raw.theme : "light-consulting",
    story: {
      thesis: cleanDisplayText(story.thesis, 500) || source.topic,
      audienceInsight: cleanDisplayText(story.audienceInsight, 500) || `${source.audience}需要清楚的结论和行动。`,
      narrativeArc: Array.isArray(story.narrativeArc) ? story.narrativeArc.map((item) => cleanDisplayText(item, 80)).filter(Boolean).slice(0, 8) : [],
      evidenceGaps: Array.isArray(story.evidenceGaps) ? story.evidenceGaps.map((item) => cleanDisplayText(item, 240)).filter(Boolean).slice(0, 6) : [],
      styleId: source.styleId,
    },
    slides,
  };
}

function normalizeDeck(raw, source) {
  const rawSlides = Array.isArray(raw?.slides) ? raw.slides : [];
  if (rawSlides.length !== source.slideCount) throw new HttpError(502, `模型没有返回恰好 ${source.slideCount} 页。`);
  const layouts = new Set(["cover", "two-column", "visual-left", "visual-right", "section", "takeaway"]);
  const sourceBlocks = new Map(source.sourceBlocks.map((block) => [block.id, block]));
  const slides = rawSlides.slice(0, source.slideCount).map((slide, index) => {
    const sourceRefs = [...new Set(Array.isArray(slide?.sourceBlockIds) ? slide.sourceBlockIds.map((item) => cleanDisplayText(item, 120)) : [])]
      .map((id) => sourceBlocks.get(id)?.source).filter(Boolean).slice(0, 8);
    return ({
    title: cleanDisplayText(slide?.title, 120) || `第 ${index + 1} 页`,
    subtitle: cleanDisplayText(slide?.subtitle, 220),
    layout: layouts.has(slide?.layout) ? slide.layout : index === 0 ? "cover" : "two-column",
    claim: cleanDisplayText(slide?.claim, 320),
    bullets: Array.isArray(slide?.bullets) ? slide.bullets.map((item) => cleanDisplayText(item, 240)).filter(Boolean).slice(0, 6) : [],
    speakerNotes: cleanDisplayText(slide?.speakerNotes, 1_500),
    sourceNotes: sourceRefs.length ? sourceRefs.slice(0, 5).map(sourceReferenceLabel) : Array.isArray(slide?.sourceNotes) ? slide.sourceNotes.map((item) => cleanDisplayText(item, 240)).filter(Boolean).slice(0, 5) : [],
    sourceRefs,
    imageIndex: Number.isInteger(slide?.imageIndex) && slide.imageIndex > 0 ? slide.imageIndex : undefined,
    callouts: Array.isArray(slide?.callouts) ? slide.callouts.slice(0, 3).map((item) => ({
      label: cleanDisplayText(item?.label, 40),
      value: cleanDisplayText(item?.value ?? item, 80),
    })).filter((item) => item.label || item.value) : [],
    visualBrief: cleanDisplayText(slide?.visualBrief, 800),
    imagePrompt: cleanDisplayText(slide?.imagePrompt, 1_200),
  }); });
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
  if (schemaName === "deck_outline") return Array.isArray(value.slides) && value.slides.length > 0 && value.story;
  if (schemaName === "html_deck") return Array.isArray(value.slides) && value.slides.length > 0 && value.theme && Array.isArray(value.variables);
  if (schemaName === "html_patch") return Array.isArray(value.patches) && value.patches.length > 0;
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

async function sendNdjsonStream(res, task) {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const emit = (event) => {
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  emit({ type: "start", message: "模型请求已建立" });
  try {
    const data = await task(emit);
    emit({ type: "result", data });
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : "未知服务错误。" });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function readResponsesStream(response, onProgress) {
  let text = "";
  let completedText = "";
  await readSseEvents(response, (eventName, data) => {
    const type = String(data?.type || eventName || "");
    if (type === "response.output_text.delta" && typeof data?.delta === "string") {
      text += data.delta;
      onProgress({ type: "delta", deltaChars: data.delta.length, totalChars: text.length });
      return;
    }
    if (type === "response.completed") {
      completedText = extractResponseText(data?.response || data);
      return;
    }
    if (type === "response.failed" || type === "error") {
      const message = data?.response?.error?.message || data?.error?.message || data?.message || "模型流式响应失败。";
      throw new HttpError(502, cleanText(message, 500));
    }
  });
  const result = text || completedText;
  if (!result) throw new HttpError(502, "模型流式响应没有返回文本内容。");
  return result;
}

async function readChatCompletionStream(response, onProgress) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    return extractChatCompletionText(await readJson(response));
  }
  let text = "";
  await readSseEvents(response, (_eventName, data) => {
    const errorMessage = data?.error?.message;
    if (errorMessage) throw new HttpError(502, cleanText(errorMessage, 500));
    const delta = chatDeltaText(data?.choices?.[0]?.delta?.content);
    if (!delta) return;
    text += delta;
    onProgress({ type: "delta", deltaChars: delta.length, totalChars: text.length });
  });
  if (!text) throw new HttpError(502, "兼容模型的流式响应没有返回文本内容。");
  return text;
}

function chatDeltaText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(chatDeltaText).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.value === "string") return value.value;
  if (typeof value.content === "string") return value.content;
  return "";
}

async function readSseEvents(response, onEvent) {
  if (!response.body) throw new HttpError(502, "模型服务没有返回可读取的响应流。");
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (block) => {
    if (!block.trim()) return;
    let eventName = "";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const raw = dataLines.join("\n");
    if (!raw || raw === "[DONE]") return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    onEvent(eventName, data);
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    blocks.forEach(consume);
  }
  buffer += decoder.decode();
  consume(buffer);
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
    if (error?.name === "TimeoutError") throw new HttpError(504, `模型服务在 ${Math.round(timeoutMs / 60_000)} 分钟内未完成响应。`);
    throw new HttpError(502, `无法连接模型服务：${error?.message || "网络错误"}`);
  }
}

function isRetryableImageError(error) {
  const status = Number(error?.status);
  const message = String(error?.message || "").toLowerCase();
  return [408, 429, 500, 502, 503, 504].includes(status)
    || /timeout|timed out|aborted due to timeout|rate limit|temporar/.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const looksLikeHtml = contentType.includes("text/html") || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text);
    return {
      responseFormat: looksLikeHtml ? "html" : "text",
      error: { message: looksLikeHtml ? "" : text.replace(/\s+/g, " ").trim().slice(0, 300) },
    };
  }
}

function upstreamError(status, payload) {
  const message = payload?.responseFormat === "html"
    ? status === 524
      ? "上游网关返回 524：长时间生图请求在边缘网关等待超时。"
      : `上游网关返回 ${status} HTML 错误页。`
    : payload?.error?.message || payload?.message || `模型服务返回 ${status}`;
  return new HttpError(status >= 500 ? 502 : status, cleanText(message, 500));
}

function sendApiError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "未知服务错误。";
  res.status(status).json({ ok: false, error: message });
}

function cleanText(value, maxLength) { return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength); }
function assertModelTextInputWithinLimit(prompt) {
  const systemLength = String(prompt?.system || "").length;
  const userLength = String(prompt?.user || "").length;
  if (systemLength <= maxModelTextInputLength && userLength <= maxModelTextInputLength) return;
  throw new HttpError(413, "发送给模型的文本仍超过安全上限，请减少页数或移除异常大的内联内容后重试。");
}
function boundedInteger(value, min, max, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}
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
function defaultGatewayFallback(primaryValue) {
  try {
    return new URL(primaryValue).hostname.toLowerCase() === "api.chatanywhere.org"
      ? "https://api.chatanywhere.tech/v1"
      : "";
  } catch { return ""; }
}
function retryGatewayBase(primaryValue, fallbackValue) {
  const primary = String(primaryValue || "").trim().replace(/\/+$/, "");
  const fallback = String(fallbackValue || "").trim().replace(/\/+$/, "");
  if (!fallback || fallback === primary) return "";
  try {
    const primaryHost = new URL(primary).hostname.toLowerCase();
    const fallbackHost = new URL(fallback).hostname.toLowerCase();
    if (primaryHost === "api.openai.com" && fallbackHost !== "api.openai.com") return "";
    if (primaryHost === "api.chatanywhere.org" || explicitImageApiFallbackBase || explicitOpenAiApiFallbackBase) return fallback;
  } catch { return ""; }
  return "";
}
function isLocalApiBase(value) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(String(value)).hostname); } catch { return false; }
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
async function sendRuntimeAsset(res, relativePath, contentType) {
  try {
    const file = path.join(root, "node_modules", relativePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", isProduction ? "public, max-age=31536000, immutable" : "no-cache");
    res.send(await fs.readFile(file));
  } catch {
    res.status(404).send("Runtime asset not found");
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

app.listen(port, host, () => console.log(`DeckForge running at http://${host}:${port}`));
