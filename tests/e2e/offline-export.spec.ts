import fs from "node:fs/promises";
import { expect, test } from "../helpers/start-deck-agent-stack.mjs";

test.describe.configure({ timeout: 90_000 });

test("downloaded standalone deck works from file URL with all network aborted and contains no operational secrets", async ({ browser, page, stack }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Standalone behavior is viewport-independent.");
  const seeded = await stack.seedPublishedJob("data-table");
  await page.goto(`${stack.appOrigin}/?job=${seeded.jobId}`);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载 HTML 演示" }).click();
  const download = await downloadPromise;
  const target = testInfo.outputPath("standalone-deck.html");
  await download.saveAs(target);

  const source = await fs.readFile(target, "utf8");
  expect(source).toMatch(/^<!doctype html>/i);
  expect(source).not.toMatch(/https?:\/\//i);
  expect(source).not.toMatch(/(?:OPENAI|IMAGE|TEXT)_API_(?:KEY|BASE(?:_URL)?|URL|PROVIDER)|(?:TEXT|IMAGE)_MODEL/i);
  expect(source).not.toMatch(/test-key|mock-(?:vision|image)/i);
  expect(source).not.toMatch(/system\s*prompt|toolCalls|DECK_JOB_ROOT|deck-job-root|\.deck-jobs/i);
  expect(source).not.toContain(seeded.jobId);

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  const attemptedNetwork: string[] = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (/^https?:/i.test(url)) {
      attemptedNetwork.push(url);
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  });
  const offline = await context.newPage();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  offline.on("pageerror", (error) => errors.push(error.message));
  offline.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await offline.goto(new URL(`file://${target}`).href);
  await expect(offline.locator('[data-slide-id="slide-01"]')).toBeVisible();
  await offline.keyboard.press("ArrowRight");
  await expect(offline.locator('[data-slide-id="slide-02"]')).toBeVisible();
  await offline.keyboard.press("ArrowLeft");
  await expect(offline.locator('[data-slide-id="slide-01"]')).toBeVisible();
  expect(attemptedNetwork).toEqual([]);
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await context.close();
});
