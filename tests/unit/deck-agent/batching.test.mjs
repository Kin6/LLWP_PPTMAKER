import { describe, expect, it, vi } from "vitest";
import {
  BatchError,
  mapConcurrent,
  partitionSlideBatches,
  runBuildStage,
} from "../../../server/deck-agent/stages/build-stage.mjs";
import {
  markEmptyAssetSlot,
  resolveAssetSlots,
} from "../../../server/deck-agent/stages/asset-stage.mjs";
import { validateStoredSlideHtml } from "../../../server/deck-agent/html-policy.mjs";
import { MODEL_CSS_CONTRACT } from "../../../server/deck-agent/css-contract.mjs";
import { MODEL_HTML_CONTRACT } from "../../../server/deck-agent/html-contract.mjs";
import { writeSlideInputSchema } from "../../../server/deck-agent/tool-registry.mjs";

describe("bounded slide batching", () => {
  it("partitions normal work into stable batches of two or three slides", () => {
    expect(partitionSlideBatches([
      "slide-03", "slide-04", "slide-05", "slide-06",
      "slide-07", "slide-08", "slide-09", "slide-10",
    ])).toEqual([
      ["slide-03", "slide-04", "slide-05"],
      ["slide-06", "slide-07", "slide-08"],
      ["slide-09", "slide-10"],
    ]);
    expect(partitionSlideBatches(["slide-01", "slide-02", "slide-03", "slide-04"]))
      .toEqual([["slide-01", "slide-02"], ["slide-03", "slide-04"]]);
  });

  it("runs no more than two workers while preserving settled input order", async () => {
    const items = [30, 5, 20, 1];
    let active = 0;
    let maximum = 0;

    const results = await mapConcurrent(items, 2, async (delay, index) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      if (index === 1) throw new Error("expected failure");
      return index;
    });

    expect(maximum).toBe(2);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled", "rejected", "fulfilled", "fulfilled",
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 0 });
    expect(results[1].reason).toBeInstanceOf(Error);
    expect(results[1].reason.message).toBe("expected failure");
  });
});

function outlineFor(count) {
  return {
    title: "Evidence deck",
    narrative: "Evidence to action",
    slides: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      const slideId = `slide-${String(number).padStart(2, "0")}`;
      return {
        slideId,
        number,
        title: `Title ${number}`,
        claim: `Claim ${number}`,
        rawMarkdown: `## Slide ${number}\n\nFull markdown ${number}`,
      };
    }),
  };
}

function generatedSlide(slideId) {
  return {
    slideId,
    html: `<div><h1>${slideId}</h1></div>`,
    css: ":slide div { display: grid; }",
    assetSlots: [],
    charts: [],
  };
}

function structuredBuildHarness(slides, options = {}) {
  const completeStructuredStage = vi.fn(async () => ({
    value: { slides },
    upstreamCalls: 1,
  }));
  const writeSlide = {
    schema: writeSlideInputSchema,
    execute: vi.fn(async ({ slideId }) => ({ summary: `Slide ${slideId} written` })),
  };
  const forStage = vi.fn(() => ({ write_slide: writeSlide }));
  return {
    context: {
      jobId: "job-test",
      signal: new AbortController().signal,
      outline: outlineFor(options.outlineCount || slides.length || 2),
      remainingSlideIds: options.targetSlideIds || slides.map((slide) => slide.slideId),
      progressStage: options.progressStage,
      lockedDesignBriefSummary: "Locked palette, grid, and typography",
      allowedAssets: [{ id: "asset-safe", summary: "Approved local evidence" }],
      htmlCssContract: "Rootless HTML; slide-scoped CSS",
      runner: { completeStructuredStage },
      skillLoader: { load: vi.fn(async () => ({ instructions: "Build every requested page." })) },
      tools: { forStage },
      getIncompleteSlideIds: vi.fn(async () => []),
    },
    completeStructuredStage,
    forStage,
    writeSlide,
  };
}

describe("build stage", () => {
  it("requests a complete structured slide batch and writes every validated slide", async () => {
    const targetSlideIds = ["slide-01", "slide-02"];
    const slides = targetSlideIds.map(generatedSlide);
    const harness = structuredBuildHarness(slides, { targetSlideIds });

    await runBuildStage({
      ...harness.context,
    });

    expect(harness.completeStructuredStage).toHaveBeenCalledTimes(1);
    const request = harness.completeStructuredStage.mock.calls[0][0];
    expect(request).toEqual(expect.objectContaining({
      stage: "building",
      maxUpstreamCalls: 3,
      schemaName: expect.stringMatching(/slide.*batch/i),
      messages: expect.any(Array),
    }));
    expect(request.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["slides"],
      properties: {
        slides: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["slideId", "html", "css", "assetSlots", "charts"],
            properties: {
              slideId: { type: "string", enum: targetSlideIds },
              html: { type: "string" },
              css: { type: "string" },
              assetSlots: { type: "array" },
              charts: { type: "array" },
            },
          },
        },
      },
    });

    const prompt = request.messages.map((message) => String(message.content)).join("\n");
    expect(prompt).toContain("slide-01");
    expect(prompt).toContain("slide-02");
    expect(prompt).toContain("Full markdown 1");
    expect(prompt).toContain("Full markdown 2");
    expect(prompt).toContain("Locked palette, grid, and typography");
    expect(prompt).toContain("Rootless HTML; slide-scoped CSS");
    const userRequest = JSON.parse(request.messages.at(-1).content);
    expect(userRequest.htmlContract).toEqual(MODEL_HTML_CONTRACT);
    expect(userRequest.htmlContract.allowedTags).not.toContain("section");
    expect(userRequest.htmlContract.reservedTags).toContain("section");
    expect(userRequest.htmlContract.fallbackContainerTags).toEqual(["div", "article"]);
    expect(userRequest.cssContract).toEqual(MODEL_CSS_CONTRACT);
    expect(userRequest.cssContract.canvas).toMatchObject({
      width: "1920px",
      height: "1080px",
      serverRootPadding: "0px",
      safeInset: "72px",
    });
    expect(userRequest.imagePlan).toMatchObject({
      generationEnabled: false,
      generatedImageBudget: 0,
      maxAssetSlotsPerSlide: 1,
      assetSlotsAllowedSlideIds: ["slide-01", "slide-02"],
    });
    expect(prompt).toMatch(/speaker notes.*server-owned metadata/i);
    expect(prompt).toContain("every unlisted tag is invalid");
    expect(prompt).toMatch(/every comma-separated selector branch must start exactly with :slide/i);
    expect(prompt).toMatch(/never emit :root/i);
    expect(prompt).toMatch(/never emit a section element or a section type selector/i);
    expect(userRequest.outputTemplate.slides).toEqual(targetSlideIds.map((slideId) => ({
      slideId,
      html: '<div class="slide-content"><!-- complete rootless slide markup --></div>',
      css: ":slide .slide-content{display:grid}",
      assetSlots: [],
      charts: [],
    })));
    expect(prompt).not.toContain("argumentsJson");

    expect(harness.forStage).toHaveBeenCalledWith("building", expect.objectContaining({
      targetSlideIds,
    }));
    expect(harness.writeSlide.execute).toHaveBeenCalledTimes(2);
    expect(harness.writeSlide.execute.mock.calls.map(([input]) => input.slideId)).toEqual(targetSlideIds);
  });

  it("withholds speaker notes from target slide prompts without removing visible sources", async () => {
    const harness = structuredBuildHarness([generatedSlide("slide-01")], {
      targetSlideIds: ["slide-01"],
      outlineCount: 1,
    });
    harness.context.outline.slides[0].rawMarkdown = `## 幻灯片 1：标题

**核心结论：** VISIBLE_CLAIM_42

**要点：**
- VISIBLE_FACT_42

**讲稿提示：** PRIVATE_SPEAKER_NOTE_42

**材料来源：**
- VISIBLE_SOURCE_42 <!-- source:block-a -->`;

    await runBuildStage(harness.context);

    const request = JSON.parse(harness.completeStructuredStage.mock.calls[0][0].messages.at(-1).content);
    expect(request.targetSlides[0].rawMarkdown).toContain("VISIBLE_CLAIM_42");
    expect(request.targetSlides[0].rawMarkdown).toContain("VISIBLE_FACT_42");
    expect(request.targetSlides[0].rawMarkdown).toContain("VISIBLE_SOURCE_42");
    expect(request.targetSlides[0].rawMarkdown).toContain("<!-- source:block-a -->");
    expect(request.targetSlides[0].rawMarkdown).not.toContain("讲稿提示");
    expect(request.targetSlides[0].rawMarkdown).not.toContain("PRIVATE_SPEAKER_NOTE_42");
  });

  it.each([
    ["duplicate IDs", [generatedSlide("slide-01"), generatedSlide("slide-01")]],
    ["out-of-order IDs", [generatedSlide("slide-02"), generatedSlide("slide-01")]],
    ["a missing ID", [generatedSlide("slide-01")]],
    ["invalid page fields", [{ ...generatedSlide("slide-01"), css: 42 }, generatedSlide("slide-02")]],
  ])("rejects %s before writing and retries the batch exactly once", async (_label, slides) => {
    const targetSlideIds = ["slide-01", "slide-02"];
    const harness = structuredBuildHarness(slides, {
      targetSlideIds,
      outlineCount: 2,
    });

    await expect(runBuildStage(harness.context)).rejects.toBeInstanceOf(BatchError);

    expect(harness.completeStructuredStage).toHaveBeenCalledTimes(2);
    expect(harness.writeSlide.execute).not.toHaveBeenCalled();
    const retryPrompt = harness.completeStructuredStage.mock.calls[1][0].messages
      .map((message) => String(message.content))
      .join("\n");
    expect(retryPrompt).not.toContain("argumentsJson");
    expect(retryPrompt).toMatch(/validationErrors.*Slide batch/i);
  });

  it("retries only pages left incomplete after a write failure", async () => {
    const targetSlideIds = ["slide-01", "slide-02"];
    const harness = structuredBuildHarness(targetSlideIds.map(generatedSlide), { targetSlideIds });
    const completed = new Set();
    let slideTwoAttempts = 0;
    harness.completeStructuredStage
      .mockResolvedValueOnce({
        value: { slides: targetSlideIds.map(generatedSlide) },
        upstreamCalls: 1,
      })
      .mockResolvedValueOnce({
        value: { slides: [generatedSlide("slide-02")] },
        upstreamCalls: 1,
      });
    harness.writeSlide.execute.mockImplementation(async ({ slideId }) => {
      if (slideId === "slide-02" && slideTwoAttempts++ === 0) throw new Error("CSS policy rejected slide-02");
      completed.add(slideId);
      return { summary: `Slide ${slideId} written` };
    });
    harness.context.getIncompleteSlideIds.mockImplementation(async (slideIds) => (
      slideIds.filter((slideId) => !completed.has(slideId))
    ));

    const result = await runBuildStage(harness.context);

    expect(result.retriedSlideIds).toEqual(["slide-02"]);
    expect(result.retryResult).toEqual(expect.objectContaining({ slideIds: ["slide-02"] }));
    expect(harness.completeStructuredStage).toHaveBeenCalledTimes(2);
    expect(harness.writeSlide.execute.mock.calls.map(([slide]) => slide.slideId)).toEqual([
      "slide-01", "slide-02", "slide-02",
    ]);
    const retryRequest = JSON.parse(harness.completeStructuredStage.mock.calls[1][0].messages.at(-1).content);
    expect(retryRequest.requiredSlideIds).toEqual(["slide-02"]);
    expect(retryRequest.validationErrors).toEqual([
      {
        slideIds: ["slide-02"],
        failedSlideId: "slide-02",
        message: "CSS policy rejected slide-02",
      },
    ]);
  });

  it("repairs a forbidden aside once with the full HTML contract and exact remediation", async () => {
    const targetSlideIds = ["slide-01", "slide-02"];
    const harness = structuredBuildHarness(targetSlideIds.map(generatedSlide), { targetSlideIds });
    harness.completeStructuredStage
      .mockResolvedValueOnce({
        value: {
          slides: [
            { ...generatedSlide("slide-01"), html: "<aside class=\"notes\">Do not render me</aside>" },
            generatedSlide("slide-02"),
          ],
        },
        upstreamCalls: 1,
      })
      .mockResolvedValueOnce({
        value: { slides: [generatedSlide("slide-01")] },
        upstreamCalls: 1,
      });
    harness.writeSlide.execute.mockImplementation(async (slide) => {
      if (slide.html.includes("<aside")) throw new Error("Forbidden HTML tag: aside");
      return { summary: `Slide ${slide.slideId} written` };
    });

    const result = await runBuildStage(harness.context);

    expect(result.retriedSlideIds).toEqual(["slide-01"]);
    expect(harness.writeSlide.execute.mock.calls.map(([slide]) => slide.slideId)).toEqual([
      "slide-01", "slide-02", "slide-01",
    ]);
    const retryRequest = JSON.parse(harness.completeStructuredStage.mock.calls[1][0].messages.at(-1).content);
    expect(retryRequest.htmlContract).toEqual(MODEL_HTML_CONTRACT);
    expect(retryRequest.validationErrors).toEqual([{
      slideIds: ["slide-01"],
      failedSlideId: "slide-01",
      message: "Forbidden HTML tag: aside",
    }]);
    expect(retryRequest.validationRemediation.join(" ")).toMatch(/Remove every forbidden tag: aside/i);
    expect(retryRequest.validationRemediation.join(" ")).toMatch(/Delete speaker-note/i);
    expect(retryRequest.validationRemediation.join(" ")).toMatch(/div or article/i);
  });

  it("repairs an unscoped selector once with the full CSS contract and exact remediation", async () => {
    const targetSlideIds = ["slide-01", "slide-02"];
    const harness = structuredBuildHarness(targetSlideIds.map(generatedSlide), { targetSlideIds });
    harness.completeStructuredStage
      .mockResolvedValueOnce({
        value: {
          slides: [
            { ...generatedSlide("slide-01"), css: ":root{--deck-bg:#ffffff}.cover{display:grid}" },
            generatedSlide("slide-02"),
          ],
        },
        upstreamCalls: 1,
      })
      .mockResolvedValueOnce({
        value: { slides: [generatedSlide("slide-01")] },
        upstreamCalls: 1,
      });
    harness.writeSlide.execute.mockImplementation(async (slide) => {
      if (slide.css.includes(":root")) {
        throw new Error("Every selector branch must start with :slide; received :root");
      }
      return { summary: `Slide ${slide.slideId} written` };
    });

    const result = await runBuildStage(harness.context);

    expect(result.retriedSlideIds).toEqual(["slide-01"]);
    const retryRequest = JSON.parse(harness.completeStructuredStage.mock.calls[1][0].messages.at(-1).content);
    expect(retryRequest.cssContract).toEqual(MODEL_CSS_CONTRACT);
    expect(retryRequest.validationErrors).toEqual([{
      slideIds: ["slide-01"],
      failedSlideId: "slide-01",
      message: "Every selector branch must start with :slide; received :root",
    }]);
    expect(retryRequest.validationRemediation.join(" ")).toMatch(/delete every :root rule/i);
    expect(retryRequest.validationRemediation.join(" ")).toMatch(/repeat :slide after every comma/i);
    expect(retryRequest.validationRemediation.join(" ")).toMatch(/:slide header, :slide footer/i);
  });

  it("uses the calibration progress stage while retaining the building tool policy", async () => {
    const slide = generatedSlide("slide-01");
    const harness = structuredBuildHarness([slide], {
      targetSlideIds: ["slide-01"],
      outlineCount: 1,
      progressStage: "calibrating",
    });

    await runBuildStage(harness.context);

    expect(harness.completeStructuredStage).toHaveBeenCalledWith(expect.objectContaining({
      stage: "calibrating",
    }));
    expect(harness.forStage).toHaveBeenCalledWith("building", expect.any(Object));
  });

  it("gives every batch one shared bounded image plan", async () => {
    const targetSlideIds = ["slide-01", "slide-02"];
    const harness = structuredBuildHarness(targetSlideIds.map(generatedSlide), {
      targetSlideIds,
      outlineCount: 8,
    });
    harness.context.input = {
      options: { imageEnabled: true, imageCount: 3 },
    };
    harness.context.allowedAssets = [];

    await runBuildStage(harness.context);

    const request = JSON.parse(harness.completeStructuredStage.mock.calls[0][0].messages.at(-1).content);
    expect(request.imagePlan).toMatchObject({
      generatedImageBudget: 3,
      maxAssetSlotsPerSlide: 1,
      generationEligibleSlideIds: ["slide-01", "slide-02", "slide-04"],
      assetSlotsAllowedSlideIds: ["slide-01", "slide-02", "slide-04"],
    });
  });

  it("retries only failed targets once without rewriting successful batches", async () => {
    const outline = outlineFor(10);
    const buildBatch = vi.fn(async ({ slideIds, retry }) => {
      if (!retry && slideIds.includes("slide-06")) {
        throw new BatchError(["slide-06"]);
      }
      return slideIds.map((slideId) => ({ slideId, ok: true }));
    });
    const remainingSlideIds = [
      "slide-02", "slide-03", "slide-04", "slide-05",
      "slide-06", "slide-08", "slide-09", "slide-10",
    ];

    const result = await runBuildStage({
      jobId: "job-test",
      signal: new AbortController().signal,
      outline,
      remainingSlideIds,
      calibrationSlideIds: ["slide-01", "slide-07"],
      lockedDesignBriefSummary: "Locked grid and type scale",
      allowedAssets: [{ id: "asset-safe", summary: "Uploaded evidence" }],
      htmlCssContract: "Rootless HTML; scoped CSS",
      buildBatch,
    });

    expect(result.retriedSlideIds).toEqual(["slide-06"]);
    expect(buildBatch).toHaveBeenCalledTimes(4);
    expect(buildBatch.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
      slideIds: ["slide-06"],
      targetSlideIds: ["slide-06"],
      retry: true,
    }));
    for (const slideId of remainingSlideIds.filter((id) => id !== "slide-06")) {
      expect(buildBatch.mock.calls.filter(([request]) => request.slideIds.includes(slideId)))
        .toHaveLength(1);
    }

    const firstRequest = buildBatch.mock.calls[0][0];
    expect(firstRequest.promptContext).toEqual(expect.objectContaining({
      title: "Evidence deck",
      narrative: "Evidence to action",
      lockedDesignBriefSummary: "Locked grid and type scale",
      allowedAssets: [{ id: "asset-safe", summary: "Uploaded evidence" }],
      htmlCssContract: "Rootless HTML; scoped CSS",
    }));
    expect(firstRequest.promptContext.targetSlides.map((slide) => slide.rawMarkdown))
      .toEqual(["## Slide 2\n\nFull markdown 2", "## Slide 3\n\nFull markdown 3", "## Slide 4\n\nFull markdown 4"]);
    expect(firstRequest.promptContext.neighboringSlides).toEqual([
      { slideId: "slide-01", title: "Title 1", claim: "Claim 1" },
      { slideId: "slide-05", title: "Title 5", claim: "Claim 5" },
    ]);
  });

  it("keeps retries bounded when multiple first-pass batches fail", async () => {
    const targetSlideIds = [
      "slide-01", "slide-02", "slide-03",
      "slide-04", "slide-05", "slide-06",
    ];
    let activeRetries = 0;
    let maximumRetries = 0;
    const buildBatch = vi.fn(async ({ slideIds, retry, retryErrors }) => {
      if (!retry) throw new BatchError(slideIds, `Initial failure for ${slideIds.join(",")}`);
      activeRetries += 1;
      maximumRetries = Math.max(maximumRetries, activeRetries);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRetries -= 1;
      expect(retryErrors).toHaveLength(1);
      expect(retryErrors[0].slideIds).toEqual(slideIds);
      return slideIds.map((slideId) => ({ slideId, ok: true }));
    });

    const result = await runBuildStage({
      jobId: "job-test",
      signal: new AbortController().signal,
      outline: outlineFor(6),
      remainingSlideIds: targetSlideIds,
      buildBatch,
    });

    expect(result.retriedSlideIds).toEqual(targetSlideIds);
    expect(result.retryBatches).toEqual([
      ["slide-01", "slide-02", "slide-03"],
      ["slide-04", "slide-05", "slide-06"],
    ]);
    expect(buildBatch).toHaveBeenCalledTimes(4);
    expect(buildBatch.mock.calls.filter(([request]) => request.retry).map(([request]) => request.slideIds))
      .toEqual(result.retryBatches);
    expect(Math.max(...buildBatch.mock.calls.map(([request]) => request.slideIds.length))).toBe(3);
    expect(maximumRetries).toBe(2);
    expect(result.retryPass.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(result.retryResult).toBeUndefined();
  });

  it("propagates a failed bounded retry without starting a third round", async () => {
    const targetSlideIds = [
      "slide-01", "slide-02", "slide-03",
      "slide-04", "slide-05", "slide-06",
    ];
    const finalFailure = new BatchError(
      ["slide-04", "slide-05", "slide-06"],
      "Second batch still invalid",
    );
    const buildBatch = vi.fn(async ({ slideIds, retry }) => {
      if (!retry) throw new BatchError(slideIds, "Initial batch failure");
      if (slideIds.includes("slide-04")) throw finalFailure;
      return slideIds.map((slideId) => ({ slideId, ok: true }));
    });

    await expect(runBuildStage({
      jobId: "job-test",
      signal: new AbortController().signal,
      outline: outlineFor(6),
      remainingSlideIds: targetSlideIds,
      buildBatch,
    })).rejects.toBe(finalFailure);

    expect(buildBatch).toHaveBeenCalledTimes(4);
    expect(buildBatch.mock.calls.filter(([request]) => request.retry)).toHaveLength(2);
  });

  it("uses a calibrated neighbor as read-only context for one remaining slide", async () => {
    const buildBatch = vi.fn(async () => []);

    await runBuildStage({
      outline: outlineFor(2),
      remainingSlideIds: ["slide-02"],
      calibrationSlideIds: ["slide-01"],
      buildBatch,
    });

    expect(buildBatch).toHaveBeenCalledTimes(1);
    expect(buildBatch).toHaveBeenCalledWith(expect.objectContaining({
      slideIds: ["slide-02"],
      targetSlideIds: ["slide-02"],
      readOnlySlideIds: ["slide-01"],
      promptContext: expect.objectContaining({
        readOnlySlides: [{ slideId: "slide-01", title: "Title 1", claim: "Claim 1" }],
      }),
    }));
  });

  it("gives multi-slide batches the nearest calibrated page as read-only visual DNA", async () => {
    const buildBatch = vi.fn(async () => []);
    const files = new Map([
      ["working/slides/slide-01.html", "<section class=\"calibrated\">Cover</section>"],
      ["working/slides/slide-01.css", "[data-slide-id=\"slide-01\"] .calibrated{display:grid}"],
      ["working/slides/slide-05.html", "<section class=\"calibrated\">Dense</section>"],
      ["working/slides/slide-05.css", "[data-slide-id=\"slide-05\"] .calibrated{display:grid}"],
    ]);

    await runBuildStage({
      jobId: "job-test",
      outline: outlineFor(6),
      remainingSlideIds: ["slide-02", "slide-03", "slide-04"],
      calibrationSlideIds: ["slide-01", "slide-05"],
      store: { readArtifact: vi.fn(async (_jobId, name) => files.get(name)) },
      buildBatch,
    });

    expect(buildBatch).toHaveBeenCalledWith(expect.objectContaining({
      readOnlySlideIds: ["slide-01"],
      promptContext: expect.objectContaining({
        visualReferenceSlides: [{
          slideId: "slide-01",
          html: "<section class=\"calibrated\">Cover</section>",
          css: "[data-slide-id=\"slide-01\"] .calibrated{display:grid}",
        }],
      }),
    }));
  });

  it("loads the persisted design brief when building page prompts", async () => {
    const buildBatch = vi.fn(async () => []);
    const readLockedDesignBriefSummary = vi.fn(async () => "Persisted palette, grid, and image grammar");

    await runBuildStage({
      outline: outlineFor(1),
      remainingSlideIds: ["slide-01"],
      readLockedDesignBriefSummary,
      buildBatch,
    });

    expect(readLockedDesignBriefSummary).toHaveBeenCalledTimes(1);
    expect(buildBatch).toHaveBeenCalledWith(expect.objectContaining({
      promptContext: expect.objectContaining({
        lockedDesignBriefSummary: "Persisted palette, grid, and image grammar",
      }),
    }));
  });

  it("scopes visual repair issues and previous page code to each repair batch", async () => {
    const buildBatch = vi.fn(async () => []);
    const previous = new Map([
      ["working/slides/slide-01.html", "<section>previous one</section>"],
      ["working/slides/slide-01.css", ":slide .one{display:grid}"],
      ["working/slides/slide-02.html", "<section>previous two</section>"],
      ["working/slides/slide-02.css", ":slide .two{display:grid}"],
    ]);

    await runBuildStage({
      jobId: "job-test",
      progressStage: "repairing",
      outline: outlineFor(2),
      remainingSlideIds: ["slide-01", "slide-02"],
      store: { readArtifact: vi.fn(async (_jobId, name) => previous.get(name)) },
      repairReport: {
        designChanges: ["Use the lower half of the canvas"],
        slides: [
          { slideId: "slide-01", issues: ["visual:lower half is empty"] },
          { slideId: "slide-02", issues: ["vertical-overflow"] },
        ],
        consoleErrors: [{ slideId: "slide-02", message: "layout failed" }],
      },
      buildBatch,
    });

    const [request] = buildBatch.mock.calls[0];
    expect(request.promptContext.repairDesignChanges).toEqual(["Use the lower half of the canvas"]);
    expect(request.promptContext.repairSlides).toEqual([
      {
        slideId: "slide-01",
        issues: ["visual:lower half is empty"],
        previousHtml: "<section>previous one</section>",
        previousCss: ":slide .one{display:grid}",
      },
      {
        slideId: "slide-02",
        issues: ["vertical-overflow", "console:layout failed"],
        previousHtml: "<section>previous two</section>",
        previousCss: ":slide .two{display:grid}",
      },
    ]);
  });

  it("recovers the read-only neighbor from persisted page checkpoints", async () => {
    const buildBatch = vi.fn(async () => []);
    const manifest = {
      slides: [
        { slideId: "slide-01", status: "done" },
        { slideId: "slide-02", status: "pending" },
      ],
    };

    await runBuildStage({
      jobId: "job-test",
      outline: outlineFor(2),
      store: { readJson: vi.fn(async () => manifest) },
      buildBatch,
    });

    expect(buildBatch).toHaveBeenCalledWith(expect.objectContaining({
      slideIds: ["slide-02"],
      readOnlySlideIds: ["slide-01"],
    }));
  });
});

function assetSlot(slotId, purpose, sourceBlockIds = []) {
  return {
    slotId,
    purpose,
    aspectRatio: "16:9",
    safeArea: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    sourceBlockIds,
  };
}

describe("asset stage", () => {
  it("resolves slots in priority order with serial generation and per-slot checkpoints", async () => {
    const alreadyDone = { ...assetSlot("already-done", "Existing"), state: "resolved", assetId: "asset-existing" };
    const manifest = {
      slides: [
        {
          slideId: "slide-01",
          title: "Do not leak this title",
          assetSlots: [
            alreadyDone,
            assetSlot("upload", "Uploaded evidence", ["block-upload"]),
            assetSlot("library", "Forest canopy"),
            assetSlot("generated", "Generated landscape", ["block-generated"]),
          ],
        },
        {
          slideId: "slide-02",
          title: "Another private title",
          assetSlots: [
            assetSlot("generation-fails", "Failing generated scene", ["block-fail"]),
            assetSlot("budget-empty", "No budget remains"),
          ],
        },
      ],
    };
    let activeGeneration = 0;
    let maximumGeneration = 0;
    const generateAsset = vi.fn(async ({ prompt }) => {
      activeGeneration += 1;
      maximumGeneration = Math.max(maximumGeneration, activeGeneration);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeGeneration -= 1;
      if (prompt.includes("Failing generated scene")) throw new Error("mock 524");
      return { dataUrl: "data:image/png;base64,generated" };
    });
    const publishAsset = vi.fn(async (asset) => ({ assetId: asset.id }));
    const publishGeneratedAsset = vi.fn(async () => ({ assetId: "asset-generated" }));
    const markEmpty = vi.fn(async () => ({ state: "empty" }));
    const checkpoints = [];

    const results = await resolveAssetSlots({
      jobId: "job-test",
      signal: new AbortController().signal,
      manifest,
      input: { options: { imageEnabled: true, imageCount: 0, imageQuality: "medium", imageTimeoutMs: 300_000, imageMaxRetries: 1 } },
      uploads: [{ id: "asset-upload", filename: "asset-upload.png" }],
      library: [{
        id: "asset-library",
        file: "forest.webp",
        tags: ["forest"],
        license: "CC0-1.0",
        sourceUrl: "https://example.invalid/forest",
        sha256: "a".repeat(64),
      }],
      sourceBlocks: [
        { id: "block-upload", assetId: "asset-upload", text: "Uploaded diagram" },
        { id: "block-generated", text: "Relevant landscape summary" },
        { id: "block-fail", text: "Relevant failing summary" },
        { id: "block-unrelated", text: "UNRELATED SECRET SOURCE" },
      ],
      generateAsset,
      publishAsset,
      publishGeneratedAsset,
      markEmptyAssetSlot: markEmpty,
      readLockedDesignBriefSummary: vi.fn(async () => "Flat editorial scenes with one coral focal accent."),
      emitAssetFallback: vi.fn(),
      checkpointAssetSlot: vi.fn(async (slideId, slotId, result) => {
        checkpoints.push(`${slideId}/${slotId}/${result.source || result.state}`);
      }),
    });

    expect(results.map((result) => result.source || result.state)).toEqual([
      "uploaded", "licensed", "generated", "empty", "empty",
    ]);
    expect(publishAsset.mock.calls.map(([asset]) => asset.id)).toEqual([
      "asset-upload", "asset-library",
    ]);
    expect(generateAsset).toHaveBeenCalledTimes(2);
    expect(maximumGeneration).toBe(1);
    expect(publishGeneratedAsset).toHaveBeenCalledTimes(1);
    expect(markEmpty.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["slide-02", "generation-fails"],
      ["slide-02", "budget-empty"],
    ]);
    expect(checkpoints).toEqual([
      "slide-01/upload/uploaded",
      "slide-01/library/licensed",
      "slide-01/generated/generated",
      "slide-02/generation-fails/empty",
      "slide-02/budget-empty/empty",
    ]);
    expect(generateAsset.mock.calls[0][0].prompt).toMatch(/presentation text is forbidden inside the image/i);
    expect(generateAsset.mock.calls[0][0].prompt).toContain("Flat editorial scenes with one coral focal accent.");
    expect(generateAsset.mock.calls[0][0].prompt).toContain("Relevant landscape summary");
    expect(generateAsset.mock.calls[0][0].prompt).not.toContain("UNRELATED SECRET SOURCE");
    expect(generateAsset.mock.calls[0][0].prompt).not.toContain("Do not leak this title");
  });

  it("reparses, validates, and atomically replaces only the selected empty slot", async () => {
    const files = new Map([[
      "working/slides/slide-01.html",
      '<figure data-asset-slot="hero" data-asset-state="resolved"><img src="asset://asset-old" alt="Old evidence"></figure><figure data-asset-slot="other"><img src="asset://asset-keep" alt="Keep evidence"></figure>',
    ]]);
    const store = {
      readArtifact: vi.fn(async (_jobId, name) => files.get(name)),
      writeArtifact: vi.fn(async (_jobId, name, value) => files.set(name, value)),
    };
    const validate = vi.fn((input) => validateStoredSlideHtml(input));

    const result = await markEmptyAssetSlot({
      jobId: "job-test",
      signal: new AbortController().signal,
      store,
      sourceBlockIds: new Set(["block-a"]),
      assetIds: new Set(["asset-old", "asset-keep"]),
      validateStoredSlideHtml: validate,
    }, {
      slideId: "slide-01",
      sourceBlockIds: ["block-a"],
    }, assetSlot("hero", "Evidence", ["block-a"]));

    expect(result).toEqual(expect.objectContaining({ state: "empty", slotId: "hero" }));
    expect(validate).toHaveBeenCalledTimes(1);
    expect(store.writeArtifact).toHaveBeenCalledTimes(1);
    expect(files.get("working/slides/slide-01.html"))
      .toContain('<figure data-asset-slot="hero" data-asset-state="empty"></figure>');
    expect(files.get("working/slides/slide-01.html")).not.toContain("asset-old");
    expect(files.get("working/slides/slide-01.html")).toContain("asset://asset-keep");
  });
});
