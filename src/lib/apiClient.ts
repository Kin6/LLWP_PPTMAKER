import type { NotebookDeckSpec, NormalizedRect, SourceLocation } from "../types";
import { htmlDeckSchema } from "../html-deck/schema";
import type { HtmlDeckPatch, HtmlDeckSpec, HtmlImageNode } from "../html-deck/types";

export type ImageTextMode = "integrated" | "native";

export type ApiConfig = {
  configVersion: number;
  imageEnabled: boolean;
  imageCount: number;
  imageQuality: "low" | "medium" | "high";
  imageTextMode: ImageTextMode;
  imageTimeoutSeconds: number;
  imageMaxRetries: number;
};

export type ApiSourceImage = {
  name: string;
  dataUrl: string;
  summary: string;
};

export type DeckSource = {
  topic: string;
  audience: string;
  slideCount: number;
  textInput: string;
  tableInput: string;
  imageBrief: string;
  styleId: string;
  images: ApiSourceImage[];
  sourceBlocks: ApiSourceBlock[];
};

export type ApiSourceBlock = {
  id: string;
  type: "heading" | "paragraph" | "table" | "image" | "notice";
  text?: string;
  level?: number;
  rows?: string[][];
  assetId?: string;
  source: SourceLocation;
};

export type ImageJob = {
  slideIndex: number;
  prompt: string;
  layout: string;
  deckTitle: string;
  title: string;
  subtitle: string;
  claim: string;
  bullets: string[];
  callouts: { label: string; value: string }[];
  tableRows: string[][];
  pageNumber: number;
  totalPages: number;
  textMode: ImageTextMode;
  deckThesis: string;
  audienceInsight: string;
  narrativeArc: string[];
  previousSlideTitle: string;
  nextSlideTitle: string;
};

export type DecompositionPart = NormalizedRect & {
  label: string;
  role: string;
};

export type DecompositionResult = {
  slideIndex: number;
  composition: string;
  safeArea: NormalizedRect;
  parts: DecompositionPart[];
};

type ApiMeta = {
  provider?: string;
  model?: string;
  apiCalls: number;
  keySource?: "environment" | "none";
  refinementApplied?: boolean;
  planningMode?: "outline-first";
};

export type AiStreamUpdate = {
  type: "start" | "phase" | "request" | "delta";
  phase?: string;
  message?: string;
  deltaChars?: number;
  totalChars?: number;
};

type AiStreamCallback = (update: AiStreamUpdate) => void;

export async function testApiConnection(config: ApiConfig) {
  return requestJson<{ ok: true; model: string; provider: string; latencyMs: number; keySource: string }>(
    "/api/ai/test",
    { config: textConfig(config) },
  );
}

export async function generateAiDeck(config: ApiConfig, source: DeckSource, onProgress?: AiStreamCallback) {
  const body = { config: textConfig(config), source };
  return onProgress
    ? requestJsonStream<{ ok: true; deck: NotebookDeckSpec; meta: ApiMeta }>("/api/ai/generate-deck-stream", body, onProgress)
    : requestJson<{ ok: true; deck: NotebookDeckSpec; meta: ApiMeta }>("/api/ai/generate-deck", body);
}

export async function generateAiHtmlDeck(config: ApiConfig, deck: NotebookDeckSpec, draft: HtmlDeckSpec, styleId: string, onProgress?: AiStreamCallback) {
  const body = {
    config: textConfig(config),
    deck,
    draft: stripHtmlDeckForApi(draft),
    styleId,
  };
  type HtmlDeckResponse = {
    ok: true;
    deck: unknown;
    meta: ApiMeta & { designApplied?: boolean };
  };
  const response = onProgress
    ? await requestJsonStream<HtmlDeckResponse>("/api/ai/generate-html-deck-stream", body, onProgress)
    : await requestJson<HtmlDeckResponse>("/api/ai/generate-html-deck", body);
  const hydrated = hydrateHtmlDeck(response.deck, draft);
  const parsed = htmlDeckSchema.safeParse(hydrated);
  return {
    ...response,
    deck: parsed.success ? parsed.data as HtmlDeckSpec : draft,
    meta: { ...response.meta, designApplied: Boolean(response.meta.designApplied && parsed.success) },
  };
}

export async function patchAiHtmlDeck(
  config: ApiConfig,
  deck: HtmlDeckSpec,
  instruction: string,
  slideId: string,
  nodeId?: string,
  onProgress?: AiStreamCallback,
) {
  const body = {
    config: textConfig(config),
    deck: stripHtmlDeckForApi(deck),
    instruction,
    slideId,
    nodeId,
  };
  return onProgress ? requestJsonStream<{
    ok: true;
    summary: string;
    patches: HtmlDeckPatch[];
    meta: ApiMeta;
  }>("/api/ai/patch-html-deck-stream", body, onProgress) : requestJson<{
    ok: true;
    summary: string;
    patches: HtmlDeckPatch[];
    meta: ApiMeta;
  }>("/api/ai/patch-html-deck", body);
}

export async function generateAiImages(
  config: ApiConfig,
  jobs: ImageJob[],
  referenceImages: ApiSourceImage[],
  styleId: string,
) {
  return requestJson<{
    ok: true;
    images: { slideIndex: number; url: string; prompt: string; revisedPrompt?: string }[];
    meta: ApiMeta;
  }>("/api/ai/generate-images", {
    config: {
      quality: config.imageQuality,
      timeoutMs: config.imageTimeoutSeconds * 1_000,
      maxRetries: config.imageMaxRetries,
    },
    jobs,
    referenceImages,
    styleId,
  });
}

export async function decomposeAiImages(
  config: ApiConfig,
  images: { slideIndex: number; url: string }[],
) {
  return requestJson<{ ok: true; decompositions: DecompositionResult[]; meta: ApiMeta }>(
    "/api/ai/decompose-images",
    { config: textConfig(config), images },
  );
}

function textConfig(config: ApiConfig) {
  void config;
  return {};
}

function stripHtmlDeckForApi(deck: HtmlDeckSpec) {
  return {
    ...deck,
    comments: [],
    drawings: [],
    slides: deck.slides.map((slide) => ({
      ...slide,
      nodes: slide.nodes.map((node) => {
        if (node.type === "image") return { ...node, src: "" };
        if (node.type === "video") return { ...node, src: "", poster: "" };
        return node;
      }),
    })),
  };
}

function hydrateHtmlDeck(value: unknown, draft: HtmlDeckSpec): unknown {
  if (!value || typeof value !== "object") return draft;
  const raw = value as Record<string, unknown>;
  const rawSlides = Array.isArray(raw.slides) ? raw.slides : [];
  if (rawSlides.length !== draft.slides.length) return draft;
  const slides = rawSlides.map((rawSlide, slideIndex) => {
    const sourceSlide = draft.slides[slideIndex];
    if (!rawSlide || typeof rawSlide !== "object") return sourceSlide;
    const slide = rawSlide as Record<string, unknown>;
    const rawNodes = Array.isArray(slide.nodes) ? slide.nodes : [];
    const sourceImages = sourceSlide.nodes.filter((node): node is HtmlImageNode => node.type === "image");
    const nodes = rawNodes.map((rawNode) => {
      if (!rawNode || typeof rawNode !== "object") return rawNode;
      const node = rawNode as Record<string, unknown>;
      if (node.type !== "image") return node;
      const match = sourceImages.find((image) => image.id === node.id || image.assetId === node.assetId) || sourceImages[0];
      return match ? { ...node, src: match.src, assetId: match.assetId || String(node.assetId || ""), prompt: match.prompt || String(node.prompt || ""), alt: match.alt || String(node.alt || "") } : node;
    });
    for (const image of sourceImages) {
      if (!nodes.some((node) => node && typeof node === "object" && ((node as Record<string, unknown>).id === image.id || (node as Record<string, unknown>).assetId === image.assetId))) nodes.push(image);
    }
    const interactions = (Array.isArray(slide.interactions) ? slide.interactions : []).map((interaction) => {
      if (!interaction || typeof interaction !== "object") return interaction;
      return Object.fromEntries(Object.entries(interaction as Record<string, unknown>).filter(([, item]) => item !== null));
    });
    return { ...slide, id: sourceSlide.id, nodes, interactions };
  });
  const variables = (Array.isArray(raw.variables) ? raw.variables : draft.variables).map((variable) => {
    if (!variable || typeof variable !== "object") return variable;
    return Object.fromEntries(Object.entries(variable as Record<string, unknown>).filter(([, item]) => item !== null));
  });
  return {
    ...raw,
    id: draft.id,
    width: 1600,
    height: 900,
    revision: Math.max(draft.revision + 1, Number(raw.revision) || 1),
    slides,
    variables,
    comments: draft.comments,
    drawings: draft.drawings,
  };
}

async function requestJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `请求失败 (${response.status})`);
  }
  return payload as T;
}

async function requestJsonStream<T>(url: string, body: unknown, onProgress: AiStreamCallback): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload?.error === "string" ? payload.error : `请求失败 (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: (AiStreamUpdate & { data?: T }) | { type: "result"; data: T } | { type: "error"; message?: string };
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "error") throw new Error(event.message || "流式请求失败。");
    if (event.type === "result") {
      result = event.data;
      return;
    }
    onProgress(event);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(consume);
    if (done) break;
  }
  consume(buffer);
  if (!result) throw new Error("流式请求结束但没有返回完整结果。");
  return result;
}
