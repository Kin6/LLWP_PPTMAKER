import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const mockPort = 4010;
const appPort = 5198;
const children = [];

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

try {
  start(process.execPath, ["scripts/mock-openai.mjs"], {
    MOCK_PORT: String(mockPort),
    MOCK_DISABLE_IMAGE_FAILURES: "1",
  });
  await waitFor(`http://127.0.0.1:${mockPort}/v1/models`);

  start(process.execPath, ["server/index.mjs", "--port", String(appPort)], {
    OPENAI_API_KEY: "test-key",
    OPENAI_API_BASE: `http://127.0.0.1:${mockPort}/v1`,
    IMAGE_API_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
  });
  await waitFor(`http://127.0.0.1:${appPort}/api/health`);

  const bullets = ["证据一", "证据二", "证据三", "证据四", "证据五"];
  const response = await fetch(`http://127.0.0.1:${appPort}/api/ai/generate-images`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: {
        baseUrl: "https://browser-must-not-control-api.example/v1",
        model: "browser-model-must-not-control-api",
        apiKey: "browser-key-must-not-control-api",
        quality: "medium",
        timeoutMs: 240_000,
        maxRetries: 0,
      },
      styleId: "blank",
      referenceImages: [],
      jobs: [{
        slideIndex: 1,
        pageNumber: 2,
        totalPages: 3,
        textMode: "integrated",
        layout: "visual-right",
        deckTitle: "高密度演示",
        title: "主视觉必须证明结论",
        subtitle: "信息丰富但保持一条阅读路径",
        claim: "让文字、数据与场景共同完成论证",
        bullets,
        callouts: [
          { label: "覆盖率", value: "92%" },
          { label: "周期", value: "3 周" },
          { label: "状态", value: "已验证" },
        ],
        tableRows: [],
        prompt: "用一个连续主场景解释产品验证闭环",
        deckThesis: "高质量页面由逻辑和视觉共同驱动",
        audienceInsight: "决策者需要快速检查证据",
        narrativeArc: ["提出判断", "展示证据", "推导行动"],
        previousSlideTitle: "先提出需要验证的判断",
        nextSlideTitle: "再把证据推导为行动",
      }],
    }),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.equal(payload.meta?.keySource, "environment");
  assert.equal(payload.meta?.model, "gpt-image-2");
  const prompt = payload.images?.[0]?.prompt || "";
  assert.match(prompt, /高信息密度/);
  assert.match(prompt, /三到五个/);
  assert.match(prompt, /两到四个内部证据模块/);
  assert.match(prompt, /严禁可见页框/);
  assert.match(prompt, /同一场景或同一系统状态的自然推进/);
  assert.match(prompt, /x=7% 到 93%、y=10% 到 88%/);
  for (const bullet of bullets) assert.match(prompt, new RegExp(bullet));
  assert.doesNotMatch(prompt, /最多两个短要点/);
  console.log("Image prompt regression passed: environment-only credentials, dense copy, five evidence points, continuity, safe area, and no outer frame.");
} finally {
  for (const child of children.reverse()) child.kill();
}
