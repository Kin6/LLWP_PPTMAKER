import { FormData } from "undici";
import { HttpError, JobCancelledError } from "../shared/errors.mjs";

const SIZE_BY_ASPECT_RATIO = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864" };

export function createImageClient({ config, http }) {
  const providerConfig = config.image || config;

  return {
    async generateAsset({ prompt, references = [], aspectRatio = "16:9", quality, timeoutMs, maxRetries, signal } = {}) {
      ensureConfigured(providerConfig);
      const normalizedReferences = references.map(normalizeReference).filter(Boolean);
      const attempts = boundedInteger(maxRetries, 0, 2, providerConfig.maxRetries ?? 1) + 1;
      const requestTimeoutMs = boundedInteger(timeoutMs, 1_000, 900_000, providerConfig.timeoutMs ?? 600_000);
      const requestQuality = ["low", "medium", "high"].includes(quality) ? quality : providerConfig.quality || "medium";
      const size = SIZE_BY_ASPECT_RATIO[aspectRatio] || SIZE_BY_ASPECT_RATIO["16:9"];
      let apiCalls = 0;
      let lastError;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const baseUrl = attempt > 0 && providerConfig.fallbackBaseUrl ? providerConfig.fallbackBaseUrl : providerConfig.baseUrl;
        try {
          apiCalls += 1;
          const response = normalizedReferences.length
            ? await edit({ baseUrl, prompt, references: normalizedReferences, size, quality: requestQuality, timeoutMs: requestTimeoutMs, signal })
            : await generate({ baseUrl, prompt, size, quality: requestQuality, timeoutMs: requestTimeoutMs, signal });
          if (!response.ok) throw await upstreamError(response);
          const payload = await readJson(response);
          const item = payload?.data?.[0];
          const dataUrl = await toDataUrl(item, { http, timeoutMs: Math.min(requestTimeoutMs, 90_000), signal });
          if (!dataUrl) throw new HttpError(502, "Image provider returned no usable image");
          return { dataUrl, revisedPrompt: item?.revised_prompt || "", apiCalls };
        } catch (error) {
          lastError = error;
          if (error instanceof JobCancelledError || attempt + 1 >= attempts || !isRetryable(error)) throw error;
          await cancellableDelay(Math.min(1_000, 100 * (2 ** attempt)), signal);
        }
      }
      throw lastError;
    },
  };

  function generate({ baseUrl, prompt, size, quality, timeoutMs, signal }) {
    return http.fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: jsonHeaders(providerConfig),
      body: JSON.stringify({
        model: providerConfig.model, prompt, size, quality,
        ...(providerConfig.provider === "openai" ? { output_format: "png" } : {}),
      }),
    }, { timeoutMs, signal });
  }

  function edit({ baseUrl, prompt, references, size, quality, timeoutMs, signal }) {
    const form = new FormData();
    form.append("model", providerConfig.model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", quality);
    if (providerConfig.provider === "openai") {
      form.append("output_format", "png");
      references.forEach((reference, index) => appendImage(form, "image[]", reference, index));
    } else {
      appendImage(form, "image", references[0], 0);
    }
    return http.fetch(`${baseUrl}/images/edits`, {
      method: "POST", headers: authHeaders(providerConfig), body: form,
    }, { timeoutMs, signal });
  }
}

function appendImage(form, field, reference, index) {
  const { mime, bytes } = decodeDataUrl(reference.dataUrl);
  const filename = reference.name || `reference-${index + 1}.${extension(mime)}`;
  form.append(field, new Blob([bytes], { type: mime }), filename);
}

function normalizeReference(reference, index) {
  if (typeof reference === "string") return { name: `reference-${index + 1}.png`, dataUrl: reference };
  if (!reference?.dataUrl) return null;
  return { name: String(reference.name || `reference-${index + 1}.png`), dataUrl: String(reference.dataUrl) };
}

function decodeDataUrl(value) {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || ""));
  if (!match) throw new HttpError(400, "Reference image must be a normalized PNG, JPEG, or WebP data URL");
  return { mime: match[1].toLowerCase().replace("jpg", "jpeg"), bytes: Buffer.from(match[2], "base64") };
}

async function toDataUrl(item, { http, timeoutMs, signal }) {
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  const remoteUrl = String(item?.url || "").trim();
  if (!remoteUrl) return "";
  if (remoteUrl.startsWith("data:image/")) return remoteUrl;
  let parsed;
  try { parsed = new URL(remoteUrl); } catch { throw new HttpError(502, "Image provider returned an invalid URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new HttpError(502, "Image provider returned an unsupported URL");
  const response = await http.fetch(remoteUrl, { method: "GET" }, { timeoutMs, signal });
  if (!response.ok) throw new HttpError(502, `Unable to download generated image (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 12_000_000) throw new HttpError(502, "Generated image was empty or too large");
  const rawMime = String(response.headers.get("content-type") || "image/png").split(";")[0].toLowerCase();
  const mime = ["image/png", "image/jpeg", "image/webp"].includes(rawMime) ? rawMime : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function upstreamError(response) {
  const payload = await readJson(response);
  const message = payload?.error?.message || payload?.message || (payload?.responseFormat === "html" ? `Upstream gateway returned ${response.status}` : `Image provider returned ${response.status}`);
  return new HttpError(response.status, message);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    const html = /^\s*(?:<!doctype\s+html|<html\b)/i.test(text) || String(response.headers.get("content-type") || "").includes("text/html");
    return { responseFormat: html ? "html" : "text", error: { message: html ? "" : text.replace(/\s+/g, " ").slice(0, 300) } };
  }
}

function isRetryable(error) {
  return [408, 429, 500, 502, 503, 504, 524].includes(Number(error?.status)) || /timeout|rate limit|temporar/i.test(String(error?.message || ""));
}

function cancellableDelay(ms, signal) {
  if (signal?.aborted) throw new JobCancelledError();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new JobCancelledError()); }, { once: true });
  });
}

function ensureConfigured(config) {
  if (!config?.baseUrl || !config?.model) throw new HttpError(500, "Image provider is not configured");
  if (!config.apiKey && !isLocal(config.baseUrl)) throw new HttpError(400, "Image API key is not configured");
}

function authHeaders(config) { return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}; }
function jsonHeaders(config) { return { ...authHeaders(config), "Content-Type": "application/json" }; }
function extension(mime) { return mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"; }
function isLocal(value) { try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname); } catch { return false; } }
function boundedInteger(value, min, max, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}
