import type { NotebookDeckSpec } from "../App";

export type ApiProvider = "openai" | "compatible" | "ollama";

export type ApiConfig = {
  provider: ApiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  imageEnabled: boolean;
  imageModel: string;
  imageCount: number;
  imageQuality: "low" | "medium" | "high";
};

export type DeckSource = {
  topic: string;
  audience: string;
  slideCount: number;
  textInput: string;
  tableInput: string;
  imageBrief: string;
  imageSummaries: string[];
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
  prompts: string[],
) {
  return requestJson<{
    ok: true;
    images: { url: string; prompt: string; revisedPrompt?: string }[];
    meta: ApiMeta;
  }>("/api/ai/generate-images", {
    config: {
      baseUrl: config.provider === "ollama" ? "https://api.openai.com/v1" : config.baseUrl,
      model: config.imageModel,
      apiKey: config.apiKey,
      quality: config.imageQuality,
    },
    prompts,
  });
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
