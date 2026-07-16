import type { NotebookDeckSpec, NormalizedRect } from "../types";

export type ApiProvider = "openai" | "compatible" | "ollama";
export type ImageTextMode = "integrated" | "native";

export type ApiConfig = {
  configVersion: number;
  provider: ApiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  imageEnabled: boolean;
  imageBaseUrl: string;
  imageApiKey: string;
  imageModel: string;
  imageCount: number;
  imageQuality: "low" | "medium" | "high";
  imageTextMode: ImageTextMode;
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
  keySource?: "session" | "environment" | "none";
};

export async function testApiConnection(config: ApiConfig) {
  return requestJson<{ ok: true; model: string; provider: string; latencyMs: number; keySource: string }>(
    "/api/ai/test",
    { config: textConfig(config) },
  );
}

export async function generateAiDeck(config: ApiConfig, source: DeckSource) {
  return requestJson<{ ok: true; deck: NotebookDeckSpec; meta: ApiMeta }>(
    "/api/ai/generate-deck",
    { config: textConfig(config), source },
  );
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
      baseUrl: config.imageBaseUrl || "https://api.openai.com/v1",
      model: config.imageModel,
      apiKey: config.imageApiKey || config.apiKey,
      quality: config.imageQuality,
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
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
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
