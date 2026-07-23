import { describe, expect, it } from "vitest";
import { parseOutline, selectCalibrationSlides } from "../../../server/deck-agent/outline.mjs";

const sourceBlockIds = new Set(["block-018", "block-031"]);
const valid = `# 智能制造转型方案

> **叙事主线：** 现状问题 -> 核心证据 -> 解决路径

## 幻灯片 1：封面

**核心观点：** 系统协同决定转型收益。

**演讲备注：** 从经营结果切入。

**材料来源：**

- 《调研报告》第 3 页 <!-- source:block-018 -->

## 幻灯片 2：三个信息断点造成主要损失

**核心观点：** 设备、计划和质量数据尚未闭环。

**关键事实：**

- 生产数据依赖人工汇总
- 质量问题不能及时回溯

| 环节 | 损失 |
| --- | --- |
| 汇总 | 4 小时 |

**演讲备注：** 依次解释三个断点。

**材料来源：**

- 《调研报告》第 8 页 <!-- source:block-031 -->`;

describe("deck outline parser", () => {
  it("parses free sections and GFM tables without turning them into layout instructions", () => {
    const outline = parseOutline(valid, { expectedSlideCount: 2, sourceBlockIds });

    expect(outline.title).toBe("智能制造转型方案");
    expect(outline.slides[1]).toMatchObject({
      slideId: "slide-02",
      claim: "设备、计划和质量数据尚未闭环。",
      sourceBlockIds: ["block-031"],
    });
    expect(outline.slides[1].sectionLabels).toContain("关键事实");
    expect(selectCalibrationSlides(outline)).toEqual(["slide-01", "slide-02"]);
  });

  it("rejects unknown sources, non-source HTML, and visual directives", () => {
    expect(() => parseOutline(valid.replace("block-031", "block-missing"), { expectedSlideCount: 2, sourceBlockIds })).toThrow(/block-missing/);
    expect(() => parseOutline(valid.replace("系统协同决定", "<span>系统协同</span>决定"), { expectedSlideCount: 2, sourceBlockIds })).toThrow(/HTML/);
    expect(() => parseOutline(valid.replace("**关键事实：**", "**布局：** 左图右文"), { expectedSlideCount: 2, sourceBlockIds })).toThrow(/visual directive/i);
  });

  it("rejects visual directives nested inside slide content", () => {
    const markdown = valid.replace(
      "- 生产数据依赖人工汇总",
      "- **布局：** 左图右文\n- 生产数据依赖人工汇总",
    );

    expect(() => parseOutline(markdown, { expectedSlideCount: 2, sourceBlockIds }))
      .toThrow(/visual directive/i);
  });

  it("rejects heading visual directives whose value follows the label", () => {
    const markdown = valid.replace("**关键事实：**", "### 布局：左图右文");

    expect(() => parseOutline(markdown, { expectedSlideCount: 2, sourceBlockIds }))
      .toThrow(/visual directive/i);
  });

  it("rejects heading visual directives nested inside slide content", () => {
    const markdown = valid.replace(
      "- 生产数据依赖人工汇总",
      "> ### 布局：左图右文\n>\n> 不应成为内容指令\n\n- 生产数据依赖人工汇总",
    );

    expect(() => parseOutline(markdown, { expectedSlideCount: 2, sourceBlockIds }))
      .toThrow(/visual directive/i);
  });

  it("rejects source comments outside the materials section", () => {
    const markdown = valid
      .replace("**演讲备注：** 依次解释三个断点。", "**演讲备注：** 依次解释三个断点。 <!-- source:block-031 -->")
      .replace("- 《调研报告》第 8 页 <!-- source:block-031 -->", "- 《调研报告》第 8 页");

    expect(() => parseOutline(markdown, { expectedSlideCount: 2, sourceBlockIds }))
      .toThrow(/source comment.*材料来源/i);
  });

  it("rejects source comments before the first slide", () => {
    const markdown = valid.replace(
      "## 幻灯片 1：封面",
      "<!-- source:block-018 -->\n\n## 幻灯片 1：封面",
    );

    expect(() => parseOutline(markdown, { expectedSlideCount: 2, sourceBlockIds }))
      .toThrow(/source comment.*材料来源/i);
  });

  it("reads a bold label whose value starts in the following paragraph", () => {
    const markdown = valid.replace(
      "**核心观点：** 系统协同决定转型收益。",
      "**核心观点：**\n\n系统协同决定转型收益。",
    );

    expect(parseOutline(markdown, { expectedSlideCount: 2, sourceBlockIds }).slides[0].claim)
      .toBe("系统协同决定转型收益。");
  });

  it("finds nested source comments and deduplicates repeated references", () => {
    const markdown = valid.replace(
      "- 《调研报告》第 8 页 <!-- source:block-031 -->",
      "- 《调研报告》第 8 页\n  - 摘录 <!-- source:block-031 -->\n  - 复核 <!-- source:block-031 -->",
    );

    expect(parseOutline(markdown, { expectedSlideCount: 2, sourceBlockIds }).slides[1].sourceBlockIds)
      .toEqual(["block-031"]);
  });

  it("requires a narrative and continuous one-based slide numbering", () => {
    const missingNarrative = valid.replace(/> \*\*叙事主线：\*\*[^\n]+\n\n/, "");
    expect(() => parseOutline(missingNarrative, { expectedSlideCount: 2, sourceBlockIds })).toThrow(/narrative/i);
    expect(() => parseOutline(valid.replace("幻灯片 2：", "幻灯片 3："), { expectedSlideCount: 2, sourceBlockIds })).toThrow(/continuous/i);
  });

  it("returns the first slide only when no denser calibration candidate exists", () => {
    const oneSlide = valid.slice(0, valid.indexOf("\n## 幻灯片 2"));
    const outline = parseOutline(oneSlide, { expectedSlideCount: 1, sourceBlockIds });

    expect(selectCalibrationSlides(outline)).toEqual(["slide-01"]);
  });
});
