import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { buildHtmlDeckDocument } from "../src/html-deck/document.ts";
import { applyHtmlDeckPatches } from "../src/html-deck/patches.ts";

const mockPort = 4012;
const appPort = 5188;
const mock = spawn(process.execPath, ["scripts/mock-openai.mjs"], {
  env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_DISABLE_IMAGE_FAILURES: "1", MOCK_STREAM_DELAY_MS: "10" },
  stdio: "ignore",
});
const app = spawn(process.execPath, ["server/index.mjs", "--port", String(appPort)], {
  env: {
    ...process.env,
    OPENAI_API_KEY: "test-key",
    OPENAI_API_BASE: `http://127.0.0.1:${mockPort}/v1`,
    TEXT_MODEL: "mock-vision",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  },
  stdio: "ignore",
});
let browser;

try {
  await waitFor(`http://127.0.0.1:${mockPort}/v1/models`);
  await waitFor(`http://127.0.0.1:${appPort}/api/health`);

  const notebook = {
    title: "HTML 回归测试",
    theme: "light-consulting",
    slides: Array.from({ length: 3 }, (_, index) => ({
      id: `slide-${index + 1}`,
      title: `第 ${index + 1} 页`,
      subtitle: "结构化 HTML 演示",
      claim: "每个对象保持独立可编辑。",
      bullets: ["可编辑", "可交互"],
      speakerNotes: "测试备注",
    })),
  };
  const draft = fixtureDeck(3);
  draft.slides[0].nodes.push(inlineImageNode("slide-1-image"));
  const streamedStory = await postStream(`http://127.0.0.1:${appPort}/api/ai/generate-deck-stream`, {
    config: { provider: "openai", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
    source: {
      topic: "HTML 回归测试",
      audience: "产品团队",
      slideCount: 3,
      textInput: "验证完整流式叙事生成。",
      tableInput: "",
      imageBrief: "",
      styleId: "blank",
      images: [],
      sourceBlocks: [],
    },
  });
  assert.equal(streamedStory.result.deck.slides.length, 3);
  assert.equal(streamedStory.result.meta.planningMode, "outline-first");
  assert.equal(streamedStory.result.meta.apiCalls, 2);
  assert.ok(streamedStory.events.some((event) => event.phase === "story-outline"));
  assert.ok(streamedStory.events.some((event) => event.phase === "story-compose"));
  assert.ok(streamedStory.events.filter((event) => event.type === "delta").length > 2);
  assert.equal(streamedStory.events.filter((event) => event.type === "request").length, 2);
  const outlineChars = maxStreamChars(streamedStory.events, "story-outline");
  const composedChars = maxStreamChars(streamedStory.events, "story-compose");
  assert.ok(outlineChars > 0 && outlineChars < composedChars * 0.7, `Expected compact outline (${outlineChars}) to be materially smaller than full DeckSpec (${composedChars})`);
  const compatibleStory = await postStream(`http://127.0.0.1:${appPort}/api/ai/generate-deck-stream`, {
    config: { provider: "compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
    source: {
      topic: "兼容网关大纲测试", audience: "产品团队", slideCount: 3,
      textInput: "验证兼容 Chat Completions 网关的大纲优先生成。", tableInput: "", imageBrief: "", styleId: "blank", images: [], sourceBlocks: [],
    },
  });
  assert.equal(compatibleStory.result.deck.slides.length, 3);
  assert.equal(compatibleStory.result.meta.planningMode, "outline-first");
  assert.equal(compatibleStory.events.filter((event) => event.type === "request").length, 2);
  assert.ok(maxStreamChars(compatibleStory.events, "story-outline") < maxStreamChars(compatibleStory.events, "story-compose"));
  const generated = await postJson(`http://127.0.0.1:${appPort}/api/ai/generate-html-deck`, {
    config: { provider: "openai", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
    deck: notebook,
    draft,
    styleId: "product-calm",
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.deck.slides.length, 3);
  assert.equal(generated.deck.width / generated.deck.height, 16 / 9);
  assert.ok(generated.deck.slides.every((slide) => slide.nodes.length >= 2));
  assert.ok(generated.deck.slides.some((slide) => slide.interactions.length));
  const streamedGeneration = await postStream(`http://127.0.0.1:${appPort}/api/ai/generate-html-deck-stream`, {
    config: { provider: "openai", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
    deck: notebook,
    draft,
    styleId: "product-calm",
  });
  assert.ok(streamedGeneration.events.some((event) => event.type === "phase"));
  assert.ok(streamedGeneration.events.filter((event) => event.type === "delta").length > 1);
  assert.equal(streamedGeneration.result.deck.slides.length, 3);
  const timeoutFallback = await postStream(`http://127.0.0.1:${appPort}/api/ai/generate-html-deck-stream`, {
    config: { provider: "openai", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-html-timeout", apiKey: "test-key" },
    deck: notebook,
    draft,
    styleId: "mock-html-timeout",
  });
  assert.equal(timeoutFallback.result.meta.designApplied, false);
  assert.match(timeoutFallback.result.meta.fallbackReason, /timeout/i);
  assert.equal(timeoutFallback.result.deck.id, draft.id);
  assert.equal(timeoutFallback.result.deck.slides.length, draft.slides.length);
  assert.ok(timeoutFallback.events.some((event) => event.type === "phase" && /保留可编辑的安全初稿/.test(event.message)));
  const hydratedDeck = removeNullOptionals(generated.deck);
  hydratedDeck.slides[0].nodes.push(inlineImageNode("slide-1-patch-image"));

  const patched = await postJson(`http://127.0.0.1:${appPort}/api/ai/patch-html-deck`, {
    config: { provider: "openai", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
    deck: hydratedDeck,
    instruction: "把标题放大一点",
    slideId: "slide-1",
    nodeId: "slide-1-title",
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.patches[0].operation, "update-node");
  const applied = applyHtmlDeckPatches(hydratedDeck, patched.patches);
  assert.equal(applied.applied, 1);
  assert.equal(applied.deck.slides[0].nodes[0].style.fontSize, 60);

  const compatiblePatch = await postJson(`http://127.0.0.1:${appPort}/api/ai/patch-html-deck`, {
    config: { provider: "compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
    deck: hydratedDeck,
    instruction: "把标题放大一点",
    slideId: "slide-1",
    nodeId: "slide-1-title",
  });
  assert.equal(compatiblePatch.patches[0].operation, "update-node");
  const streamedCompatiblePatch = await postStream(`http://127.0.0.1:${appPort}/api/ai/patch-html-deck-stream`, {
    config: { provider: "compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock-vision", apiKey: "test-key" },
    deck: hydratedDeck,
    instruction: "把标题放大一点",
    slideId: "slide-1",
    nodeId: "slide-1-title",
  });
  assert.ok(streamedCompatiblePatch.events.some((event) => event.type === "delta"));
  assert.equal(streamedCompatiblePatch.result.patches[0].operation, "update-node");

  const blockedSource = applyHtmlDeckPatches(hydratedDeck, [{
    slideId: "slide-1", nodeId: "slide-1-title", operation: "update-node", changes: { src: "https://attacker.invalid/payload.js", __proto__: { polluted: true } },
  }]);
  assert.equal(blockedSource.deck.slides[0].nodes[0].src, undefined);
  assert.equal({}.polluted, undefined);
  const invalidRect = applyHtmlDeckPatches(hydratedDeck, [{
    slideId: "slide-1", nodeId: "slide-1-title", operation: "update-node", changes: { x: -1 },
  }]);
  assert.equal(invalidRect.applied, 0);
  const patchMatrix = applyHtmlDeckPatches(hydratedDeck, [
    { slideId: "slide-1", operation: "update-slide", changes: { title: "更新后的页面标题", background: "#101820" } },
    { slideId: "slide-1", operation: "add-node", changes: { node: shapeNode("slide-1-added-shape") } },
    { slideId: "slide-1", nodeId: "slide-1-added-shape", operation: "remove-node", changes: {} },
    { slideId: "slide-1", operation: "reorder-slides", changes: { order: ["slide-3", "slide-2", "slide-1"] } },
  ]);
  assert.equal(patchMatrix.applied, 4);
  assert.equal(patchMatrix.deck.slides[0].id, "slide-3");
  assert.equal(patchMatrix.deck.slides[2].title, "更新后的页面标题");
  assert.equal(patchMatrix.deck.slides[2].nodes.some((node) => node.id === "slide-1-added-shape"), false);

  const exfiltrationAttempt = await fetch(`http://127.0.0.1:${appPort}/api/ai/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { provider: "compatible", baseUrl: "https://attacker.invalid/v1", model: "mock-vision", apiKey: "" } }),
  });
  assert.equal(exfiltrationAttempt.status, 200);
  const exfiltrationPayload = await exfiltrationAttempt.json();
  assert.equal(exfiltrationPayload.model, "mock-vision");
  assert.equal(exfiltrationPayload.keySource, "environment");

  for (const asset of ["reveal.js", "reveal.css", "echarts.js"]) {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/html-runtime/${asset}`);
    assert.equal(response.ok, true);
    assert.ok((await response.text()).length > 1_000);
  }

  const html = buildHtmlDeckDocument(hydratedDeck, {
    runtimeOrigin: `http://127.0.0.1:${appPort}`,
    editMode: false,
    inlineVendors: { revealCss: "/* offline */", revealJs: "class Reveal {}", echartsJs: "const echarts = {};" },
  });
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /sandbox|HTML_DECK|llwp-html-deck/);
  assert.match(html, /update-node-rect/);
  assert.match(html, /triggerInteractions\('enter'/);
  assert.doesNotMatch(html, /attacker\.invalid/);
  const contractDeck = fixtureDeck(1);
  contractDeck.slides[0].nodes[0].animation = "draw";
  contractDeck.slides[0].nodes[0].animationDelay = 0.4;
  contractDeck.slides[0].nodes.push(radarNode("slide-1-radar"));
  const contractHtml = buildHtmlDeckDocument(contractDeck, { runtimeOrigin: `http://127.0.0.1:${appPort}`, editMode: false });
  assert.match(contractHtml, /animate-draw/);
  assert.match(contractHtml, /--animation-delay:0\.4s/);
  assert.match(contractHtml, /indicator/);

  const nativeImage = await postJson(`http://127.0.0.1:${appPort}/api/ai/generate-images`, {
    config: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "gpt-image-2", apiKey: "test-key", quality: "medium", timeoutMs: 240_000, maxRetries: 0 },
    referenceImages: [],
    styleId: "blank",
    jobs: [{ slideIndex: 0, pageNumber: 1, totalPages: 3, textMode: "native", layout: "visual-right", deckTitle: "个人作品集", title: "真实项目证明专业能力", subtitle: "", claim: "", bullets: ["项目产物可验证"], callouts: [], tableRows: [], prompt: "软件工程师通过开源项目展示交付能力", deckThesis: "用真实作品证明能力", audienceInsight: "招聘方需要具体证据", narrativeArc: ["身份", "项目", "结果"], previousSlideTitle: "", nextSlideTitle: "项目结果形成可信证据" }],
  });
  const nativePrompt = nativeImage.images[0].prompt;
  assert.match(nativePrompt, /内容锚定规则/);
  assert.match(nativePrompt, /不得擅自生成陌生人物肖像/);
  assert.match(nativePrompt, /禁止机器人、类人 AI/);
  assert.match(nativePrompt, /同一主角或核心对象身份/);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${appPort}`);
  await page.getByRole("button", { name: "工作台" }).click();
  await page.getByRole("button", { name: "交互网页" }).click();
  const rail = page.getByRole("complementary", { name: "页面导航" });
  await rail.getByRole("button").nth(1).click();
  const frame = page.locator("iframe.html-deck-frame").contentFrame();
  await frame.locator(".slides > section.present").waitFor();
  await frame.getByText("02 / 07", { exact: true }).waitFor();
  assert.match(await frame.locator(".slides > section.present").innerText(), /02 \/ 07/);

  assert.equal(await page.getByText("策划演示叙事", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Context" }).click();
  await page.getByPlaceholder("例如：投资人").fill("产品团队");
  await page.getByRole("button", { name: "API 设置" }).click();
  await page.getByText("已检测到系统 API Key", { exact: true }).waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.locator(".brand-button").click();
  await page.getByRole("textbox", { name: "描述演示主题和核心材料" }).fill("制作一份九页产品策略演示");
  await page.getByRole("textbox", { name: "目标受众，必填" }).fill("产品团队");
  await page.getByRole("spinbutton", { name: "精确页数，1 到 50" }).fill("9");
  await page.getByRole("button", { name: "融合成片", exact: true }).click();
  await page.getByRole("button", { name: /交互网页 可编辑 HTML/ }).click();
  await page.getByRole("button", { name: "生成演示文稿" }).click();
  await page.getByLabel("HTML 演示预览生成中").waitFor();
  assert.equal(await page.locator("iframe.html-deck-frame").count(), 0);
  assert.equal(await rail.count(), 0);
  assert.match(await page.locator(".chat-request small").innerText(), /9 页/);
  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByText("策划演示叙事", { exact: true }).waitFor();
  assert.equal(await page.getByText("生成视觉素材", { exact: true }).count(), 0);
  await page.getByText("正在规划叙事大纲与证据顺序", { exact: true }).waitFor();
  assert.equal(await page.getByText("生成视觉素材", { exact: true }).count(), 0);
  await page.getByText("大纲已完成，正在扩展完整页面内容", { exact: true }).waitFor();
  assert.match(await page.locator(".run-summary").innerText(), /2 次 API 调用/);
  await page.getByText("生成视觉素材", { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await page.getByText("策划演示叙事", { exact: true }).count(), 1);
  await rail.waitFor();
  assert.equal(await rail.getByRole("button").count(), 9);

  console.log("HTML deck regression checks passed.");
} finally {
  await browser?.close();
  mock.kill("SIGTERM");
  app.kill("SIGTERM");
}

function fixtureDeck(count) {
  return {
    id: "fixture-html-deck",
    title: "HTML 回归测试",
    width: 1600,
    height: 900,
    revision: 1,
    theme: { name: "测试", background: "#F8F8F4", surface: "#FFFFFF", text: "#111820", muted: "#667078", primary: "#0E6CFF", accent: "#E74C36", fontFamily: "Microsoft YaHei, sans-serif" },
    slides: Array.from({ length: count }, (_, index) => ({
      id: `slide-${index + 1}`,
      title: `第 ${index + 1} 页`,
      background: "#F8F8F4",
      transition: "fade",
      nodes: [{
        id: `slide-${index + 1}-title`, type: "text", name: "标题", x: 0.06, y: 0.08, w: 0.6, h: 0.18, zIndex: 2,
        animation: "rise", animationDelay: 0, text: `第 ${index + 1} 页`, role: "title",
        style: { fontSize: 52, fontWeight: 760, lineHeight: 1.1, color: "#111820", align: "left", verticalAlign: "middle", backgroundColor: "transparent", borderColor: "transparent", borderWidth: 0, radius: 0, opacity: 1, padding: 0 },
      }],
      interactions: [],
      speakerNotes: "测试备注",
    })),
    variables: [
      { id: "primary-color", label: "主色", type: "color", value: "#0E6CFF" },
      { id: "accent-color", label: "强调色", type: "color", value: "#E74C36" },
      { id: "motion-enabled", label: "动画", type: "boolean", value: true },
    ],
    comments: [],
    drawings: [],
  };
}

function maxStreamChars(events, phase) {
  return Math.max(0, ...events.filter((event) => event.type === "delta" && event.phase === phase).map((event) => Number(event.totalChars) || 0));
}

function inlineImageNode(id) {
  return {
    id, type: "image", name: "内联主视觉", x: 0.62, y: 0.18, w: 0.32, h: 0.64, zIndex: 1,
    animation: "scale", animationDelay: 0, src: `data:image/png;base64,${"A".repeat(256_000)}`,
    alt: "测试图片", objectFit: "cover", prompt: "保留这张主视觉", assetId: `${id}-asset`, opacity: 1,
  };
}

function shapeNode(id) {
  return {
    id, type: "shape", name: "新增形状", x: 0.2, y: 0.2, w: 0.2, h: 0.2, zIndex: 1,
    animation: "none", animationDelay: 0, shape: "rect", fill: "#0E6CFF", stroke: "#0E6CFF",
    strokeWidth: 0, radius: 8, opacity: 1,
  };
}

function radarNode(id) {
  return {
    id, type: "chart", name: "能力雷达", x: 0.55, y: 0.2, w: 0.38, h: 0.55, zIndex: 1,
    animation: "fade", animationDelay: 0, chartType: "radar", labels: ["叙事", "视觉", "交互"],
    series: [{ name: "当前", values: [82, 76, 88], color: "#0E6CFF" }], showLegend: true,
    showValues: false, accentColor: "#0E6CFF",
  };
}

async function waitFor(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  return payload;
}

async function postStream(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.ok, true);
  const text = await response.text();
  const events = text.trim().split("\n").map((line) => JSON.parse(line));
  const error = events.find((event) => event.type === "error");
  if (error) throw new Error(error.message);
  const result = events.find((event) => event.type === "result")?.data;
  assert.ok(result);
  return { events, result };
}

function removeNullOptionals(value) {
  if (Array.isArray(value)) return value.map(removeNullOptionals);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, removeNullOptionals(item)]));
}
