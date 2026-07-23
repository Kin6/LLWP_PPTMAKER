import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const REVISION_ID = /^(?:working|revision-\d{6})$/;
const SLIDE_ID = /^slide-\d{2}$/;
const ARTIFACT_ID = /^[a-z0-9-]+$/;
const SOURCE_ID = /^[A-Za-z0-9._-]+$/;
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const IGNORED_BROWSER_CONSOLE_ERRORS = new Set([
  "Unrecognized Content-Security-Policy directive 'navigate-to'.",
]);
const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const DEFAULT_TOTAL_CAPTURE_BYTES = 256 * 1024 * 1024;
const DEFAULT_PROFILE_BYTES = 128 * 1024 * 1024;
const MAX_SLIDES = 50;

export function createVerifier({
  renderer,
  browserFactory = chromium,
  outlineReader,
  profileRoot = os.tmpdir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxScreenshotBytes = DEFAULT_SCREENSHOT_BYTES,
  maxTotalCaptureBytes = DEFAULT_TOTAL_CAPTURE_BYTES,
  maxProfileBytes = DEFAULT_PROFILE_BYTES,
} = {}) {
  if (!renderer || typeof renderer.readManifest !== "function"
    || typeof renderer.assembleStandalone !== "function"
    || typeof renderer.writeQaArtifact !== "function") {
    throw new TypeError("Verifier requires a renderer with manifest, assembly, and QA artifact methods");
  }
  if (!browserFactory || typeof browserFactory.launchPersistentContext !== "function") {
    throw new TypeError("Verifier requires a Playwright browser factory");
  }
  if (outlineReader !== undefined && typeof outlineReader !== "function") {
    throw new TypeError("outlineReader must be a function");
  }
  if (typeof profileRoot !== "string" || !profileRoot) throw new TypeError("profileRoot is required");
  assertPositiveLimit(timeoutMs, "Verification timeout");
  assertPositiveLimit(maxScreenshotBytes, "Screenshot quota");
  assertPositiveLimit(maxTotalCaptureBytes, "Capture quota");
  assertPositiveLimit(maxProfileBytes, "Profile quota");

  return Object.freeze({
    async verify({ jobId, revisionId, slideIds, captureContactSheet = false, signal } = {}) {
      validateRequest({ jobId, revisionId, slideIds, captureContactSheet });
      const lifecycle = createLifecycleSignal(signal, timeoutMs);
      let context;
      let page;
      let contactPage;
      let profileDir;

      try {
        const manifest = await abortable(renderer.readManifest({ jobId, revisionId }), lifecycle.signal);
        const outline = outlineReader
          ? await abortable(outlineReader({ jobId }), lifecycle.signal)
          : typeof renderer.readOutline === "function"
            ? await abortable(renderer.readOutline({ jobId }), lifecycle.signal)
            : undefined;
        validateManifest({ manifest, outline, slideIds });

        const html = await abortable(renderer.assembleStandalone({ jobId, revisionId }), lifecycle.signal);
        if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > 256 * 1024 * 1024) {
          throw new Error("Assembled verification HTML is invalid or exceeds its byte limit");
        }

        await fs.mkdir(profileRoot, { recursive: true });
        profileDir = await fs.mkdtemp(path.join(profileRoot, `deck-verify-${jobId}-`));
        lifecycle.signal.throwIfAborted();
        context = await abortable(browserFactory.launchPersistentContext(profileDir, {
          headless: true,
          chromiumSandbox: true,
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
          javaScriptEnabled: true,
          serviceWorkers: "block",
          acceptDownloads: false,
          locale: "en-US",
          timezoneId: "UTC",
          colorScheme: "light",
          reducedMotion: "reduce",
        }), lifecycle.signal);

        const blockedRequests = [];
        let currentSlideId = slideIds[0];
        await abortable(context.route("**/*", async (route) => {
          const requestUrl = route.request().url();
          let protocol;
          try {
            protocol = new URL(requestUrl).protocol;
          } catch {
            protocol = "invalid:";
          }
          if (NETWORK_PROTOCOLS.has(protocol) || protocol === "invalid:") {
            blockedRequests.push({ slideId: currentSlideId, url: boundedText(requestUrl, 500) });
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        }), lifecycle.signal);

        page = context.pages()[0] || await abortable(context.newPage(), lifecycle.signal);
        page.setDefaultTimeout(Math.min(timeoutMs, 30_000));
        const consoleErrors = [];
        page.on("console", (message) => {
          if (message.type() === "error") {
            const text = boundedText(message.text(), 1_000);
            if (!IGNORED_BROWSER_CONSOLE_ERRORS.has(text)) {
              consoleErrors.push({ slideId: currentSlideId, message: text });
            }
          }
        });
        page.on("pageerror", (error) => {
          consoleErrors.push({ slideId: currentSlideId, message: boundedText(error.message, 1_000) });
        });

        const deckPath = path.join(profileDir, "verification-deck.html");
        await abortable(fs.writeFile(deckPath, html, { flag: "wx", mode: 0o600 }), lifecycle.signal);
        await abortable(page.goto(pathToFileURL(deckPath).href, { waitUntil: "load" }), lifecycle.signal);
        await abortable(page.evaluate(async () => {
          if (document.fonts) await document.fonts.ready;
        }), lifecycle.signal);
        await assertProfileQuota(profileDir, maxProfileBytes);

        const domSlides = await abortable(page.evaluate(collectDomReport), lifecycle.signal);
        const domById = new Map();
        for (const item of domSlides) {
          const existing = domById.get(item.slideId) || [];
          existing.push(item);
          domById.set(item.slideId, existing);
        }

        const captures = [];
        const slides = [];
        let totalCaptureBytes = 0;
        for (const slideId of slideIds) {
          lifecycle.signal.throwIfAborted();
          currentSlideId = slideId;
          const index = manifest.slides.findIndex((slide) => slide.slideId === slideId);
          await abortable(page.evaluate(({ targetSlideId, targetIndex }) => {
            const roots = [...document.querySelectorAll("[data-slide-id]")];
            if (globalThis.Reveal && typeof globalThis.Reveal.slide === "function") {
              globalThis.Reveal.slide(targetIndex);
            } else {
              for (const root of roots) root.hidden = root.dataset.slideId !== targetSlideId;
            }
          }, { targetSlideId: slideId, targetIndex: index }), lifecycle.signal);
          await abortable(page.evaluate(() => new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          })), lifecycle.signal);

          const screenshot = await abortable(page.screenshot({
            type: "png",
            clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
            animations: "disabled",
            caret: "hide",
            scale: "css",
          }), lifecycle.signal);
          assertCaptureQuota(screenshot, maxScreenshotBytes, totalCaptureBytes, maxTotalCaptureBytes);
          totalCaptureBytes += screenshot.length;

          const reports = domById.get(slideId) || [];
          const issues = reports.length === 1 ? issuesFromDom(reports[0]) : [reports.length ? "duplicate-slide-root" : "missing-slide-root"];
          if (isBlankPng(screenshot)) issues.push("blank-canvas");
          if (blockedRequests.some((request) => request.slideId === slideId)) issues.push("network-request-blocked");

          const artifact = await abortable(renderer.writeQaArtifact({
            jobId,
            revisionId,
            filename: `slides/${slideId}.png`,
            data: screenshot,
            signal: lifecycle.signal,
          }), lifecycle.signal);
          validateArtifactResult(artifact);
          captures.push({ slideId, screenshot });
          slides.push({ slideId, issues: [...new Set(issues)], screenshotArtifactId: artifact.artifactId });
          await assertProfileQuota(profileDir, maxProfileBytes);
        }

        let contactSheetArtifactId = null;
        if (captureContactSheet) {
          currentSlideId = slideIds[0];
          contactPage = await abortable(context.newPage(), lifecycle.signal);
          contactPage.setDefaultTimeout(Math.min(timeoutMs, 30_000));
          await abortable(contactPage.setContent(buildContactSheet(captures), { waitUntil: "load" }), lifecycle.signal);
          const screenshot = await abortable(contactPage.screenshot({
            type: "png", fullPage: true, animations: "disabled", caret: "hide", scale: "css",
          }), lifecycle.signal);
          assertCaptureQuota(screenshot, maxScreenshotBytes, totalCaptureBytes, maxTotalCaptureBytes);
          totalCaptureBytes += screenshot.length;
          const artifact = await abortable(renderer.writeQaArtifact({
            jobId,
            revisionId,
            filename: "contact-sheet.png",
            data: screenshot,
            signal: lifecycle.signal,
          }), lifecycle.signal);
          validateArtifactResult(artifact);
          contactSheetArtifactId = artifact.artifactId;
          await assertProfileQuota(profileDir, maxProfileBytes);
        }

        const deduplicatedErrors = deduplicateConsoleErrors(consoleErrors);
        return {
          ok: slides.every((slide) => slide.issues.length === 0) && deduplicatedErrors.length === 0,
          slides,
          contactSheetArtifactId,
          consoleErrors: deduplicatedErrors,
        };
      } finally {
        lifecycle.dispose();
        await closeQuietly(contactPage);
        await closeQuietly(page);
        await closeQuietly(context);
        if (profileDir) await fs.rm(profileDir, { recursive: true, force: true });
      }
    },
  });
}

export function mergeQaEvidence(dom, visual) {
  const visualIssues = new Map((visual?.failedSlides || []).map((item) => [
    item.slideId,
    (item.reasons || []).map((reason) => `visual:${reason}`),
  ]));
  const slides = dom.slides.map((slide) => ({
    ...slide,
    issues: [...new Set([...slide.issues, ...(visualIssues.get(slide.slideId) || [])])],
  }));
  return {
    ...dom,
    slides,
    ok: slides.every((slide) => slide.issues.length === 0) && dom.consoleErrors.length === 0,
  };
}

export function mergeVerificationReports(base, replacement, slideIds) {
  const target = new Set(slideIds);
  const byId = new Map(replacement.slides.map((slide) => [slide.slideId, slide]));
  const slides = base.slides.map((slide) => target.has(slide.slideId) ? byId.get(slide.slideId) || slide : slide);
  const consoleErrors = deduplicateConsoleErrors([
    ...base.consoleErrors.filter((error) => !target.has(error.slideId)),
    ...replacement.consoleErrors,
  ]);
  return {
    ...base,
    slides,
    consoleErrors,
    ok: slides.every((slide) => slide.issues.length === 0) && consoleErrors.length === 0,
  };
}

export function failedSlideIds(report) {
  return [...new Set([
    ...report.slides.filter((slide) => slide.issues.length > 0).map((slide) => slide.slideId),
    ...report.consoleErrors.map((error) => error.slideId),
  ])];
}

function validateRequest({ jobId, revisionId, slideIds, captureContactSheet }) {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid job identity");
  if (!REVISION_ID.test(revisionId)) throw new Error("Invalid revision identity");
  if (!Array.isArray(slideIds) || slideIds.length === 0 || slideIds.length > MAX_SLIDES
    || slideIds.some((slideId) => !SLIDE_ID.test(slideId))
    || new Set(slideIds).size !== slideIds.length) {
    throw new Error("Invalid or duplicate verification slide IDs");
  }
  if (typeof captureContactSheet !== "boolean") throw new Error("captureContactSheet must be boolean");
}

function validateManifest({ manifest, outline, slideIds }) {
  if (!manifest || !Array.isArray(manifest.slides) || manifest.slides.length === 0 || manifest.slides.length > MAX_SLIDES) {
    throw new Error("Manifest must contain a bounded slide list");
  }
  const manifestIds = manifest.slides.map((slide) => slide?.slideId);
  if (manifestIds.some((slideId) => !SLIDE_ID.test(slideId)) || new Set(manifestIds).size !== manifestIds.length) {
    throw new Error("Manifest slide identities must be stable and unique");
  }
  for (const slide of manifest.slides) {
    if (typeof slide.speakerNotes !== "string" || !slide.speakerNotes.trim()) {
      throw new Error(`Manifest speaker notes are required for ${slide.slideId}`);
    }
    if (!Array.isArray(slide.sourceRefs) || slide.sourceRefs.length === 0
      || slide.sourceRefs.some((sourceRef) => typeof sourceRef !== "string" || !SOURCE_ID.test(sourceRef))
      || new Set(slide.sourceRefs).size !== slide.sourceRefs.length) {
      throw new Error(`Manifest source references are invalid for ${slide.slideId}`);
    }
  }

  if (outline !== undefined) {
    if (!outline || !Array.isArray(outline.slides) || outline.slides.length !== manifest.slides.length) {
      throw new Error("Manifest order does not match the parsed outline");
    }
    for (let index = 0; index < manifest.slides.length; index += 1) {
      const stored = manifest.slides[index];
      const parsed = outline.slides[index];
      if (stored.slideId !== parsed?.slideId
        || stored.speakerNotes !== parsed.speakerNotes
        || !sameStringArray(stored.sourceRefs, parsed.sourceBlockIds)) {
        throw new Error(`Manifest does not match parsed outline at ${stored.slideId}`);
      }
    }
  }

  const requested = new Set(slideIds);
  const expectedOrder = manifestIds.filter((slideId) => requested.has(slideId));
  if (!sameStringArray(expectedOrder, slideIds)) throw new Error("Verification slide IDs must follow manifest order");
}

function collectDomReport() {
  const roots = [...document.querySelectorAll("[data-slide-id]")];
  const allIds = [...document.querySelectorAll("[id]")].map((node) => node.id);
  const duplicateIdSet = new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index));
  const fontErrors = document.fonts ? [...document.fonts].filter((font) => font.status === "error").length : 0;
  return roots.map((root) => {
    const bounds = root.getBoundingClientRect();
    const descendants = [...root.querySelectorAll("*")];
    return {
      slideId: root.dataset.slideId,
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      verticalOverflow: root.scrollHeight > root.clientHeight + 1,
      outsideSafeArea: descendants.some((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.left < bounds.left - 1 || rect.top < bounds.top - 1
          || rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1;
      }),
      brokenImages: [...root.querySelectorAll("img")].filter((image) => !image.complete || image.naturalWidth === 0).length,
      duplicateIds: [...root.querySelectorAll("[id]")].map((node) => node.id).filter((id) => duplicateIdSet.has(id)),
      visibleTextLength: (root.textContent || "").trim().length,
      fontErrors,
    };
  });
}

function issuesFromDom(report) {
  const issues = [];
  if (report.horizontalOverflow) issues.push("horizontal-overflow");
  if (report.verticalOverflow) issues.push("vertical-overflow");
  if (report.outsideSafeArea) issues.push("outside-safe-area");
  if (report.brokenImages > 0) issues.push("broken-image");
  if (report.duplicateIds.length > 0) issues.push("duplicate-id");
  if (report.fontErrors > 0) issues.push("font-load-failed");
  return issues;
}

function isBlankPng(buffer) {
  let png;
  try {
    png = PNG.sync.read(buffer);
  } catch (error) {
    throw new Error(`Invalid PNG screenshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  const corners = [
    pixelAt(png, 0, 0),
    pixelAt(png, png.width - 1, 0),
    pixelAt(png, 0, png.height - 1),
    pixelAt(png, png.width - 1, png.height - 1),
  ];
  const counts = new Map();
  for (const color of corners) counts.set(color.join(","), (counts.get(color.join(",")) || 0) + 1);
  const dominantKey = [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  const dominant = dominantKey.split(",").map(Number);
  let different = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    if (Math.abs(png.data[index] - dominant[0]) > 12
      || Math.abs(png.data[index + 1] - dominant[1]) > 12
      || Math.abs(png.data[index + 2] - dominant[2]) > 12) {
      different += 1;
    }
  }
  return different / (png.width * png.height) < 0.005;
}

function pixelAt(png, x, y) {
  const index = (y * png.width + x) * 4;
  return [png.data[index], png.data[index + 1], png.data[index + 2]];
}

function buildContactSheet(captures) {
  const items = captures.map(({ slideId, screenshot }) => `<figure><img alt="${escapeHtml(slideId)}" src="data:image/png;base64,${screenshot.toString("base64")}"><figcaption>${escapeHtml(slideId)}</figcaption></figure>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:1920px;background:#18232c;color:#fff;font-family:Arial,sans-serif}main{display:grid;grid-template-columns:repeat(4,480px);gap:0}figure{box-sizing:border-box;margin:0;padding:12px;width:480px;height:304px}img{display:block;width:456px;height:257px;object-fit:contain;background:#fff}figcaption{font-size:18px;line-height:23px}</style><main>${items}</main>`;
}

function createLifecycleSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal.reason || new Error("Verification cancelled"));
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Verification timed out")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Verification cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("Verification cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function validateArtifactResult(artifact) {
  if (!artifact || !ARTIFACT_ID.test(artifact.artifactId) || typeof artifact.relativePath !== "string" || artifact.relativePath.length > 300) {
    throw new Error("Renderer returned an invalid QA artifact descriptor");
  }
}

function assertCaptureQuota(buffer, maxScreenshotBytes, capturedBytes, maxTotalCaptureBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > maxScreenshotBytes) {
    throw new Error("Screenshot quota limit exceeded");
  }
  if (capturedBytes + buffer.length > maxTotalCaptureBytes) throw new Error("Capture quota limit exceeded");
}

async function assertProfileQuota(directory, maxProfileBytes) {
  if (await directoryBytes(directory) > maxProfileBytes) throw new Error("Browser profile quota limit exceeded");
}

async function directoryBytes(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Browser profile symbolic links are forbidden");
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) {
      try {
        total += (await fs.stat(child)).size;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return total;
}

async function closeQuietly(resource) {
  if (!resource || typeof resource.close !== "function") return;
  await Promise.race([
    resource.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

function deduplicateConsoleErrors(errors) {
  return errors.filter((error, index, all) => all.findIndex((candidate) => (
    candidate.slideId === error.slideId && candidate.message === error.message
  )) === index);
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function boundedText(value, maxLength) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maxLength);
}

function assertPositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}
