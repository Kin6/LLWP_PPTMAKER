import path from "node:path";

export function loadServerConfig({ env = process.env, argv = process.argv.slice(2), rootDir = process.cwd() } = {}) {
  const openAiBase = clean(env.OPENAI_API_BASE) || clean(env.OPENAI_BASE_URL);
  const openAiFallback = clean(env.OPENAI_API_FALLBACK_BASE);
  const textBaseUrl = normalizeBaseUrl(clean(env.TEXT_API_BASE_URL) || openAiBase || "https://api.openai.com/v1");
  const imageBaseUrl = normalizeBaseUrl(clean(env.IMAGE_API_BASE_URL) || openAiBase || "https://api.openai.com/v1");
  const textProvider = normalizeProvider(env.TEXT_API_PROVIDER || env.OPENAI_API_PROVIDER, textBaseUrl);
  const imageProvider = normalizeProvider(env.IMAGE_API_PROVIDER || env.OPENAI_API_PROVIDER, imageBaseUrl);
  const portIndex = argv.indexOf("--port");

  return {
    rootDir,
    deckJobRoot: path.resolve(rootDir, clean(env.DECK_JOB_ROOT) || ".deck-jobs"),
    host: clean(env.HOST) || "127.0.0.1",
    port: portIndex >= 0 ? boundedInteger(argv[portIndex + 1], 1, 65_535, 5173) : boundedInteger(env.PORT, 1, 65_535, 5173),
    production: env.NODE_ENV === "production" || argv.includes("--production"),
    proxyUrl: clean(env.HTTPS_PROXY) || clean(env.HTTP_PROXY) || clean(env.ALL_PROXY),
    text: {
      provider: textProvider,
      apiKey: clean(env.OPENAI_API_KEY),
      baseUrl: textBaseUrl,
      fallbackBaseUrl: normalizeOptionalBaseUrl(clean(env.TEXT_API_FALLBACK_BASE_URL) || openAiFallback),
      model: clean(env.TEXT_MODEL) || "gpt-5.6-terra",
    },
    image: {
      provider: imageProvider,
      apiKey: clean(env.IMAGE_API_KEY) || clean(env.OPENAI_API_KEY),
      baseUrl: imageBaseUrl,
      fallbackBaseUrl: normalizeOptionalBaseUrl(clean(env.IMAGE_API_FALLBACK_BASE_URL) || openAiFallback || defaultGatewayFallback(imageBaseUrl)),
      model: clean(env.IMAGE_MODEL) || "gpt-image-2",
      timeoutMs: boundedInteger(env.IMAGE_API_TIMEOUT_MS, 1_000, 900_000, 600_000),
      maxRetries: boundedInteger(env.IMAGE_API_MAX_RETRIES, 0, 2, 1),
      quality: normalizeQuality(env.IMAGE_QUALITY),
    },
  };
}

function normalizeProvider(value, baseUrl) {
  const provider = clean(value).toLowerCase();
  if (provider === "openai" || provider === "compatible") return provider;
  try { return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com" ? "openai" : "compatible"; }
  catch { return "compatible"; }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("API base URL must use http or https");
  return value.replace(/\/+$/, "");
}

function normalizeOptionalBaseUrl(value) {
  return value ? normalizeBaseUrl(value) : "";
}

function defaultGatewayFallback(value) {
  try { return new URL(value).hostname.toLowerCase() === "api.chatanywhere.org" ? "https://api.chatanywhere.tech/v1" : ""; }
  catch { return ""; }
}

function normalizeQuality(value) {
  return ["low", "medium", "high"].includes(clean(value)) ? clean(value) : "medium";
}

function boundedInteger(value, min, max, fallback) {
  if (value == null || clean(value) === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function clean(value) {
  return String(value ?? "").trim();
}
