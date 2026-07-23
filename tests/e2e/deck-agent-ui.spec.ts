import { expect, test } from "../helpers/start-deck-agent-stack.mjs";

test.describe.configure({ mode: "serial", timeout: 180_000 });

function desktopOnly(projectName: string) {
  test.skip(projectName !== "desktop-chromium", "Mutation-heavy workflow coverage runs once on desktop Chromium.");
}

async function openJob(page: Parameters<typeof test>[0]["page"], appOrigin: string, jobId: string) {
  await page.goto(`${appOrigin}/?job=${encodeURIComponent(jobId)}`);
  await expect(page).toHaveURL(new RegExp(`\\?job=${jobId}$`));
  await expect(page.getByRole("main")).toBeVisible();
}

test("outline artifact opens read-only while generation continues and close restores focus and scroll", async ({ page, stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  await page.goto(stack.appOrigin);
  await page.getByRole("textbox", { name: "描述演示主题和核心材料" }).fill(
    "智能制造转型方案 MOCK_DELAY_BUILD_CANCEL",
  );
  await page.getByRole("textbox", { name: "目标受众，必填" }).fill("制造业管理团队");
  await page.getByRole("spinbutton", { name: "精确页数，1 到 50" }).fill("3");
  await page.locator('input[type="file"][accept*=".csv"]').setInputFiles({
    name: "manufacturing-evidence.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("metric,value\nmanual reporting,4 hours\ntraceability,63 percent"),
  });
  await expect(page.getByText("manufacturing-evidence.csv")).toBeVisible();
  await expect(page.getByRole("button", { name: "交互网页", exact: true })).toBeVisible();

  const accepted = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && response.url() === `${stack.appOrigin}/api/html-deck/jobs`
  ));
  await page.getByRole("button", { name: "生成演示文稿" }).click();
  const response = await accepted;
  const requestPayload = response.request().postDataJSON() as {
    source: {
      tableInput: string;
      sourceBlocks: Array<{
        id: string;
        type: string;
        rows?: string[][];
        source: { blockId: string; filename: string; kind: string; extraction: string; tableIndex?: number };
      }>;
    };
  };
  expect(requestPayload.source.tableInput).toBe("metric,value\nmanual reporting,4 hours\ntraceability,63 percent");
  expect(requestPayload.source.sourceBlocks).toHaveLength(1);
  const [tableBlock] = requestPayload.source.sourceBlocks;
  expect(tableBlock).toMatchObject({
    type: "table",
    rows: [
      ["metric", "value"],
      ["manual reporting", "4 hours"],
      ["traceability", "63 percent"],
    ],
    source: {
      filename: "manufacturing-evidence.csv",
      kind: "text",
      extraction: "native",
      tableIndex: 1,
    },
  });
  expect(tableBlock.id).toMatch(/^source-[0-9a-f-]{36}$/);
  expect(tableBlock.source.blockId).toBe(tableBlock.id);
  const payload = await response.json();
  const jobId = payload.job.id as string;
  await expect(page).toHaveURL(new RegExp(`\\?job=${jobId}$`));

  const outlineStep = page.getByRole("button", { name: "整理幻灯片内容大纲并写入 Markdown" });
  await expect(outlineStep).toHaveAttribute("aria-expanded", "true", { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "生成幻灯片页面" })).toBeVisible({ timeout: 90_000 });

  const timeline = page.getByRole("region", { name: "Agent 任务时间线" });
  const artifact = page.getByRole("button", { name: "slides-content.md" });
  await artifact.focus();
  const timelineScroll = await timeline.evaluate((node) => {
    node.style.height = "180px";
    node.style.overflowY = "auto";
    node.scrollTop = 137;
    return node.scrollTop;
  });
  expect(timelineScroll).toBeGreaterThan(0);
  await artifact.evaluate((node) => node.click());

  const dialog = page.getByRole("dialog", { name: "Markdown 文件预览" });
  await expect(dialog.getByRole("heading", { name: "智能制造转型方案" })).toBeVisible();
  await expect(dialog.locator("textarea, [contenteditable=true]")).toHaveCount(0);
  await expect(dialog.getByText("只读 · Markdown")).toBeVisible();
  await expect(page.locator(".deck-agent-status")).toHaveText(/生成中|已完成/);
  await expect.poll(async () => (await stack.readEvents(jobId)).some((item) => (
    item.stage === "design"
      && item.type === "progress"
      && item.message === "正在写入设计方向与主题"
  ))).toBe(true);

  await page.getByRole("button", { name: "关闭预览" }).click();
  await expect(artifact).toBeFocused();
  expect(await timeline.evaluate((node) => node.scrollTop)).toBe(timelineScroll);

  const cancel = page.getByRole("button", { name: "取消任务" });
  if (await cancel.isVisible()) await cancel.click();
});

test("refresh replays the durable timeline without duplicate stage rows", async ({ page, stack }) => {
  const seeded = await stack.seedPublishedJob("data-table");
  await openJob(page, stack.appOrigin, seeded.jobId);

  const durableEvents = await stack.readEvents(seeded.jobId);
  const durableStageEvents = [...durableEvents.reduce((latest, event) => {
    if (event.stage !== "queued") latest.set(event.stage, event);
    return latest;
  }, new Map()).values()] as Array<{ seq: number; stage: string; title: string }>;
  const rows = page.locator(".deck-agent-step");
  const renderedRows = () => rows.evaluateAll((nodes) => nodes.map((node) => ({
    seq: Number(node.getAttribute("data-event-seq")),
    title: node.querySelector(".deck-agent-step__toggle span")?.textContent?.trim() || "",
  })));
  await expect(rows).toHaveCount(durableStageEvents.length);
  const before = await renderedRows();
  expect(before).toEqual(durableStageEvents.map((event) => ({ seq: event.seq, title: event.title })));
  expect(new Set(before.map((row) => row.seq)).size).toBe(before.length);
  expect(new Set(before.map((row) => row.title)).size).toBe(before.length);

  await page.reload();
  await expect.poll(renderedRows).toEqual(before);
  await expect(rows).toHaveCount(durableStageEvents.length);
  expect(await renderedRows()).toEqual(before);
  expect(await stack.readEvents(seeded.jobId)).toEqual(durableEvents);
});

test("desktop and mobile job views have no horizontal application overflow or overlapping topbar controls", async ({ page, stack }) => {
  const seeded = await stack.seedPublishedJob("dense-report");
  await openJob(page, stack.appOrigin, seeded.jobId);
  await expect(page.getByTitle("HTML 幻灯片预览")).toBeVisible();
  await expect(page.locator(".deck-agent-deck-preview__navigation span"))
    .toHaveText(`1 / ${seeded.slideIds.length}`);

  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>(".deck-agent-topbar > *")]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
    const overlaps = controls.some((left, index) => controls.slice(index + 1).some((right) => (
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
        && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1
    )));
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overlaps,
    };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.overlaps).toBe(false);
});

test("invalid outline fails twice and retry resumes from the failed stage", async ({ page, stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  const created = await stack.createFixtureJob("data-table", { scenario: "MOCK_INVALID_OUTLINE_TWICE" });
  await openJob(page, stack.appOrigin, created.id);
  await expect(page.getByRole("button", { name: "重试任务" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "重试任务" }).click();
  await stack.waitForJob(created.id, ["ready"], { timeoutMs: 150_000 });
  await page.reload();
  await expect(page.getByTitle("HTML 幻灯片预览")).toBeVisible();
});

test("one failed build batch, calibration fallback, and an image 524 recover within bounded retries", async ({ stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  const created = await stack.createFixtureJob("dense-report", {
    slideCount: 4,
    imageEnabled: true,
    scenario: [
      "MOCK_FAIL_BUILD_BATCH_ONCE",
      "MOCK_CALIBRATION_FALLBACK",
      "FAIL_HTML_524_ONCE_PAGE_2",
    ].join(" "),
  });
  const completed = await stack.waitForJob(created.id, ["ready"], { timeoutMs: 170_000 });
  expect(completed.revision).toBe(1);
  const events = await stack.readEvents(created.id);
  const buildingStart = events.findIndex((event) => (
    event.stage === "building" && event.type === "stage" && event.status === "running"
  ));
  expect(buildingStart).toBeGreaterThan(0);
  expect(events.slice(0, buildingStart).some((event) => event.stage === "building")).toBe(false);
  expect(events.slice(0, buildingStart).some((event) => (
    event.stage === "calibrating" && event.type === "progress"
  ))).toBe(true);
  expect(await stack.getMockDiagnostics()).toEqual({
    ok: true,
    scenario: {
      markers: [
        "FAIL_HTML_524_ONCE_PAGE_2",
        "MOCK_CALIBRATION_FALLBACK",
        "MOCK_FAIL_BUILD_BATCH_ONCE",
      ],
      calibrationGenerationCount: 3,
      calibrationReviewFailures: 1,
      calibrationOverflowResponses: 1,
      buildBatchRequests: 2,
      buildFailures: 1,
      buildSuccesses: 1,
      imageRequests: 2,
      imageHtml524Failures: 1,
      imageRetrySuccesses: 1,
      imageSuccesses: 1,
    },
  });
});

test("a forbidden model aside is repaired once without exposing speaker notes", async ({ stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  const created = await stack.createFixtureJob("data-table", {
    slideCount: 3,
    scenario: "MOCK_FORBIDDEN_ASIDE_ONCE",
  });

  const completed = await stack.waitForJob(created.id, ["ready"], { timeoutMs: 150_000 });
  expect(completed.revision).toBe(1);
  const events = await stack.readEvents(created.id);
  expect(events.filter((event) => (
    event.stage === "calibrating"
      && event.type === "progress"
      && event.message === "正在请求模型生成校准页面"
  ))).toHaveLength(2);
  expect(events.some((event) => event.status === "failed")).toBe(false);
  expect((await stack.getMockDiagnostics()).scenario).toMatchObject({
    markers: ["MOCK_FORBIDDEN_ASIDE_ONCE"],
    calibrationGenerationCount: 2,
  });
});

test("an unscoped model selector is repaired once and the deck reaches ready", async ({ stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  const created = await stack.createFixtureJob("data-table", {
    slideCount: 3,
    scenario: "MOCK_UNSCOPED_SELECTOR_ONCE",
  });

  const completed = await stack.waitForJob(created.id, ["ready"], { timeoutMs: 150_000 });
  expect(completed.revision).toBe(1);
  const events = await stack.readEvents(created.id);
  expect(events.filter((event) => (
    event.stage === "calibrating"
      && event.type === "progress"
      && event.message === "正在请求模型生成校准页面"
  ))).toHaveLength(2);
  expect(events.some((event) => event.status === "failed")).toBe(false);
  expect((await stack.getMockDiagnostics()).scenario).toMatchObject({
    markers: ["MOCK_UNSCOPED_SELECTOR_ONCE"],
    calibrationGenerationCount: 2,
    unscopedSelectorResponses: 1,
  });
});

test("a delayed build can be cancelled without publishing a revision", async ({ page, stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  const created = await stack.createFixtureJob("dense-report", {
    slideCount: 3,
    scenario: "MOCK_DELAY_BUILD_CANCEL",
  });
  await openJob(page, stack.appOrigin, created.id);
  await expect(page.getByRole("button", { name: "生成幻灯片页面" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "取消任务" }).click();
  const cancelled = await stack.waitForJob(created.id, ["cancelled"], { timeoutMs: 30_000 });
  expect(cancelled.revision).toBe(0);
  await expect(page.locator(".deck-agent-status")).toHaveText("已取消");
});

test("visual repair publishes ready while a persistent visual issue publishes needs-review", async ({ stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  const repaired = await stack.createFixtureJob("data-table", { scenario: "MOCK_VISUAL_REPAIR_ONCE" });
  await expect.poll(
    async () => (await stack.getJob(repaired.id)).status,
    { timeout: 150_000 },
  ).toBe("ready");

  const persistent = await stack.createFixtureJob("data-table", { scenario: "MOCK_NEEDS_REVIEW_PERSISTENT" });
  await expect.poll(
    async () => (await stack.getJob(persistent.id)).status,
    { timeout: 150_000 },
  ).toBe("needs-review");
});

test("targeted natural-language edits publish atomically, failed QA rolls back, and undo restores the parent", async ({ page, stack }, testInfo) => {
  desktopOnly(testInfo.project.name);
  const seeded = await stack.seedPublishedJob("data-table");
  await openJob(page, stack.appOrigin, seeded.jobId);
  const frame = page.frameLocator('iframe[title="HTML 幻灯片预览"]');
  await expect(frame.locator('[data-slide-id="slide-01"]')).toBeVisible();
  const firstHeading = await frame.locator('[data-slide-id="slide-01"] h1').textContent();
  const secondHeading = await frame.locator('[data-slide-id="slide-02"] h1').textContent();

  await page.getByText("选择明确页面").click();
  await page.getByRole("checkbox", { name: "第 2 页" }).check();
  await page.getByRole("textbox", { name: "修改要求" }).fill("突出第二页的经营结论 MOCK_SCOPED_EDIT_SUCCESS");
  await page.getByRole("button", { name: "发送修改" }).click();
  await expect.poll(async () => (await stack.getJob(seeded.jobId)).revision, { timeout: 90_000 }).toBe(2);
  await expect(frame.locator('[data-slide-id="slide-02"] h1')).toHaveText("突出第二页的经营结论");
  await expect(frame.locator('[data-slide-id="slide-01"] h1')).toHaveText(firstHeading ?? "");

  await page.getByRole("textbox", { name: "修改要求" }).fill("破坏第二页的层级 MOCK_SCOPED_EDIT_FAILURE");
  await page.getByRole("button", { name: "发送修改" }).click();
  await expect(page.getByRole("alert")).toContainText(/failed QA|Candidate revision/i, { timeout: 90_000 });
  expect((await stack.getJob(seeded.jobId)).revision).toBe(2);
  await expect(frame.locator('[data-slide-id="slide-02"] h1')).toHaveText("突出第二页的经营结论");

  await page.getByRole("button", { name: "撤销上一版" }).click();
  await expect.poll(async () => (await stack.getJob(seeded.jobId)).revision).toBe(1);
  await expect(frame.locator('[data-slide-id="slide-02"] h1')).toHaveText(secondHeading ?? "");
  await expect(page.getByRole("link", { name: "下载 HTML 演示" })).toBeVisible();
});
