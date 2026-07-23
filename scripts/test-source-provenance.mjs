import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const mockPort = 43000 + (process.pid % 500);
const appPort = mockPort + 1000;
const mock = spawn(process.execPath, ["scripts/mock-openai.mjs"], {
  env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_DISABLE_IMAGE_FAILURES: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const app = spawn(process.execPath, ["server/index.mjs", "--production", "--port", String(appPort)], {
  env: { ...process.env, HOST: "127.0.0.1", TEXT_API_BASE_URL: `http://127.0.0.1:${mockPort}/v1` },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitFor(`http://127.0.0.1:${mockPort}/v1/models`);
  await waitFor(`http://127.0.0.1:${appPort}/`);
  const response = await fetch(`http://127.0.0.1:${appPort}/api/ai/generate-deck`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { provider: "compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
      source: {
        topic: "可追溯材料测试",
        audience: "产品负责人",
        slideCount: 2,
        textInput: "根据材料形成结论",
        tableInput: "",
        imageBrief: "",
        styleId: "blank",
        images: [],
        sourceBlocks: [{
          id: "block-pdf-12",
          type: "paragraph",
          text: "扫描材料显示一个需要复核的趋势。",
          source: {
            blockId: "block-pdf-12",
            attachmentId: "attachment-report",
            filename: "report.pdf",
            kind: "pdf",
            extraction: "ocr",
            page: 12,
            paragraphIndex: 1,
            confidence: 64,
            lowConfidence: true,
          },
        }],
      },
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.deck.slides.length, 2);
  assert.equal(payload.deck.slides[0].sourceRefs[0].blockId, "block-pdf-12");
  assert.equal(payload.deck.slides[0].sourceRefs[0].page, 12);
  assert.equal(payload.deck.slides[0].sourceRefs[0].confidence, 64);
  assert.equal(payload.deck.slides[0].sourceRefs[0].lowConfidence, true);
  assert.match(payload.deck.slides[0].sourceNotes[0], /report\.pdf，第 12 页，OCR 64%，低置信度，待核实/);
  console.log("Source provenance integration test passed: prompt blockId -> DeckSpec.");
} finally {
  mock.kill("SIGTERM");
  app.kill("SIGTERM");
}

async function waitFor(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
