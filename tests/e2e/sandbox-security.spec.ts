import { expect, test } from "../helpers/start-deck-agent-stack.mjs";

test.describe.configure({ timeout: 90_000 });

test("preview cannot read parent state, navigate, submit, open popups, frame content, show dialogs, or use the network", async ({ page, stack, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Security isolation is viewport-independent.");
  const dialogs: string[] = [];
  const popupUrls: string[] = [];
  const externalRequests: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  context.on("page", (popup) => popupUrls.push(popup.url()));
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(stack.appOrigin)) externalRequests.push(url);
  });

  await page.goto(stack.appOrigin);
  await page.evaluate(() => {
    localStorage.setItem("deck-secret-sentinel", "must-not-leak");
    document.cookie = "deck-cookie-sentinel=must-not-leak; SameSite=Strict";
  });
  const seeded = await stack.seedPublishedJob("security-fixture");
  await page.goto(`${stack.appOrigin}/?job=${seeded.jobId}`);
  const iframe = page.locator('iframe[title="HTML 幻灯片预览"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator('iframe[title="HTML 幻灯片预览"]');
  await expect(frame.locator("body")).not.toContainText("must-not-leak");

  const capabilities = await frame.locator("body").evaluate(async () => {
    const attempt = (operation: () => unknown) => {
      try { return { blocked: false, value: String(operation()) }; }
      catch (error) { return { blocked: true, value: error instanceof Error ? error.name : String(error) }; }
    };
    const storage = attempt(() => localStorage.getItem("deck-secret-sentinel"));
    const cookie = attempt(() => document.cookie);
    const parentStorage = attempt(() => parent.localStorage.getItem("deck-secret-sentinel"));
    const topLocation = attempt(() => top?.location.href);
    const popup = attempt(() => window.open("https://attacker.invalid/popup", "_blank"));
    const form = document.createElement("form");
    form.action = "https://attacker.invalid/form";
    form.method = "post";
    form.target = "_top";
    document.body.append(form);
    const formSubmit = attempt(() => form.submit());
    const nested = document.createElement("iframe");
    nested.src = "https://attacker.invalid/frame";
    document.body.append(nested);
    const network = await fetch("https://attacker.invalid/fetch").then(
      () => ({ blocked: false }),
      (error) => ({ blocked: true, value: error instanceof Error ? error.name : String(error) }),
    );
    alert("sandbox-dialog");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { storage, cookie, parentStorage, topLocation, popup, formSubmit, network };
  });

  expect(capabilities.storage.blocked).toBe(true);
  expect(capabilities.parentStorage.blocked).toBe(true);
  expect(capabilities.topLocation.blocked).toBe(true);
  expect(capabilities.cookie.blocked || capabilities.cookie.value === "").toBe(true);
  expect(capabilities.popup.blocked || capabilities.popup.value === "null").toBe(true);
  expect(capabilities.formSubmit.blocked || page.url().startsWith(stack.appOrigin)).toBe(true);
  expect(capabilities.network.blocked).toBe(true);
  expect(externalRequests).toEqual([]);
  expect(popupUrls).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(page.url()).toContain(`?job=${seeded.jobId}`);
});

test("forged preview messages with wrong token, job, revision, slide, source, or origin are ignored", async ({ page, stack }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Message-channel isolation is viewport-independent.");
  const seeded = await stack.seedPublishedJob("data-table");
  await page.goto(`${stack.appOrigin}/?job=${seeded.jobId}`);
  const frame = page.frameLocator('iframe[title="HTML 幻灯片预览"]');
  await expect(frame.locator('[data-slide-id="slide-01"]')).toBeVisible();
  const counter = page.locator(".deck-agent-deck-preview__navigation span");
  const frameSrc = await page.locator('iframe[title="HTML 幻灯片预览"]').getAttribute("src");
  const token = new URL(frameSrc || "", stack.appOrigin).hash.match(/(?:^#|&)channel=([^&]+)/)?.[1] || null;
  expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  if (!token) throw new Error("Preview channel token is missing");

  const base = {
    type: "deck-slide-changed",
    channelToken: token,
    jobId: seeded.jobId,
    revision: 1,
    slideId: "slide-02",
  };
  await frame.locator("body").evaluate((_body, message) => parent.postMessage(message, "*"), base);
  await expect(counter).toHaveText("2 / 2");
  await expect(page.getByText("当前页 slide-02")).toBeVisible();
  await frame.locator("body").evaluate(
    (_body, message) => parent.postMessage(message, "*"),
    { ...base, slideId: "slide-01" },
  );
  await expect(counter).toHaveText("1 / 2");
  await expect(page.getByText("当前页 slide-01")).toBeVisible();
  const before = await counter.textContent();

  for (const forged of [
    { ...base, channelToken: "A".repeat(22) },
    { ...base, jobId: "job-00000000-0000-4000-8000-000000000099" },
    { ...base, revision: 999 },
    { ...base, slideId: "slide-99" },
    { ...base, unexpected: true },
  ]) {
    await frame.locator("body").evaluate((_body, message) => parent.postMessage(message, "*"), forged);
  }
  await page.evaluate(({ message }) => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="HTML 幻灯片预览"]');
    window.dispatchEvent(new MessageEvent("message", {
      data: message,
      origin: location.origin,
      source: iframe?.contentWindow ?? null,
    }));
    window.dispatchEvent(new MessageEvent("message", {
      data: message,
      origin: "null",
      source: null,
    }));
  }, { message: base });

  await page.waitForTimeout(100);
  await expect(counter).toHaveText(before ?? "");
  await expect(page.getByText("当前页 slide-01")).toBeVisible();
});
