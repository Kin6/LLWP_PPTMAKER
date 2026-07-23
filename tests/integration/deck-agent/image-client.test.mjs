import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "../../../server/config.mjs";
import { createHttpClient } from "../../../server/shared/http.mjs";
import { createImageClient } from "../../../server/images/client.mjs";

const children = [];
let primaryBase;
let fallbackBase;

beforeAll(async () => {
  const basePort = 43_000 + (process.pid % 1_000);
  primaryBase = await startGateway(basePort, { MOCK_IMAGE_ALWAYS_FAIL: "1", MOCK_GATEWAY_NAME: "primary" });
  fallbackBase = await startGateway(basePort + 1, { MOCK_DISABLE_IMAGE_FAILURES: "1", MOCK_GATEWAY_NAME: "fallback" });
});

afterAll(() => children.forEach((child) => child.kill("SIGTERM")));

describe("image provider client", () => {
  it("uses official image[] multipart fields for multiple edit references", async () => {
    const client = makeClient({ provider: "openai", baseUrl: fallbackBase });
    const result = await client.generateAsset({
      prompt: "画一个 mock-official-edit scene", references: [pixel(), pixel()], aspectRatio: "16:9", quality: "medium", timeoutMs: 2_000, maxRetries: 0,
    });
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.apiCalls).toBe(1);
  });

  it("uses a compatible single image field for edit requests", async () => {
    const client = makeClient({ provider: "compatible", baseUrl: fallbackBase });
    const result = await client.generateAsset({
      prompt: "画一个 mock-compatible-edit scene", references: [pixel(), pixel()], aspectRatio: "16:9", quality: "medium", timeoutMs: 2_000, maxRetries: 0,
    });
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.apiCalls).toBe(1);
  });

  it("retries a 524 through the configured fallback gateway and counts both calls", async () => {
    const client = makeClient({ provider: "compatible", baseUrl: primaryBase, fallbackBaseUrl: fallbackBase });
    const result = await client.generateAsset({
      prompt: "画一个 fallback scene", references: [], aspectRatio: "16:9", quality: "medium", timeoutMs: 2_000, maxRetries: 1,
    });
    expect(result.revisedPrompt).toBe("fallback");
    expect(result.apiCalls).toBe(2);
  });
});

function makeClient({ provider, baseUrl, fallbackBaseUrl = "" }) {
  const config = loadServerConfig({
    env: {
      OPENAI_API_KEY: "test-key", IMAGE_API_PROVIDER: provider, IMAGE_API_BASE_URL: baseUrl,
      IMAGE_API_FALLBACK_BASE_URL: fallbackBaseUrl, IMAGE_MODEL: "mock-image",
    },
    argv: [], rootDir: process.cwd(),
  });
  return createImageClient({ config, http: createHttpClient({ proxyUrl: "" }) });
}

function pixel() {
  return { name: "pixel.png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA" };
}

async function startGateway(port, extraEnv) {
  const child = spawn(process.execPath, ["scripts/mock-openai.mjs"], {
    cwd: process.cwd(), env: { ...process.env, MOCK_PORT: String(port), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  await waitFor(`${baseUrl}/models`);
  return baseUrl;
}

async function waitFor(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
