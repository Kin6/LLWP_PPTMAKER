import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sanitizeSlide,
  validateSlideHtml,
  validateStoredSlideHtml,
} from "../../../server/deck-agent/html-policy.mjs";

const attacks = JSON.parse(readFileSync(new URL("../../fixtures/security/html-attacks.json", import.meta.url), "utf8"));
const base = {
  slideId: "slide-01",
  sourceRefs: ["block-018"],
  sourceBlockIds: new Set(["block-018"]),
  assetIds: new Set(["asset-1"]),
};

describe("slide HTML policy", () => {
  it.each(attacks)("rejects $name", ({ html }) => {
    expect(() => validateSlideHtml({ ...base, html })).toThrow();
  });

  it("keeps valid model content rootless and preserves exact approved assets", () => {
    const result = validateSlideHtml({
      ...base,
      html: '<h1 class="title">结论</h1><figure data-asset-slot="hero"><img src="asset://asset-1" alt="证据图"></figure>',
    });

    expect(result.html).toBe('<h1 class="title">结论</h1><figure data-asset-slot="hero"><img src="asset://asset-1" alt="证据图"></figure>');
    expect(result.html).not.toContain("data-slide-id");
    expect(result.html).not.toContain("data-source-refs");
    expect(result.nodeCount).toBeGreaterThan(0);
  });

  it("accepts only exact service-owned asset states when revalidating stored fragments", () => {
    for (const state of ["empty", "resolved"]) {
      expect(() => validateStoredSlideHtml({
        ...base,
        html: `<div data-asset-slot="hero" data-asset-state="${state}"></div>`,
      })).not.toThrow();
    }
    expect(() => validateStoredSlideHtml({
      ...base,
      html: '<div data-asset-slot="hero" data-asset-state="model-defined"></div>',
    })).toThrow(/asset state/i);
    expect(() => validateStoredSlideHtml({
      ...base,
      html: '<div data-asset-state="empty"></div>',
    })).toThrow(/asset slot/i);
    expect(() => validateStoredSlideHtml({
      ...base,
      html: '<div data-slide-id="slide-01"></div>',
    })).toThrow(/service-owned/i);
  });

  it("rejects invalid identity and source references outside parsed material", () => {
    expect(() => validateSlideHtml({ ...base, slideId: "slide-1", html: "<p>结论</p>" })).toThrow(/slide identity/i);
    expect(() => validateSlideHtml({ ...base, sourceRefs: ["block-missing"], html: "<p>结论</p>" })).toThrow(/source reference/i);
  });

  it("enforces byte, node, depth, and attribute limits", () => {
    expect(() => validateSlideHtml({ ...base, html: "<p>四字内容</p>", maxBytes: 8 })).toThrow(/byte limit/i);
    expect(() => validateSlideHtml({ ...base, html: "<div><span>x</span></div>", maxNodes: 2 })).toThrow(/structure/i);
    expect(() => validateSlideHtml({ ...base, html: "<div><span>x</span></div>", maxDepth: 1 })).toThrow(/structure/i);
    expect(() => validateSlideHtml({ ...base, html: `<p aria-label="${"x".repeat(4_097)}">x</p>` })).toThrow(/too long/i);
  });

  it("serializes stably across a second validation pass", () => {
    const first = validateSlideHtml({ ...base, html: "<section><h2>证据</h2><p>结论</p></section>" });
    const second = validateSlideHtml({ ...base, html: first.html });
    expect(second).toEqual(first);
  });

  it("sanitizes HTML and CSS through the combined generation boundary", () => {
    const result = sanitizeSlide({
      ...base,
      html: '<h1 class="title">结论</h1>',
      css: ":slide .title { color:#111111; letter-spacing:0 }",
    });

    expect(result).toEqual({
      html: '<h1 class="title">结论</h1>',
      css: '[data-slide-id="slide-01"] .title{color:#111111;letter-spacing:0}',
    });
  });
});
