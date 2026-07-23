import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig } from "../../../server/config.mjs";
import {
  buildBuildStageMessages,
  createSlideBatchSchema,
} from "../../../server/deck-agent/stages/build-stage.mjs";
import { createHttpClient } from "../../../server/shared/http.mjs";
import { createModelClient } from "../../../server/model/client.mjs";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

let gateway;
let baseUrl;

beforeAll(async () => {
  const port = 41_000 + (process.pid % 1_000);
  baseUrl = `http://127.0.0.1:${port}/v1`;
  gateway = spawn(process.execPath, ["scripts/mock-openai.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, MOCK_PORT: String(port), MOCK_DISABLE_IMAGE_FAILURES: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(`${baseUrl}/models`);
});

afterAll(() => gateway?.kill("SIGTERM"));

describe("model provider client", () => {
  it("uses official Responses SSE and reports one upstream call", async () => {
    const client = makeClient({ TEXT_API_PROVIDER: "openai" });
    const progress = [];
    const result = await client.completeStructured({
      messages: [{ role: "user", content: "mock-official-sse" }],
      schema: RESULT_SCHEMA,
      schemaName: "result",
      timeoutMs: 2_000,
      onProgress: (event) => progress.push(event),
    });
    expect(result).toMatchObject({ value: { ok: true }, apiCalls: 1, provider: "openai", model: "mock-model" });
    expect(progress.some((event) => event.type === "delta")).toBe(true);
  });

  it("compatible Chat retries a 400 without response_format and repairs invalid JSON once", async () => {
    const client = makeClient({ TEXT_API_PROVIDER: "compatible" });
    const result = await client.completeStructured({
      messages: [{ role: "user", content: "mock-compatible-repair" }],
      schema: RESULT_SCHEMA,
      schemaName: "result",
      timeoutMs: 2_000,
    });
    expect(result.value).toEqual({ ok: true });
    expect(result.apiCalls).toBe(3);
  });

  it("compatible Chat returns the direct slides array required by the build protocol", async () => {
    const client = makeClient({ TEXT_API_PROVIDER: "compatible" });
    const targetSlideIds = ["slide-01", "slide-02"];
    const schema = createSlideBatchSchema(targetSlideIds);
    const messages = buildBuildStageMessages({
      title: "Protocol test",
      narrative: "Evidence to action",
      lockedDesignBriefSummary: "Use the locked grid and type scale",
      allowedAssets: [],
      htmlCssContract: "Rootless HTML and :slide-scoped CSS",
      targetSlides: targetSlideIds.map((slideId, index) => ({
        slideId,
        title: `Page ${index + 1}`,
        claim: `Claim ${index + 1}`,
        rawMarkdown: `## Page ${index + 1}`,
      })),
      neighboringSlides: [],
      readOnlySlides: [],
    }, {}, { targetSlideIds, schema });

    const result = await client.completeStructured({
      messages,
      schema,
      schemaName: "deck_slide_batch",
      timeoutMs: 2_000,
    });

    expect(result.apiCalls).toBe(1);
    expect(result.value.slides.map((slide) => slide.slideId)).toEqual(targetSlideIds);
    expect(result.value.slides.every((slide) => (
      typeof slide.html === "string"
      && typeof slide.css === "string"
      && Array.isArray(slide.assetSlots)
      && Array.isArray(slide.charts)
    ))).toBe(true);
  });

  it("an external AbortSignal cancels an in-flight model request", async () => {
    const client = makeClient({ TEXT_API_PROVIDER: "openai" });
    const controller = new AbortController();
    const pending = client.completeStructured({
      messages: [{ role: "user", content: "mock-delay" }], schema: RESULT_SCHEMA, schemaName: "result",
      timeoutMs: 10_000, signal: controller.signal,
    });
    setTimeout(() => controller.abort("user-cancelled"), 50);
    await expect(pending).rejects.toThrow(/cancel/i);
  });

  it("loads provider secrets and routing from env rather than argv", () => {
    const config = loadServerConfig({
      env: { OPENAI_API_KEY: "env-key", TEXT_API_BASE_URL: baseUrl, TEXT_MODEL: "env-model", HTTPS_PROXY: "http://proxy.test:8080" },
      argv: ["--api-key", "attacker", "--base-url", "https://attacker.invalid", "--model", "attacker"],
      rootDir: process.cwd(),
    });
    expect(config.text).toMatchObject({ apiKey: "env-key", baseUrl, model: "env-model" });
    expect(config.proxyUrl).toBe("http://proxy.test:8080");
    expect(JSON.stringify(config)).not.toContain("attacker");
  });
});

function makeClient(extraEnv) {
  const config = loadServerConfig({
    env: { OPENAI_API_KEY: "test-key", TEXT_API_BASE_URL: baseUrl, TEXT_MODEL: "mock-model", ...extraEnv },
    argv: [], rootDir: process.cwd(),
  });
  return createModelClient({ config, http: createHttpClient({ proxyUrl: "" }) });
}

async function waitFor(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
