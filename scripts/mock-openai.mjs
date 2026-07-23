import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MOCK_PORT || 4010);
const disableImageFailures = process.env.MOCK_DISABLE_IMAGE_FAILURES === "1";
const forcedImageFailureMode = process.env.MOCK_IMAGE_FAILURE_MODE || "";
const streamDelayMs = Math.max(0, Number(process.env.MOCK_STREAM_DELAY_MS) || 0);
const alwaysFailImages = process.env.MOCK_IMAGE_ALWAYS_FAIL === "1";
const gatewayName = process.env.MOCK_GATEWAY_NAME || "primary";
const expectedImageSize = "1536x864";
const imageBase64 = (await fs.readFile(path.join(root, "public", "style-guides", "product-calm.png"))).toString("base64");
const failedImageTokens = new Set();
const SCENARIO_TOKEN = /\b(?:MOCK_[A-Z0-9_]+|FAIL_HTML_524_ONCE_PAGE_\d+)\b/g;

function freshScenarioState(key = "", markers = []) {
  return {
    key,
    markers: new Set(markers),
    outlineAttempts: 0,
    calibrationSlideIds: [],
    calibrationGenerationCount: 0,
    calibrationReviewFailed: false,
    calibrationReviewFailures: 0,
    calibrationOverflowResponses: 0,
    forbiddenAsideUsed: false,
    unscopedSelectorUsed: false,
    unscopedSelectorResponses: 0,
    buildFailureUsed: false,
    buildBatchRequests: 0,
    buildFailures: 0,
    buildSuccesses: 0,
    buildDelayUsed: false,
    imageRequests: 0,
    imageHtml524Failures: 0,
    imageRetrySuccesses: 0,
    imageSuccesses: 0,
    visualRepairSlideId: "",
    revisionFailure: false,
  };
}

let scenarioState = freshScenarioState();

function scenarioMarkers(text) {
  return [...new Set(String(text || "").match(SCENARIO_TOKEN) || [])].sort();
}

function hasScenario(name, state = scenarioState) {
  return state.markers.has(name);
}

function activateScenario(text, { newOutline = false } = {}) {
  const markers = scenarioMarkers(text);
  if (markers.length === 0 && !newOutline) return scenarioState;
  const key = markers.join(" ") || "default";
  const preservingInvalidRetry = newOutline
    && key === scenarioState.key
    && markers.includes("MOCK_INVALID_OUTLINE_TWICE")
    && scenarioState.outlineAttempts === 2
    && scenarioState.calibrationSlideIds.length === 0;
  if (key !== scenarioState.key || (newOutline && scenarioState.outlineAttempts > 0 && !preservingInvalidRetry)) {
    failedImageTokens.clear();
    scenarioState = freshScenarioState(key, markers);
  }
  return scenarioState;
}

function scenarioDiagnostics() {
  return {
    markers: [...scenarioState.markers].sort(),
    calibrationGenerationCount: scenarioState.calibrationGenerationCount,
    calibrationReviewFailures: scenarioState.calibrationReviewFailures,
    calibrationOverflowResponses: scenarioState.calibrationOverflowResponses,
    unscopedSelectorResponses: scenarioState.unscopedSelectorResponses,
    buildBatchRequests: scenarioState.buildBatchRequests,
    buildFailures: scenarioState.buildFailures,
    buildSuccesses: scenarioState.buildSuccesses,
    imageRequests: scenarioState.imageRequests,
    imageHtml524Failures: scenarioState.imageHtml524Failures,
    imageRetrySuccesses: scenarioState.imageRetrySuccesses,
    imageSuccesses: scenarioState.imageSuccesses,
  };
}

function contentStrings(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return content == null ? [] : [JSON.stringify(content)];
  return content.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (typeof item?.text === "string") return [item.text];
    if (typeof item?.content === "string") return [item.content];
    return [];
  });
}

function requestDetails(messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  const strings = normalized.flatMap((message) => contentStrings(message?.content));
  const userJson = [];
  for (const message of normalized) {
    if (message?.role !== "user") continue;
    for (const value of contentStrings(message.content)) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) userJson.push(parsed);
      } catch {
        // Non-JSON prompt text is still available through text.
      }
    }
  }
  return { text: strings.join("\n"), user: userJson.at(-1) || {}, userJson };
}

const deck = {
  title: "模拟 API：五阶段 PPT 工作流",
  theme: "light-consulting",
  story: {
    thesis: "高质量 PPT 需要把内容逻辑、视觉生成和原生对象交付串成一条流程。",
    audienceInsight: "决策者希望先看到结论，再检查证据和可执行动作。",
    narrativeArc: ["核心判断", "当前问题", "关键证据", "五阶段方案", "交付价值"],
    evidenceGaps: ["正式版本需要补充真实用户质量评测"],
    styleId: "product-calm",
  },
  slides: Array.from({ length: 7 }, (_, index) => ({
    title: [
      "把内容、视觉与交付串成一条闭环",
      "多数工具只优化版式，没有先解决论证",
      "三类输入需要先被转成可追溯证据",
      "风格参考图让 Image 2 获得稳定审美方向",
      "视觉拆解让图片成为可独立移动的对象",
      "原生组装保留文字、表格和图片的编辑能力",
      "以可编辑 PPTX 作为最终质量验收",
    ][index],
    subtitle: `模拟服务返回的第 ${index + 1} 页`,
    layout: index === 0 ? "cover" : index % 2 ? "visual-right" : "visual-left",
    claim: "这一页只承担一个清晰的论证任务。",
    bullets: ["结论先行，证据紧随其后", "视觉服务于信息而不是替代文字", "最终对象可以在 PowerPoint 中继续修改"],
    speakerNotes: "用于自动化验收的模拟讲稿备注。",
    sourceNotes: ["用户文字", index === 2 ? "用户表格" : "流程设计"],
    sourceBlockIds: [],
    imageIndex: null,
    callouts: index === 6 ? [{ label: "交付格式", value: "PPTX" }] : [],
    visualBrief: "清晰的产品工作流与信息结构视觉",
    imagePrompt: `第 ${index + 1} 页，智能演示文稿工作流，留出原生文字空间，无任何文字`,
  })),
};

function deckForRequest(text) {
  const match = String(text || "").match(/(?:必须恰好|严格)\s*(\d+)\s*页/);
  const count = Math.max(1, Math.min(50, Number(match?.[1]) || deck.slides.length));
  const failureMatch = String(text).match(/FAIL_IMAGE_ONCE_PAGE_(\d+)/);
  const failurePage = Number(failureMatch?.[1]) || 0;
  const blockIds = [...new Set([
    ...[...String(text).matchAll(/\[blockId:\s*([^\]]+)\]/g)].map((match) => match[1]),
    ...[...String(text).matchAll(/"blockId"\s*:\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...String(text).matchAll(/\b(?:source|block)-[A-Za-z0-9-]{3,}\b/g)].map((match) => match[0]),
  ])];
  const slides = Array.from({ length: count }, (_, index) => {
    const base = deck.slides[index % deck.slides.length];
    const isLast = index === count - 1;
    return {
      ...base,
      title: isLast && count > 1 ? "把前述证据收束为下一步行动" : base.title,
      subtitle: `模拟服务返回的第 ${index + 1}/${count} 页`,
      speakerNotes: `承接第 ${Math.max(1, index)} 页，并引向第 ${Math.min(count, index + 2)} 页。`,
      sourceBlockIds: blockIds.length ? [blockIds[index % blockIds.length]] : [],
      imagePrompt: `${base.imagePrompt}${index + 1 === failurePage ? ` FAIL_IMAGE_ONCE_PAGE_${failurePage}` : ""}`,
    };
  });
  if (String(text).includes("RETURN_OBJECT_FIELDS")) {
    slides[0] = {
      ...slides[0],
      title: { text: "对象字段已安全转成标题" },
      bullets: [{ text: "对象要点一" }, { content: "对象要点二" }, { label: "对象要点三" }],
      sourceNotes: [{ text: "对象来源" }],
    };
  }
  return { ...deck, slides };
}

function outlineForRequest(text) {
  const fullDeck = deckForRequest(text);
  return {
    title: fullDeck.title,
    theme: fullDeck.theme,
    story: fullDeck.story,
    slides: fullDeck.slides.map((slide) => ({
      title: slide.title,
      purpose: "推进一项必要判断，并为下一页建立前提。",
      evidence: slide.bullets.slice(0, 2),
      sourceBlockIds: slide.sourceBlockIds,
      visualAnchor: "与本页判断直接相关的真实项目证据",
    })),
  };
}

const stageThemeCss = ":root{--deck-bg:#ffffff;--deck-surface:#f4f5f7;--deck-text:#111111;--deck-muted:#555555;--deck-primary:#075ccb;--deck-secondary:#243447;--deck-accent:#d9363e;--deck-positive:#14804a;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:72px;--deck-heading-size:48px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:8px;--deck-space:24px;--deck-grid-gap:32px;}";

function cleanScenarioText(value) {
  return String(value || "").replace(SCENARIO_TOKEN, "").replace(/\s+/g, " ").trim();
}

function escapeHtmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stageOutlineMarkdown(details) {
  const count = Math.max(1, Math.min(50, Number(details.user.slideCount) || 1));
  const sourceIds = Array.isArray(details.user.sourceBlockIds)
    ? [...new Set(details.user.sourceBlockIds.map(String))]
    : [...new Set([...details.text.matchAll(/\b(?:source|block)-[A-Za-z0-9-]{1,}\b/g)].map((match) => match[0]))];
  const fallback = sourceIds[0] || "block-mock";
  const slides = Array.from({ length: count }, (_, index) => {
    const sourceId = sourceIds[index % sourceIds.length] || fallback;
    return `## 幻灯片 ${index + 1}：模拟内容页 ${index + 1}\n\n**核心观点：** 第 ${index + 1} 页给出一个可验证结论。\n\n**演讲备注：** 解释本页结论并衔接下一页。\n\n**材料来源：** 模拟输入材料\n<!-- source:${sourceId} -->`;
  });
  const title = cleanScenarioText(details.user.topic) || "模拟 HTML 幻灯片";
  const markers = [...scenarioState.markers].join(" ");
  return `# ${title}\n\n> 叙事主线：从核心判断推进到可执行行动${markers ? ` ${markers}` : ""}\n\n${slides.join("\n\n")}`;
}

function slidePayload(slide, { calibrationOverflow = false, state = scenarioState } = {}) {
  const slideId = String(slide?.slideId || "slide-01");
  const title = String(slide?.title || `模拟页面 ${slideId}`);
  const claim = String(slide?.claim || "这一页给出一个可验证结论。");
  const sourceBlockIds = [...new Set([...String(slide?.rawMarkdown || "").matchAll(/<!--\s*source:([A-Za-z0-9._-]+)\s*-->/g)].map((match) => match[1]))];
  const failurePage = Number([...state.markers]
    .map((marker) => marker.match(/^FAIL_HTML_524_ONCE_PAGE_(\d+)$/)?.[1])
    .find(Boolean)) || 0;
  const page = Number(slideId.slice("slide-".length));
  const needsAsset = failurePage === page;
  const slotId = `visual-${slideId}`;
  const visual = needsAsset
    ? `<figure class="mock-visual" data-asset-slot="${slotId}"></figure>`
    : `<div class="mock-evidence"><strong>${String(page).padStart(2, "0")}</strong><span>可追溯证据</span></div>`;
  const html = `<section class="mock-slide"><header><small>DECKFORGE / MOCK</small><span>${String(page).padStart(2, "0")}</span></header><div class="mock-layout"><div class="mock-copy"><h1>${title}</h1><p>${claim}</p></div>${visual}</div><footer>自动化验收演示</footer></section>`;
  const overflowHeight = calibrationOverflow ? "1500px" : "100%";
  const css = `:slide{display:block;padding:72px 88px;background:#f7f8fa;color:#111820;overflow:hidden}:slide .mock-slide{height:${overflowHeight};display:grid;grid-template-rows:52px 1fr 42px;gap:28px}:slide header,:slide footer{display:flex;align-items:center;justify-content:space-between;color:#596273;font-size:20px;line-height:1.2}:slide header{border-style:solid;border-color:#075ccb;border-width:0 0 2px}:slide footer{border-style:solid;border-color:#d7dce2;border-width:1px 0 0}:slide .mock-layout{display:grid;grid-template-columns:1.08fr .92fr;gap:64px;align-items:center;min-height:0}:slide .mock-copy{display:flex;flex-direction:column;justify-content:center}:slide h1{margin:0 0 30px;font-size:70px;line-height:1.08;color:#111820}:slide p{margin:0;font-size:31px;line-height:1.45;color:#374151}:slide .mock-evidence,:slide .mock-visual{height:500px;padding:48px;display:flex;flex-direction:column;justify-content:space-between;background:#ffffff;border:2px solid #d7dce2;border-radius:8px;overflow:hidden}:slide .mock-evidence strong{font-size:120px;line-height:1;color:#075ccb}:slide .mock-evidence span{font-size:26px;line-height:1.2;color:#596273}:slide .mock-visual img{width:100%;height:100%;object-fit:contain}`;
  const assetSlots = needsAsset ? [{
    slotId,
    purpose: `mock-official-edit 画一个无文字的制造运营场景 FAIL_HTML_524_ONCE_PAGE_${page}`,
    aspectRatio: "16:9",
    safeArea: { x: 0.08, y: 0.08, w: 0.84, h: 0.84 },
    sourceBlockIds,
  }] : [];
  return { slideId, html, css, assetSlots, charts: [] };
}

function writeSlideCall(slide, options) {
  const payload = slidePayload(slide, options);
  return {
    id: `write-${payload.slideId}-${options?.state?.calibrationGenerationCount || 0}`,
    name: "write_slide",
    argumentsJson: JSON.stringify(payload),
  };
}

function invalidSlideIdBatch(slides) {
  if (slides.length === 0) return slides;
  if (slides.length === 1) return [{ ...slides[0], slideId: "slide-99" }];
  return slides.map((slide, index) => (index === slides.length - 1 ? { ...slides[0] } : slide));
}

async function stageSlideBatch(details, { agentTurn = false } = {}) {
  const activeScenario = activateScenario(details.text);
  const targets = details.user.targetSlides;
  const targetIds = targets.map((slide) => String(slide.slideId));
  if (!activeScenario.calibrationSlideIds.length) activeScenario.calibrationSlideIds = [...targetIds];
  const calibrationRequest = targetIds.length === activeScenario.calibrationSlideIds.length
    && targetIds.every((slideId, index) => slideId === activeScenario.calibrationSlideIds[index]);
  const visualRepairRequest = activeScenario.visualRepairSlideId
    && targetIds.length === 1
    && targetIds[0] === activeScenario.visualRepairSlideId;
  let calibrationOverflow = false;
  if (calibrationRequest && !visualRepairRequest) {
    activeScenario.calibrationGenerationCount += 1;
    calibrationOverflow = hasScenario("MOCK_CALIBRATION_FALLBACK", activeScenario)
      && activeScenario.calibrationReviewFailed
      && activeScenario.calibrationGenerationCount === 2;
    if (calibrationOverflow) activeScenario.calibrationOverflowResponses += 1;
  }
  const postCalibration = !calibrationRequest && !visualRepairRequest;
  if (postCalibration) activeScenario.buildBatchRequests += 1;
  if (postCalibration && hasScenario("MOCK_FAIL_BUILD_BATCH_ONCE", activeScenario) && !activeScenario.buildFailureUsed) {
    activeScenario.buildFailureUsed = true;
    activeScenario.buildFailures += 1;
    if (agentTurn) return { message: "Simulated incomplete build batch", final: true, toolCalls: [] };
    const slides = targets.map((slide) => slidePayload(slide, { calibrationOverflow, state: activeScenario }));
    return { slides: invalidSlideIdBatch(slides) };
  }
  if (postCalibration && hasScenario("MOCK_DELAY_BUILD_CANCEL", activeScenario) && !activeScenario.buildDelayUsed) {
    activeScenario.buildDelayUsed = true;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (postCalibration) activeScenario.buildSuccesses += 1;
  if (agentTurn) {
    return {
      message: visualRepairRequest ? "Targeted repair written" : "Slide batch written",
      final: true,
      toolCalls: targets.map((slide) => writeSlideCall(slide, { calibrationOverflow, state: activeScenario })),
    };
  }
  const slides = targets.map((slide) => slidePayload(slide, { calibrationOverflow, state: activeScenario }));
  if (calibrationRequest
    && hasScenario("MOCK_FORBIDDEN_ASIDE_ONCE", activeScenario)
    && !activeScenario.forbiddenAsideUsed
    && slides[0]) {
    activeScenario.forbiddenAsideUsed = true;
    slides[0] = {
      ...slides[0],
      html: '<aside class="notes">Mock speaker notes must stay server-owned.</aside>',
    };
  }
  if (calibrationRequest
    && hasScenario("MOCK_UNSCOPED_SELECTOR_ONCE", activeScenario)
    && !activeScenario.unscopedSelectorUsed
    && slides[0]) {
    activeScenario.unscopedSelectorUsed = true;
    activeScenario.unscopedSelectorResponses += 1;
    slides[0] = {
      ...slides[0],
      css: `:root{--deck-bg:#ffffff}.mock-slide{display:grid}${slides[0].css}`,
    };
  }
  return { slides };
}

async function stageAgentTurn(details) {
  const task = String(details.user.task || "");
  if (/^Write slides-content\.md|^Repair slides-content\.md/i.test(task)) {
    activateScenario(details.text, { newOutline: task.startsWith("Write ") });
    scenarioState.outlineAttempts += 1;
    const invalid = hasScenario("MOCK_INVALID_OUTLINE_TWICE") && scenarioState.outlineAttempts <= 2;
    const markdown = invalid ? "# invalid" : stageOutlineMarkdown(details);
    return { message: "Outline published", final: true, toolCalls: [{ id: "stage-outline-1", name: "write_outline", argumentsJson: JSON.stringify({ markdown }) }] };
  }
  if (/exactly one design direction|single design direction/i.test(task) || /exactly one design direction|single design direction/i.test(details.text)) {
    const designBriefMarkdown = "# Single direction\n\nTypography scale: 72/48/30/20. Palette: restrained neutral with distinct accents. Grid: 12 columns. Spacing: 24px rhythm. Image grammar: evidence-led crops. Chart grammar: direct labels and semantic colors. Motion level: low. Visual motif vocabulary: numbered signals, evidence lines, and bold typographic anchors. Slide composition map: each slide receives one dominant anchor across two layout families. Prohibited patterns: decorative gradients and nested cards.";
    return { message: "Design published", final: true, toolCalls: [{ id: "stage-design-1", name: "write_theme", argumentsJson: JSON.stringify({ designBriefMarkdown }) }] };
  }
  if (Array.isArray(details.user.targetSlides)) {
    return stageSlideBatch(details, { agentTurn: true });
  }
  return { message: "No stage action", final: true, toolCalls: [] };
}

function visualReviewForRequest(details) {
  const slideIds = Array.isArray(details.user.slideIds)
    ? [...new Set(details.user.slideIds.map(String))]
    : [...new Set([...details.text.matchAll(/slide-\d{2}/g)].map((match) => match[0]))];
  const task = String(details.user.task || "");
  if (/calibration slides/i.test(task)) {
    const shouldFail = hasScenario("MOCK_CALIBRATION_FALLBACK") && !scenarioState.calibrationReviewFailed;
    if (shouldFail) {
      scenarioState.calibrationReviewFailed = true;
      scenarioState.calibrationReviewFailures += 1;
    }
    return {
      failedSlides: shouldFail && slideIds[0] ? [{ slideId: slideIds[0], reasons: ["weak hierarchy"] }] : [],
      designChanges: shouldFail ? ["increase title contrast"] : [],
    };
  }
  if (/complete deck once/i.test(task)) {
    const shouldFail = hasScenario("MOCK_VISUAL_REPAIR_ONCE") || hasScenario("MOCK_NEEDS_REVIEW_PERSISTENT");
    scenarioState.visualRepairSlideId = shouldFail ? slideIds.at(-1) || slideIds[0] || "" : "";
    return {
      failedSlides: shouldFail && scenarioState.visualRepairSlideId
        ? [{ slideId: scenarioState.visualRepairSlideId, reasons: ["insufficient visual hierarchy"] }]
        : [],
      designChanges: shouldFail ? ["strengthen the focal point"] : [],
    };
  }
  if (/Recheck only the repaired slides/i.test(task)) {
    const shouldFail = hasScenario("MOCK_NEEDS_REVIEW_PERSISTENT");
    const slideId = scenarioState.visualRepairSlideId || slideIds[0];
    return {
      failedSlides: shouldFail && slideId ? [{ slideId, reasons: ["issue persists after repair"] }] : [],
      designChanges: [],
    };
  }
  if (/candidate revision only/i.test(task)) {
    const slideId = slideIds[0];
    return {
      failedSlides: scenarioState.revisionFailure && slideId
        ? [{ slideId, reasons: ["candidate failed visual QA"] }]
        : [],
      designChanges: [],
    };
  }
  return { failedSlides: [], designChanges: [] };
}

function legacyCalibrationReview(details) {
  activateScenario(details.text);
  const slideIds = [...new Set([...details.text.matchAll(/slide-\d{2}/g)].map((match) => match[0]))].slice(0, 2);
  const shouldFail = hasScenario("MOCK_CALIBRATION_FALLBACK") && Boolean(slideIds[0]);
  if (shouldFail) {
    scenarioState.calibrationReviewFailed = true;
    scenarioState.calibrationReviewFailures += 1;
  }
  return {
    failedSlides: shouldFail ? [{ slideId: slideIds[0], reasons: ["weak hierarchy"] }] : [],
    designChanges: shouldFail ? ["increase title contrast"] : [],
  };
}

function revisionScopeForRequest(details) {
  const instruction = String(details.user.instruction || "");
  activateScenario(instruction || details.text);
  scenarioState.revisionFailure = instruction.includes("MOCK_SCOPED_EDIT_FAILURE");
  const explicit = Array.isArray(details.user.explicitSlideIds)
    ? details.user.explicitSlideIds.map(String)
    : [];
  const fallback = details.user.currentSlideId ? [String(details.user.currentSlideId)] : [];
  return { scope: "slides", slideIds: explicit.length ? explicit : fallback.length ? fallback : ["slide-01"] };
}

function revisionSlidesForRequest(details) {
  const slides = Array.isArray(details.user.slides) ? details.user.slides : [];
  const heading = cleanScenarioText(details.user.instruction);
  return {
    slides: slides.map((slide) => ({
      slideId: String(slide.slideId),
      html: heading
        ? String(slide.html || "").replace(
          /(<h1(?:\s[^>]*)?>)[\s\S]*?(<\/h1>)/i,
          (_match, opening, closing) => `${opening}${escapeHtmlText(heading)}${closing}`,
        )
        : String(slide.html || ""),
      css: String(slide.css || ""),
    })),
  };
}

function revisionThemeForRequest(details) {
  return { themeCss: String(details.user.currentCss || stageThemeCss) };
}

async function structuredPayload(name, messages) {
  const details = requestDetails(messages);
  if (name === "deck_slide_batch") return stageSlideBatch(details);
  if (name === "agent_turn") return stageAgentTurn(details);
  if (name === "calibration_review") return legacyCalibrationReview(details);
  if (name === "deck_visual_review" || name === "deck_revision_visual_review") {
    return visualReviewForRequest(details);
  }
  if (name === "deck_revision_scope") return revisionScopeForRequest(details);
  if (name === "deck_revision_slides") return revisionSlidesForRequest(details);
  if (name === "deck_revision_theme") return revisionThemeForRequest(details);

  const task = String(details.user.task || "");
  if (Array.isArray(details.user.targetSlides)) return stageSlideBatch(details);
  if (/Write slides-content\.md|Repair slides-content\.md|exactly one design direction/i.test(task)) {
    return stageAgentTurn(details);
  }
  if (/Classify a deck edit as slides, theme, or new-job-required/i.test(details.text)) {
    return revisionScopeForRequest(details);
  }
  if (/Apply the instruction only to the supplied rootless slide fragments/i.test(details.text)) {
    return revisionSlidesForRequest(details);
  }
  if (/Revise only the supplied :root deck theme tokens/i.test(details.text)) {
    return revisionThemeForRequest(details);
  }
  if (/Review (?:calibration slides|the complete deck once|the candidate revision only)|Recheck only the repaired slides/i.test(task)) {
    return visualReviewForRequest(details);
  }
  return undefined;
}

function imageFailureMode(prompt) {
  if (disableImageFailures) return "";
  if (forcedImageFailureMode === "html-524" || forcedImageFailureMode === "json-timeout") return forcedImageFailureMode;
  const text = String(prompt || "");
  const htmlMatch = text.match(/FAIL_HTML_524_ONCE_PAGE_(\d+)/);
  const match = htmlMatch || text.match(/FAIL_IMAGE_ONCE_PAGE_(\d+)/);
  if (!match || failedImageTokens.has(match[0])) return false;
  failedImageTokens.add(match[0]);
  return htmlMatch ? "html-524" : "json-timeout";
}

function beginImageAttempt(prompt) {
  const token = String(prompt || "").match(/FAIL_(?:HTML_524|IMAGE)_ONCE_PAGE_\d+/)?.[0];
  const retrying = Boolean(token && failedImageTokens.has(token));
  scenarioState.imageRequests += 1;
  const failureMode = imageFailureMode(prompt);
  if (failureMode === "html-524") scenarioState.imageHtml524Failures += 1;
  return { failureMode, retrying };
}

function completeImageAttempt({ retrying }) {
  scenarioState.imageSuccesses += 1;
  if (retrying) scenarioState.imageRetrySuccesses += 1;
}

async function streamJsonText(res, text, kind) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  for (let offset = 0; offset < text.length; offset += 96) {
    const delta = text.slice(offset, offset + 96);
    if (kind === "responses") {
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
    }
    if (streamDelayMs) await new Promise((resolve) => setTimeout(resolve, streamDelayMs));
  }
  if (kind === "responses") {
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output_text: text } })}\n\n`);
  } else {
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

const decomposition = {
  slides: [
    { slideIndex: 0, composition: "左侧留白，右侧为界面主体", safeArea: { x: 0.05, y: 0.12, w: 0.42, h: 0.74 }, parts: [{ label: "主界面", role: "hero", x: 0.48, y: 0.08, w: 0.47, h: 0.78 }, { label: "数据卡片", role: "detail", x: 0.08, y: 0.12, w: 0.27, h: 0.3 }] },
    { slideIndex: 1, composition: "中央产品界面与右侧证据模块", safeArea: { x: 0.05, y: 0.08, w: 0.35, h: 0.82 }, parts: [{ label: "产品界面", role: "hero", x: 0.4, y: 0.08, w: 0.52, h: 0.72 }, { label: "图表证据", role: "evidence", x: 0.55, y: 0.55, w: 0.3, h: 0.3 }] },
  ],
};

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/mock-image.png") {
    res.setHeader("Content-Type", "image/png");
    return res.end(Buffer.from(imageBase64, "base64"));
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "GET" && req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "mock-vision" }] }));
  if (req.method === "GET" && req.url === "/v1/__diagnostics") {
    return res.end(JSON.stringify({ ok: true, scenario: scenarioDiagnostics() }));
  }
  if (req.method === "POST" && req.url === "/v1/images/edits") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const multipart = Buffer.concat(chunks).toString("latin1");
    const fieldNames = [...multipart.matchAll(/;\s*name="([^"]+)"/g)].map((match) => match[1]);
    const promptMatch = multipart.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/);
    const decodedPrompt = promptMatch ? Buffer.from(promptMatch[1], "latin1").toString("utf8") : "";
    const expectsOfficialFields = decodedPrompt.includes("mock-official-edit");
    const hasExpectedImageField = expectsOfficialFields
      ? multipart.includes('name="image[]"')
      : multipart.includes('name="image"') && !multipart.includes('name="image[]"');
    if (!hasExpectedImageField) {
      res.statusCode = 400;
      const expected = expectsOfficialFields ? "image[]" : "image";
      return res.end(JSON.stringify({ error: { message: `Missing request parameter: ${expected} (received: ${fieldNames.join(", ")})` } }));
    }
    if (!multipart.includes(`name="size"\r\n\r\n${expectedImageSize}`)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `Expected 16:9 image size ${expectedImageSize}` } }));
    }
    const explicitDrawInstruction = Buffer.from("画一个", "utf8").toString("latin1");
    if (!multipart.includes(explicitDrawInstruction)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "Prompt must contain an explicit drawing instruction" } }));
    }
    if (alwaysFailImages) {
      res.statusCode = 524;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<!DOCTYPE html><html><body>gateway timeout</body></html>");
    }
    const attempt = beginImageAttempt(decodedPrompt);
    const { failureMode } = attempt;
    if (failureMode === "html-524") {
      res.statusCode = 524;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<!DOCTYPE html><html><head><title>524: A timeout occurred</title></head><body>gateway timeout</body></html>");
    }
    if (failureMode === "json-timeout") {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout" } }));
    }
    completeImageAttempt(attempt);
    return res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/mock-image.png`, revised_prompt: gatewayName }] }));
  }
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    if (alwaysFailImages) {
      res.statusCode = 524;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<!DOCTYPE html><html><body>gateway timeout</body></html>");
    }
    if (parsed.size !== expectedImageSize) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: `Expected 16:9 image size ${expectedImageSize}` } }));
    }
    if (!String(parsed.prompt || "").includes("画一个")) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: "Prompt must contain an explicit drawing instruction" } }));
    }
    const attempt = beginImageAttempt(parsed.prompt);
    const { failureMode } = attempt;
    if (failureMode === "html-524") {
      res.statusCode = 524;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end("<!DOCTYPE html><html><head><title>524: A timeout occurred</title></head><body>gateway timeout</body></html>");
    }
    if (failureMode === "json-timeout") {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "The operation was aborted due to timeout" } }));
    }
    completeImageAttempt(attempt);
    return res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/mock-image.png`, revised_prompt: gatewayName }] }));
  }
  if (req.method === "POST" && req.url === "/v1/responses") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const name = parsed?.text?.format?.name;
    const requestText = JSON.stringify(parsed?.input || []);
    if (requestText.includes("mock-delay")) await new Promise((resolve) => setTimeout(resolve, 5_000));
    let payload = requestText.includes("mock-official-sse")
      ? { ok: true }
      : await structuredPayload(name, parsed.input);
    if (payload === undefined) {
      payload = name === "image_decomposition"
        ? decomposition
        : name === "deck_outline"
          ? outlineForRequest(requestText)
          : deckForRequest(requestText);
    }
    if (parsed.stream) return streamJsonText(res, JSON.stringify(payload), "responses");
    return res.end(JSON.stringify({ output_text: JSON.stringify(payload) }));
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    const text = JSON.stringify(parsed?.messages || []);
    if (text.includes("mock-delay")) await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (text.includes("mock-compatible-repair")) {
      if (parsed.response_format) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: "response_format is unsupported" } }));
      }
      const repairing = /repair the previous output|修复上一次输出/i.test(String(parsed.messages?.at(-1)?.content || ""));
      const content = repairing ? JSON.stringify({ ok: true }) : "not valid json";
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    }
    if (parsed.model === "mock-timeout" && text.includes("依次分析所附")) {
      res.statusCode = 504;
      return res.end(JSON.stringify({ error: { message: "Model service timed out" } }));
    }
    if (text.includes("FORCE_EMPTY_DECK") && parsed.messages.length <= 2) {
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ title: "empty", slides: [] }) }] } }] }));
    }
    const schemaName = parsed?.response_format?.json_schema?.name;
    let payload = await structuredPayload(schemaName, parsed.messages);
    if (payload === undefined) {
      payload = text.includes("DECK_OUTLINE_JSON")
        ? outlineForRequest(text)
        : text.includes("依次分析所附")
          ? decomposition
          : deckForRequest(text);
    }
    if (parsed.stream) return streamJsonText(res, JSON.stringify(payload), "chat");
    return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: "Mock route not found" } }));
});

server.listen(port, "127.0.0.1", () => console.log(`Mock OpenAI service running at http://127.0.0.1:${port}/v1`));
