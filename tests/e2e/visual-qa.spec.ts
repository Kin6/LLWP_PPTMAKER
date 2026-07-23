import { PNG } from "pngjs";
import { expect, test } from "../helpers/start-deck-agent-stack.mjs";

test.describe.configure({ timeout: 120_000 });

function occupancy(buffer: Buffer): number {
  const png = PNG.sync.read(buffer);
  const [red, green, blue] = png.data;
  let changed = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const delta = Math.abs(png.data[offset] - red)
      + Math.abs(png.data[offset + 1] - green)
      + Math.abs(png.data[offset + 2] - blue);
    if (delta > 18 && png.data[offset + 3] > 0) changed += 1;
  }
  return changed / (png.width * png.height);
}

async function inspectFixture(page: Parameters<typeof test>[0]["page"], stack: Parameters<typeof test>[0]["stack"], name: string) {
  const seeded = await stack.seedPublishedJob(name);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${stack.appOrigin}/?job=${seeded.jobId}`);
  const frame = page.frameLocator('iframe[title="HTML 幻灯片预览"]');
  await expect(frame.locator(".reveal.ready")).toBeVisible();

  const report = await frame.locator("body").evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
    const roots = [...document.querySelectorAll<HTMLElement>("[data-slide-id]")];
    const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map((node) => node.id);
    return {
      roots: roots.map((root) => {
        const style = getComputedStyle(root);
        return {
          slideId: root.dataset.slideId,
          width: Number.parseFloat(style.width),
          height: Number.parseFloat(style.height),
        };
      }),
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      fontFailures: document.fonts ? [...document.fonts].filter((font) => font.status === "error").length : 0,
      charts: [...document.querySelectorAll<HTMLElement>("[data-chart-id]")].map((chart) => ({
        chartId: chart.dataset.chartId,
        ready: chart.dataset.chartReady === "true",
        canvases: chart.querySelectorAll("canvas").length,
      })),
      images: [...document.images].map((image) => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
      })),
    };
  });

  expect(report.roots).toHaveLength(seeded.slideIds.length);
  for (const root of report.roots) {
    expect(root.width).toBe(1920);
    expect(root.height).toBe(1080);
    expect(root.width / root.height).toBeCloseTo(16 / 9, 5);
  }
  expect(report.duplicateIds).toEqual([]);
  expect(report.fontFailures).toBe(0);
  expect(report.images.length).toBeGreaterThan(0);
  expect(report.images.every((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  if (name === "data-table") {
    expect(report.charts).toHaveLength(1);
    expect(report.charts[0]).toMatchObject({ chartId: "chart-operating-loss", ready: true });
    expect(report.charts[0].canvases).toBeGreaterThan(0);
  } else {
    expect(report.charts).toHaveLength(0);
  }

  for (const [index, slideId] of seeded.slideIds.entries()) {
    await frame.locator("body").evaluate((_body, slideIndex) => {
      (globalThis as typeof globalThis & { Reveal?: { slide: (index: number) => void } }).Reveal?.slide(slideIndex);
    }, index);
    const slide = frame.locator(`[data-slide-id="${slideId}"]`);
    await expect(slide).toBeVisible();
    const visibleGeometry = await slide.evaluate((root) => {
      const rootRect = root.getBoundingClientRect();
      const outOfBounds = [...root.querySelectorAll<HTMLElement>("*")].filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return false;
        return rect.left < rootRect.left - 1
          || rect.top < rootRect.top - 1
          || rect.right > rootRect.right + 1
          || rect.bottom > rootRect.bottom + 1;
      }).map((node) => node.tagName.toLowerCase());
      return {
        width: root.clientWidth,
        height: root.clientHeight,
        horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
        verticalOverflow: root.scrollHeight > root.clientHeight + 1,
        brokenImages: [...root.querySelectorAll<HTMLImageElement>("img")]
          .filter((image) => !image.complete || image.naturalWidth === 0).length,
        outOfBounds,
      };
    });
    expect(visibleGeometry.width).toBe(1920);
    expect(visibleGeometry.height).toBe(1080);
    expect(visibleGeometry.horizontalOverflow).toBe(false);
    expect(visibleGeometry.verticalOverflow).toBe(false);
    expect(visibleGeometry.brokenImages).toBe(0);
    expect(visibleGeometry.outOfBounds).toEqual([]);
    expect(occupancy(await slide.screenshot({ animations: "disabled" }))).toBeGreaterThan(0.005);
  }
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
}

test("dense and table fixtures satisfy 1920x1080 bounds, nonblank occupancy, DOM, font, image, chart, and console checks", async ({ page, stack }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Internal slide geometry is verified at the fixed 1920x1080 canvas.");
  await inspectFixture(page, stack, "dense-report");
  await inspectFixture(page, stack, "data-table");
});
