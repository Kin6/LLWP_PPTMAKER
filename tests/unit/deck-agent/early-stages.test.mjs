import { describe, expect, it, vi } from "vitest";
import { createAgentRunner } from "../../../server/deck-agent/agent-runner.mjs";
import { createToolRegistry } from "../../../server/deck-agent/tool-registry.mjs";
import { runOutlineStage } from "../../../server/deck-agent/stages/outline-stage.mjs";
import { runDesignStage } from "../../../server/deck-agent/stages/design-stage.mjs";

const sourceBlocks = [{ id: "block-a", type: "paragraph", text: "EVIDENCE_BODY_42" }];
const validOutline = `# Test deck

> 叙事主线：从问题走向行动

## 幻灯片 1：开场

**核心观点：** 先给出结论

**演讲备注：** 解释结论的背景。

**材料来源：**
用户材料
<!-- source:block-a -->
`;

const sourceFreeOutline = `# Topic-only deck

> **叙事主线：** 从角色定位走向课堂总结

## 幻灯片 1：认识角色

**核心结论：** 角色通过持续成长承担责任。

**要点：**
- 形象鲜明
- 主题清晰

**讲稿提示：** 用一句熟悉的角色印象开场。

**材料来源：**
- 未提供外部材料；内容基于模型通用知识生成，重要事实需核验。
`;

const validTheme = ":root{--deck-bg:#ffffff;--deck-surface:#f5f5f5;--deck-text:#111111;--deck-muted:#666666;--deck-primary:#0057b8;--deck-secondary:#287d3c;--deck-accent:#c43b27;--deck-positive:#287d3c;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:64px;--deck-heading-size:44px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:6px;--deck-space:24px;--deck-grid-gap:32px;}";
const formattedTheme = validTheme
  .replace(":root{", ":root {\n  ")
  .replace(/(--[a-z-]+):/g, "$1: ")
  .replace(/;/g, ";\n  ")
  .replace(/}$/, "\n}");

function memoryStore() {
  const files = new Map();
  return {
    files,
    runExclusive: vi.fn(async (_jobId, callback) => callback()),
    writeArtifact: vi.fn(async (_jobId, name, value) => files.set(name, value)),
    readArtifact: vi.fn(async (_jobId, name, options = {}) => {
      if (files.has(name)) return files.get(name);
      if (options.optional) return undefined;
      throw new Error(`Missing ${name}`);
    }),
    writeJson: vi.fn(async (_jobId, name, value) => files.set(name, structuredClone(value))),
    readJson: vi.fn(async (_jobId, name, options = {}) => {
      if (files.has(name)) return structuredClone(files.get(name));
      if (options.optional) return undefined;
      throw new Error(`Missing ${name}`);
    }),
  };
}

function baseContext(overrides = {}) {
  const store = memoryStore();
  const rawTools = {
    read_source_blocks: { schema: { parse: (value) => value }, execute: vi.fn() },
    read_outline: { schema: { parse: (value) => value }, execute: vi.fn() },
    render_deck: { schema: { parse: (value) => value }, execute: vi.fn() },
    inspect_slide: { schema: { parse: (value) => value }, execute: vi.fn() },
    capture_slide: { schema: { parse: (value) => value }, execute: vi.fn() },
    patch_slide: { schema: { parse: (value) => value }, execute: vi.fn() },
    generate_asset: { schema: { parse: (value) => value }, execute: vi.fn() },
    publish_deck: { schema: { parse: (value) => value }, execute: vi.fn() },
  };
  const context = {
    jobId: "job-00000000-0000-4000-8000-000000000007",
    revisionId: "working",
    input: { source: { topic: "Test", audience: "Leaders", slideCount: 1, styleId: "product-calm" } },
    sourceBlocks,
    store,
    skillLoader: { load: vi.fn(async (stage) => ({ instructions: `${stage} instructions` })) },
    runner: { runStage: vi.fn() },
    emit: vi.fn(),
    waitForUser: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
  context.tools = createToolRegistry({ tools: rawTools });
  return context;
}

describe("outline and design stages", () => {
  it("passes a complete Markdown template and accepts topic-only outlines", async () => {
    const context = baseContext({ sourceBlocks: [] });
    context.runner.runStage.mockImplementationOnce(async ({ allowedTools, messages }) => {
      const prompt = JSON.stringify(messages);
      expect(prompt).toContain("# 演示文稿标题");
      expect(prompt).toContain("## 幻灯片 1：页面标题");
      expect(prompt).toContain("**核心结论：**");
      expect(prompt).toContain("**要点：**");
      expect(prompt).toContain("**讲稿提示：**");
      expect(prompt).toContain("**材料来源：**");
      expect(prompt).toContain("未提供外部材料；内容基于模型通用知识生成，重要事实需核验。");
      await allowedTools.write_outline.execute({ markdown: sourceFreeOutline });
      return { upstreamCalls: 1 };
    });

    await runOutlineStage(context);

    expect(context.store.files.get("working/manifest.json").slides[0].sourceRefs).toEqual([]);
  });

  it("allows compatible-provider repair calls within one outline turn", async () => {
    const context = baseContext({ sourceBlocks: [] });
    context.runner = createAgentRunner({
      modelClient: {
        completeStructured: vi.fn(async () => ({
          value: {
            message: "outline written",
            final: true,
            toolCalls: [{
              id: "outline-1",
              name: "write_outline",
              argumentsJson: JSON.stringify({ markdown: sourceFreeOutline }),
            }],
          },
          apiCalls: 3,
        })),
      },
    });

    await runOutlineStage(context);

    expect(context.store.files.get("working/manifest.json").slides[0].sourceRefs).toEqual([]);
  });

  it("publishes slides-content.md and advances without user confirmation", async () => {
    const context = baseContext();
    context.runner.runStage.mockImplementationOnce(async ({ allowedTools, messages }) => {
      const prompt = JSON.stringify(messages);
      const request = JSON.parse(messages[1].content);
      expect(prompt).toContain("EVIDENCE_BODY_42");
      expect(request.sourceMode).toBe("provided-materials");
      expect(prompt).toContain("<!-- source:block-a -->");
      await allowedTools.write_outline.execute({ markdown: validOutline });
      return { upstreamCalls: 1 };
    });

    await runOutlineStage(context);

    expect(await context.store.readArtifact(context.jobId, "slides-content.md")).toContain("## 幻灯片 1");
    expect(context.store.files.get("working/manifest.json").slides[0].sourceRefs).toEqual(["block-a"]);
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "artifact", artifactId: "slides-content", status: "done" }));
    expect(context.waitForUser).not.toHaveBeenCalled();
    expect(context.runner.runStage).toHaveBeenCalledWith(expect.objectContaining({ stage: "outline", maxTurns: 2, maxUpstreamCalls: 6, timeoutMs: 120_000 }));
  });

  it("repairs invalid Markdown once and then fails in outline", async () => {
    const context = baseContext();
    context.runner.runStage.mockImplementation(async ({ allowedTools }) => {
      await allowedTools.write_outline.execute({ markdown: "# invalid" });
      return { upstreamCalls: 1 };
    });

    await expect(runOutlineStage(context)).rejects.toThrow(/outline validation failed after one repair/i);
    expect(context.runner.runStage).toHaveBeenCalledTimes(2);
  });

  it("passes the validation error and previous Markdown into the repair attempt", async () => {
    const context = baseContext();
    const invalidDraft = validOutline.replace("# Test deck", "# BROKEN_DRAFT_42\n\n# Duplicate title");
    context.runner.runStage
      .mockImplementationOnce(async ({ allowedTools }) => {
        await allowedTools.write_outline.execute({ markdown: invalidDraft });
      })
      .mockImplementationOnce(async ({ allowedTools, messages }) => {
        const repairPrompt = JSON.stringify(messages);
        expect(repairPrompt).toContain("Outline must contain exactly one H1");
        expect(repairPrompt).toContain("BROKEN_DRAFT_42");
        await allowedTools.write_outline.execute({ markdown: validOutline });
        return { upstreamCalls: 1 };
      });

    await runOutlineStage(context);

    expect(context.runner.runStage).toHaveBeenCalledTimes(2);
    expect(await context.store.readArtifact(context.jobId, "slides-content.md")).toBe(validOutline);
  });

  it("creates one design direction with one bounded model call and no confirmation", async () => {
    const context = baseContext();
    context.store.files.set("slides-content.md", validOutline);
    context.runner.runStage.mockImplementationOnce(async ({ allowedTools, messages }) => {
      expect(JSON.stringify(messages)).toContain("corporate-clean");
      await allowedTools.write_theme.execute({
        designBriefMarkdown: "# Direction\nTypography scale; palette; grid; spacing; image grammar; chart grammar; motion level; prohibited patterns.",
        themeCss: validTheme,
      });
      return { upstreamCalls: 1 };
    });

    await runDesignStage(context);

    expect(context.runner.runStage).toHaveBeenCalledTimes(1);
    expect(context.runner.runStage).toHaveBeenCalledWith(expect.objectContaining({ stage: "design", maxTurns: 1, maxUpstreamCalls: 3 }));
    expect(context.store.files.get("design-brief.md")).toMatch(/Typography scale/);
    expect(context.store.files.get("working/theme.css")).toContain("--deck-primary");
    expect(context.waitForUser).not.toHaveBeenCalled();
  });

  it("allows compatible-provider repair calls within the single design turn", async () => {
    const context = baseContext();
    context.runner = createAgentRunner({
      modelClient: {
        completeStructured: vi.fn(async () => ({
          value: {
            message: "design written",
            final: true,
            toolCalls: [{
              id: "design-1",
              name: "write_theme",
              argumentsJson: JSON.stringify({
                designBriefMarkdown: "# Direction\nTypography scale; palette; grid; spacing; image grammar; chart grammar; motion level; prohibited patterns.",
                themeCss: validTheme,
              }),
            }],
          },
          apiCalls: 3,
        })),
      },
    });

    await runDesignStage(context);

    expect(context.store.files.get("design-brief.md")).toContain("Typography scale");
    expect(context.store.files.get("working/theme.css")).toContain("--deck-primary");
  });

  it("rejects a design direction that omits required design grammar", async () => {
    const context = baseContext();
    const tool = context.tools.forStage("design", context).write_theme;
    await expect(tool.execute({ designBriefMarkdown: "# One vague direction", themeCss: validTheme })).rejects.toThrow(/design brief.*image grammar/i);
    expect(context.store.files.has("design-brief.md")).toBe(false);
    expect(context.store.files.has("working/theme.css")).toBe(false);
  });

  it("canonicalizes normally formatted theme CSS before policy validation", async () => {
    const context = baseContext();
    const tool = context.tools.forStage("design", context).write_theme;
    await tool.execute({
      designBriefMarkdown: "Typography scale; palette; grid; spacing; image grammar; chart grammar; motion level; prohibited patterns.",
      themeCss: formattedTheme,
    });
    expect(context.store.files.get("working/theme.css")).toBe(validTheme.replace(/;}$/, "}"));
  });
});

describe("stage tool registry", () => {
  it("exposes only the exact tools for each stage", () => {
    const context = baseContext();
    expect(Object.keys(context.tools.forStage("outline", context))).toEqual(["read_source_blocks", "write_outline"]);
    expect(Object.keys(context.tools.forStage("design", context))).toEqual(["read_outline", "write_design_brief", "write_theme"]);
    expect(Object.keys(context.tools.forStage("calibrating", context))).toEqual([
      "read_outline", "write_slide", "render_deck", "inspect_slide", "capture_slide", "patch_slide",
    ]);
    expect(() => context.tools.forStage("unknown", context)).toThrow(/no tool policy/i);
  });

  it("derives slide identity and provenance while storing sanitized rootless files atomically", async () => {
    const context = baseContext({ targetSlideIds: ["slide-01"] });
    context.outline = {
      title: "Test deck",
      narrative: "From problem to action",
      slides: [{
        slideId: "slide-01", number: 1, title: "Trusted title", claim: "Trusted claim",
        speakerNotes: "Trusted notes", sourceBlockIds: ["block-a"], densityScore: 321,
      }],
    };
    context.store.files.set("working/manifest.json", { slides: [] });
    const tool = context.tools.forStage("calibrating", context).write_slide;
    const input = tool.schema.parse({
      slideId: "slide-01",
      html: '<section data-slide-id="attacker"><h1>Trusted title</h1><div data-asset-slot="hero"></div></section>',
      css: ":slide .hero { display: grid; letter-spacing: 0; }",
      assetSlots: [{ slotId: "hero", purpose: "Evidence", aspectRatio: "16:9", safeArea: { x: 0.5, y: 0.1, w: 0.4, h: 0.8 }, sourceBlockIds: ["block-a"] }],
      charts: [{ chartId: "chart-main", type: "bar", labels: ["A"], series: [{ name: "Value", values: [1], colorToken: "primary" }] }],
    });

    await tool.execute(input);

    expect(context.store.runExclusive).toHaveBeenCalledTimes(1);
    expect(context.store.files.get("working/slides/slide-01.html")).not.toMatch(/data-slide-id|<html|<body/i);
    expect(context.store.files.get("working/slides/slide-01.css")).toContain('[data-slide-id="slide-01"]');
    expect(context.store.files.get("working/manifest.json").slides[0]).toEqual(expect.objectContaining({
      slideId: "slide-01", title: "Trusted title", speakerNotes: "Trusted notes",
      sourceRefs: ["block-a"], sourceBlockIds: ["block-a"], densityScore: 321,
    }));
  });

  it("rejects writes outside the requested slide targets", async () => {
    const context = baseContext({ targetSlideIds: ["slide-01"], outline: { slides: [] } });
    const tool = context.tools.forStage("calibrating", context).write_slide;
    await expect(tool.execute(tool.schema.parse({ slideId: "slide-02", html: "<section></section>", css: ":slide{display:block}", assetSlots: [], charts: [] }))).rejects.toThrow(/target/i);
  });
});
