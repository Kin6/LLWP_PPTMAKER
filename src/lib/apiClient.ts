import type { NotebookDeckSpec, NormalizedRect, SourceLocation } from "../types";

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
