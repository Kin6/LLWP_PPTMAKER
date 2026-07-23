import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateSlideCss, validateThemeCss } from "../../../server/deck-agent/css-policy.mjs";

const attacks = JSON.parse(readFileSync(new URL("../../fixtures/security/css-attacks.json", import.meta.url), "utf8"));
const completeThemeCss = ":root{--deck-bg:#ffffff;--deck-surface:#f4f5f7;--deck-text:#111111;--deck-muted:#555555;--deck-primary:#075ccb;--deck-secondary:#243447;--deck-accent:#d9363e;--deck-positive:#14804a;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:72px;--deck-heading-size:48px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:8px;--deck-space:24px;--deck-grid-gap:32px;}";
const bundledThemes = [
  "minimal-white",
  "corporate-clean",
  "swiss-grid",
  "editorial-serif",
  "academic-paper",
  "magazine-bold",
  "tokyo-night",
  "pitch-deck-vc",
];

describe("slide CSS policy", () => {
  it.each(attacks)("rejects $name", ({ css }) => {
    expect(() => validateSlideCss({ css, slideId: "slide-01" })).toThrow();
  });

  it("rewrites every rooted selector branch to the exact server-owned slide", () => {
    const result = validateSlideCss({
      css: ":slide .title, :slide > section h2 { display:grid; color:#111111; gap:24px; letter-spacing:0 }",
      slideId: "slide-01",
    });

    expect(result.css).toContain('[data-slide-id="slide-01"] .title');
    expect(result.css).toContain('[data-slide-id="slide-01"]>section h2');
    expect(result.css).not.toContain(":slide");
    expect(result.ruleCount).toBe(1);
  });

  it("rejects invalid slide identity and enforces byte and rule limits", () => {
    expect(() => validateSlideCss({ css: ":slide{color:red}", slideId: "slide-1" })).toThrow(/slide identity/i);
    expect(() => validateSlideCss({ css: ":slide{color:red}", slideId: "slide-01", maxBytes: 4 })).toThrow(/byte limit/i);
    expect(() => validateSlideCss({ css: ":slide{color:red}:slide .x{color:blue}", slideId: "slide-01", maxRules: 1 })).toThrow(/rule limit/i);
  });

  it("serializes rewritten CSS stably across a second validation pass", () => {
    const first = validateSlideCss({ css: ":slide .title{display:grid;color:#111;gap:24px}", slideId: "slide-01" });
    const second = validateSlideCss({ css: first.css, slideId: "slide-01" });
    expect(second).toEqual(first);
  });

  it("allows only server-known deck theme token references", () => {
    const result = validateSlideCss({
      css: ":slide .title{color:var(--deck-primary);font-size:var(--deck-heading-size);gap:calc(var(--deck-space) * 2)}",
      slideId: "slide-01",
    });
    expect(result.css).toContain("var(--deck-primary)");
    expect(() => validateSlideCss({
      css: ":slide .title{color:var(--host-secret)}",
      slideId: "slide-01",
    })).toThrow(/theme token reference/i);
    expect(() => validateSlideCss({
      css: ":slide .title{color:var(--deck-primary,#ffffff)}",
      slideId: "slide-01",
    })).toThrow(/theme token reference/i);
  });
});

describe("theme CSS policy", () => {
  it("accepts exactly the complete server-known theme token set", () => {
    const first = validateThemeCss(completeThemeCss);
    expect(validateThemeCss(first)).toBe(first);
  });

  it.each(bundledThemes)("accepts the bundled %s fallback theme", (theme) => {
    const source = readFileSync(new URL(
      `../../../skills/generate-html-deck/assets/themes/${theme}.css`,
      import.meta.url,
    ), "utf8");
    const validated = validateThemeCss(source);
    expect(validateThemeCss(validated)).toBe(validated);
  });

  it("rejects missing, unknown, duplicate, unsafe, and out-of-range theme tokens", () => {
    expect(() => validateThemeCss(completeThemeCss.replace("--deck-text:#111111;", ""))).toThrow(/missing required theme tokens/i);
    expect(() => validateThemeCss(completeThemeCss.replace("--deck-text:#111111;", "--host-secret:#111111;"))).toThrow(/theme token/i);
    expect(() => validateThemeCss(completeThemeCss.replace("--deck-text:#111111;", "--deck-text:#111111;--deck-text:#222222;"))).toThrow(/duplicate theme token/i);
    expect(() => validateThemeCss(completeThemeCss.replace("--deck-text:#111111;", "--deck-text:url(https://evil.invalid/x);"))).toThrow(/URL|unsafe/i);
    expect(() => validateThemeCss(completeThemeCss.replace("--deck-title-size:72px;", "--deck-title-size:200px;"))).toThrow(/out of range/i);
    expect(() => validateThemeCss(completeThemeCss.replace("--deck-font-sans:Arial,sans-serif;", "--deck-font-sans:RemoteFont,sans-serif;"))).toThrow(/font stack/i);
    expect(() => validateThemeCss(`${completeThemeCss}:root{--deck-text:#111111}`)).toThrow(/only one/i);
  });
});
