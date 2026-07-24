import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVerifier,
  failedSlideIds,
  mergeQaEvidence,
  mergeVerificationReports,
} from "../../../server/deck-agent/verifier.mjs";

const jobId = "job-00000000-0000-4000-8000-000000000001";
const revisionId = "revision-000099";
const slideIds = ["slide-01", "slide-02"];
const temporaryRoots = [];
const manifest = {
  slides: [
    { slideId: "slide-01", title: "Evidence", speakerNotes: "Explain evidence.", sourceRefs: ["block-018"] },
    { slideId: "slide-02", title: "Blank", speakerNotes: "Explain blank.", sourceRefs: ["block-031"] },
  ],
};
const outline = {
  slides: [
    { slideId: "slide-01", speakerNotes: "Explain evidence.", sourceBlockIds: ["block-018"] },
    { slideId: "slide-02", speakerNotes: "Explain blank.", sourceBlockIds: ["block-031"] },
  ],
};
const hostileDeck = `<!doctype html>
<meta charset="utf-8">
<style>
html,body{width:1920px;height:1080px;margin:0;overflow:hidden;background:#fff}
[data-slide-id]{box-sizing:border-box;position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;background:#fff;color:#111}
.wide{width:2050px;height:200px;background:#075ccb}
</style>
<article data-slide-id="slide-01"><div class="wide" id="duplicate">Evidence</div><p id="duplicate">Duplicate</p><img src="https://evil.invalid/missing.png" alt="broken"></article>
<article data-slide-id="slide-02"></article>
<script>if (location.protocol === "about:") console.error("opaque verification URL"); history.replaceState(null, "", ""); console.error("Unrecognized Content-Security-Policy directive 'navigate-to'."); console.error("runtime boom")</script>`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createFakeRenderer(html = hostileDeck, currentManifest = manifest) {
  const writes = [];
  return {
    writes,
    async readManifest() { return structuredClone(currentManifest); },
    async assembleStandalone() { return html; },
    async writeQaArtifact({ filename, data }) {
      writes.push({ filename, data: Buffer.from(data) });
      return { artifactId: `qa-${filename.replace(/[^a-z0-9]+/g, "-")}`, relativePath: `qa/${filename}` };
    },
  };
}

describe("verification report combiners", () => {
  it("merges visual findings and returns stable failed slide IDs", () => {
    const dom = {
      ok: false,
      slides: [
        { slideId: "slide-01", issues: ["horizontal-overflow"] },
        { slideId: "slide-02", issues: [] },
      ],
      consoleErrors: [{ slideId: "slide-02", message: "boom" }],
    };
    const merged = mergeQaEvidence(dom, {
      failedSlides: [
        { slideId: "slide-01", reasons: ["crowded", "crowded"] },
        { slideId: "slide-02", reasons: ["weak-hierarchy"] },
      ],
    });

    expect(merged.slides[0].issues).toEqual(["horizontal-overflow", "visual:crowded"]);
    expect(merged.slides[1].issues).toEqual(["visual:weak-hierarchy"]);
    expect(merged.ok).toBe(false);
    expect(failedSlideIds(merged)).toEqual(["slide-01", "slide-02"]);
  });

  it("replaces only targeted slide and console evidence", () => {
    const base = {
      ok: false,
      slides: [
        { slideId: "slide-01", issues: ["horizontal-overflow"] },
        { slideId: "slide-02", issues: ["blank-canvas"] },
      ],
      consoleErrors: [
        { slideId: "slide-01", message: "old" },
        { slideId: "slide-02", message: "keep" },
      ],
    };
    const replacement = {
      slides: [{ slideId: "slide-01", issues: [] }],
      consoleErrors: [
        { slideId: "slide-01", message: "new" },
        { slideId: "slide-01", message: "new" },
      ],
    };

    expect(mergeVerificationReports(base, replacement, ["slide-01"])).toEqual({
      ok: false,
      slides: [
        { slideId: "slide-01", issues: [] },
        { slideId: "slide-02", issues: ["blank-canvas"] },
      ],
      consoleErrors: [
        { slideId: "slide-02", message: "keep" },
        { slideId: "slide-01", message: "new" },
      ],
    });
  });
});

describe("browser verifier", () => {
  it("accepts empty source references when they match a source-free outline", async () => {
    const sourceFreeManifest = {
      slides: manifest.slides.map((slide) => ({ ...slide, sourceRefs: [] })),
    };
    const sourceFreeOutline = {
      slides: outline.slides.map((slide) => ({ ...slide, sourceBlockIds: [] })),
    };
    const renderer = createFakeRenderer(hostileDeck, sourceFreeManifest);
    renderer.assembleStandalone = async () => {
      throw new Error("SOURCE_FREE_MANIFEST_ACCEPTED");
    };
    const verifier = createVerifier({
      renderer,
      outlineReader: async () => sourceFreeOutline,
      browserFactory: { launchPersistentContext: () => { throw new Error("browser must not launch"); } },
    });

    await expect(verifier.verify({ jobId, revisionId, slideIds, captureContactSheet: false }))
      .rejects.toThrow("SOURCE_FREE_MANIFEST_ACCEPTED");
  });

  it("validates manifest and outline before launching Chromium", async () => {
    const renderer = createFakeRenderer(hostileDeck, {
      slides: [
        manifest.slides[0],
        { ...manifest.slides[0], speakerNotes: "" },
      ],
    });
    const verifier = createVerifier({
      renderer,
      outlineReader: async () => outline,
      browserFactory: { launchPersistentContext: () => { throw new Error("browser must not launch"); } },
    });

    await expect(verifier.verify({ jobId, revisionId, slideIds, captureContactSheet: false }))
      .rejects.toThrow(/manifest|unique|speaker notes/i);
  });

  it("reports deterministic DOM, console, network, and blank-pixel failures", async () => {
    const profileRoot = await mkdtemp(path.join(tmpdir(), "deck-verifier-test-"));
    temporaryRoots.push(profileRoot);
    const renderer = createFakeRenderer();
    let launchOptions;
    const browserFactory = {
      async launchPersistentContext(userDataDir, options) {
        launchOptions = { userDataDir, options };
        return chromium.launchPersistentContext(userDataDir, options);
      },
    };
    const verifier = createVerifier({
      renderer,
      outlineReader: async () => outline,
      browserFactory,
      profileRoot,
      timeoutMs: 30_000,
    });

    const result = await verifier.verify({
      jobId,
      revisionId,
      slideIds,
      captureContactSheet: true,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(result.slides.find((slide) => slide.slideId === "slide-01")?.issues)
      .toEqual(expect.arrayContaining(["horizontal-overflow", "outside-canvas", "outside-safe-area", "broken-image", "duplicate-id", "network-request-blocked"]));
    expect(result.slides.find((slide) => slide.slideId === "slide-02")?.issues).toContain("blank-canvas");
    expect(result.consoleErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ slideId: "slide-01", message: expect.stringContaining("runtime boom") }),
    ]));
    expect(result.consoleErrors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("opaque verification URL") }),
    ]));
    expect(result.consoleErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("Unrecognized Content-Security-Policy directive 'navigate-to'") }),
    ]));
    expect(result.slides.every((slide) => slide.screenshotArtifactId)).toBe(true);
    expect(result.contactSheetArtifactId).toBeTruthy();
    expect(renderer.writes.map((write) => write.filename).sort()).toEqual([
      "contact-sheet.png", "slides/slide-01.png", "slides/slide-02.png",
    ]);
    for (const write of renderer.writes) {
      expect(write.data.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
    expect(launchOptions.options).toMatchObject({
      headless: true,
      chromiumSandbox: true,
      javaScriptEnabled: true,
      serviceWorkers: "block",
      viewport: { width: 1920, height: 1080 },
    });
    expect(launchOptions.options.args).toBeUndefined();
    expect(await readdir(profileRoot)).toEqual([]);
  }, 40_000);

  it("allows clipped decorative bleed and reports measured content geometry", async () => {
    const geometryDeck = `<!doctype html>
<meta charset="utf-8">
<style>
html,body{width:1920px;height:1080px;margin:0;overflow:hidden;background:#fff}
[data-slide-id]{box-sizing:border-box;display:none;position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;background:#fff;color:#111}
[data-slide-id].present{display:block}
.bleed{position:absolute;left:-24px;top:180px;width:360px;height:420px;background:#075ccb;transform:rotate(-3deg)}
.bleed-right{position:absolute;right:-24px;bottom:-24px;width:260px;height:260px;background:#d9363e;transform:rotate(8deg)}
.safe-title{position:absolute;left:120px;top:100px;margin:0}
.near-edge{position:absolute;left:40px;top:120px;width:300px;margin:0}
.outside{position:absolute;left:1850px;top:400px;width:120px;margin:0}
</style>
<article class="present" data-slide-id="slide-01"><div class="bleed" data-role="decorative"></div><div class="bleed-right" data-role="decorative"></div><h1 class="safe-title">Decorative bleed</h1></article>
<article data-slide-id="slide-02"><p class="near-edge" data-role="decorative">Near edge</p><p class="outside">Outside canvas</p></article>
<script>
globalThis.Reveal = {
  isReady() { return true; },
  slide(index) {
    const slides = [...document.querySelectorAll("[data-slide-id]")];
    slides.forEach((slide, slideIndex) => slide.classList.toggle("present", slideIndex === index));
  },
};
</script>`;
    const profileRoot = await mkdtemp(path.join(tmpdir(), "deck-verifier-geometry-test-"));
    temporaryRoots.push(profileRoot);
    const verifier = createVerifier({
      renderer: createFakeRenderer(geometryDeck),
      outlineReader: async () => outline,
      profileRoot,
      timeoutMs: 30_000,
    });

    const result = await verifier.verify({
      jobId,
      revisionId,
      slideIds,
      captureContactSheet: false,
    });

    const decorative = result.slides.find((slide) => slide.slideId === "slide-01");
    expect(decorative?.issues).not.toEqual(expect.arrayContaining(["outside-canvas", "outside-safe-area"]));
    expect(decorative?.geometryViolations).toEqual([]);

    const content = result.slides.find((slide) => slide.slideId === "slide-02");
    expect(content?.issues).toEqual(expect.arrayContaining(["outside-canvas", "outside-safe-area"]));
    expect(content?.geometryViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "outside-safe-area",
        selector: ".near-edge",
        role: "content",
        overflow: expect.objectContaining({ left: 32 }),
      }),
      expect.objectContaining({
        code: "outside-canvas",
        selector: ".outside",
        role: "content",
        overflow: expect.objectContaining({ right: 50 }),
        computedStyle: expect.objectContaining({ position: "absolute" }),
      }),
    ]));
    expect(await readdir(profileRoot)).toEqual([]);
  }, 40_000);

  it("waits for asynchronous Reveal initialization before navigation and measurement", async () => {
    const revealSlideIds = ["slide-01", "slide-02", "slide-03", "slide-04"];
    const revealManifest = {
      slides: revealSlideIds.map((slideId, index) => ({
        slideId,
        title: `Slide ${index + 1}`,
        speakerNotes: `Explain slide ${index + 1}.`,
        sourceRefs: [],
      })),
    };
    const revealOutline = {
      slides: revealSlideIds.map((slideId, index) => ({
        slideId,
        speakerNotes: `Explain slide ${index + 1}.`,
        sourceBlockIds: [],
      })),
    };
    const revealDeck = `<!doctype html>
<meta charset="utf-8">
<style>
html,body{width:1920px;height:1080px;margin:0;overflow:hidden;background:#fff}
[data-slide-id]{box-sizing:border-box;display:none;position:absolute;inset:0;width:1920px;height:1080px;overflow:hidden;background:#fff;color:#111}
[data-slide-id].present{display:block}
.content{margin:100px;width:600px;height:200px;background:#075ccb}
.too-tall{height:1250px}
</style>
<article class="present" data-slide-id="slide-01"><div class="content">One</div></article>
<article data-slide-id="slide-02"><div class="content">Two</div></article>
<article data-slide-id="slide-03"><div class="content">Three</div></article>
<article data-slide-id="slide-04"><div class="content too-tall">Four</div></article>
<script>
let revealReady = false;
globalThis.Reveal = {
  isReady() { return revealReady; },
  initialize() {
    return new Promise((resolve) => setTimeout(() => {
      revealReady = true;
      resolve();
    }, 150));
  },
  slide(index) {
    if (!revealReady) throw new Error("Reveal.slide called before initialization completed");
    const slides = [...document.querySelectorAll("[data-slide-id]")];
    slides.forEach((slide, slideIndex) => slide.classList.toggle("present", slideIndex === index));
  },
};
globalThis.Reveal.initialize();
</script>`;
    const profileRoot = await mkdtemp(path.join(tmpdir(), "deck-verifier-reveal-test-"));
    temporaryRoots.push(profileRoot);
    const renderer = createFakeRenderer(revealDeck, revealManifest);
    const verifier = createVerifier({
      renderer,
      outlineReader: async () => revealOutline,
      profileRoot,
      timeoutMs: 30_000,
    });

    const result = await verifier.verify({
      jobId,
      revisionId,
      slideIds: revealSlideIds,
      captureContactSheet: false,
    });

    expect(result.slides.find((slide) => slide.slideId === "slide-04")?.issues)
      .toContain("vertical-overflow");
    expect(result.consoleErrors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("before initialization completed") }),
    ]));
    expect(await readdir(profileRoot)).toEqual([]);
  }, 40_000);

  it("fails clearly when Reveal initialization never becomes ready", async () => {
    const stalledDeck = `<!doctype html>
<meta charset="utf-8">
<article data-slide-id="slide-01">One</article>
<article data-slide-id="slide-02">Two</article>
<script>
globalThis.Reveal = {
  isReady() { return false; },
  initialize() { return new Promise(() => {}); },
  slide() { throw new Error("Reveal.slide must not run while initialization is pending"); },
};
globalThis.Reveal.initialize();
</script>`;
    const profileRoot = await mkdtemp(path.join(tmpdir(), "deck-verifier-reveal-timeout-"));
    temporaryRoots.push(profileRoot);
    const renderer = createFakeRenderer(stalledDeck);
    const verifier = createVerifier({
      renderer,
      outlineReader: async () => outline,
      profileRoot,
      timeoutMs: 30_000,
      revealReadyTimeoutMs: 100,
    });

    await expect(verifier.verify({
      jobId,
      revisionId,
      slideIds,
      captureContactSheet: false,
    })).rejects.toThrow("Reveal initialization timed out after 100ms");
    expect(renderer.writes).toEqual([]);
    expect(await readdir(profileRoot)).toEqual([]);
  }, 40_000);

  it("cancels while waiting for Reveal initialization", async () => {
    const stalledDeck = `<!doctype html>
<meta charset="utf-8">
<article data-slide-id="slide-01">One</article>
<article data-slide-id="slide-02">Two</article>
<script>
globalThis.Reveal = {
  isReady() { return false; },
  initialize() {
    setTimeout(() => console.log("reveal-initialization-pending"), 100);
    return new Promise(() => {});
  },
  slide() { throw new Error("Reveal.slide must not run while initialization is pending"); },
};
globalThis.Reveal.initialize();
</script>`;
    const profileRoot = await mkdtemp(path.join(tmpdir(), "deck-verifier-reveal-abort-"));
    temporaryRoots.push(profileRoot);
    const controller = new AbortController();
    const renderer = createFakeRenderer(stalledDeck);
    const browserFactory = {
      async launchPersistentContext(userDataDir, options) {
        const context = await chromium.launchPersistentContext(userDataDir, options);
        context.pages()[0].on("console", (message) => {
          if (message.text() === "reveal-initialization-pending") {
            controller.abort(new Error("cancelled during Reveal initialization"));
          }
        });
        return context;
      },
    };
    const verifier = createVerifier({
      renderer,
      outlineReader: async () => outline,
      browserFactory,
      profileRoot,
      timeoutMs: 30_000,
      revealReadyTimeoutMs: 20_000,
    });

    await expect(verifier.verify({
      jobId,
      revisionId,
      slideIds,
      captureContactSheet: false,
      signal: controller.signal,
    })).rejects.toThrow("cancelled during Reveal initialization");
    expect(renderer.writes).toEqual([]);
    expect(await readdir(profileRoot)).toEqual([]);
  }, 40_000);

  it("honors cancellation and removes the temporary profile", async () => {
    const profileRoot = await mkdtemp(path.join(tmpdir(), "deck-verifier-abort-"));
    temporaryRoots.push(profileRoot);
    const controller = new AbortController();
    const renderer = createFakeRenderer();
    renderer.assembleStandalone = () => new Promise(() => {});
    const verifier = createVerifier({
      renderer,
      outlineReader: async () => outline,
      browserFactory: { launchPersistentContext: () => { throw new Error("browser must not launch"); } },
      profileRoot,
      timeoutMs: 30_000,
    });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 10);

    await expect(verifier.verify({
      jobId,
      revisionId,
      slideIds,
      captureContactSheet: false,
      signal: controller.signal,
    })).rejects.toThrow(/cancelled by test/i);
    expect(await readdir(profileRoot)).toEqual([]);
  });
});
