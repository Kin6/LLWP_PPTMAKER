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
      .toEqual(expect.arrayContaining(["horizontal-overflow", "outside-safe-area", "broken-image", "duplicate-id", "network-request-blocked"]));
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
