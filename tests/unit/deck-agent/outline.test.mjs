import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseOutline,
  projectVisibleOutline,
  removeSpeakerNotes,
  selectCalibrationSlides,
} from "../../../server/deck-agent/outline.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const validateOutlineCli = path.join(repositoryRoot, "skills/generate-html-deck/scripts/validate-outline.mjs");
const outlineFixture = path.join(repositoryRoot, "tests/fixtures/deck-agent/skill-outline/slides-content.md");
const sourcesFixture = path.join(repositoryRoot, "tests/fixtures/deck-agent/skill-outline/source-blocks.json");
const temporaryRoots = [];
const cliByteLimits = { outline: 2 * 1024 * 1024, sources: 10 * 1024 * 1024 };
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

const sourceFree = `# 猪猪侠角色介绍

> **叙事主线：** 角色定位 -> 核心特征 -> 课堂总结

## 幻灯片 1：认识猪猪侠

**核心结论：** 猪猪侠是一名面向少儿观众的国产动画角色。

**要点：**

- 角色形象鲜明
- 故事强调成长与责任

**讲稿提示：** 从同学们熟悉的动画角色切入。

**材料来源：**

- 未提供外部材料；内容基于模型通用知识生成，重要事实需核验。`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function padToBytes(contents, byteLength) {
  const padding = byteLength - Buffer.byteLength(contents, "utf8");
  if (padding < 0) throw new Error("Requested byte length is smaller than content");
  return `${contents}${" ".repeat(padding)}`;
}

async function runValidateOutline(outlinePath, sourcesPath) {
  return execFileAsync(process.execPath, [
    validateOutlineCli,
    "--outline", outlinePath,
    "--sources", sourcesPath,
    "--expected-slides", "2",
  ], { cwd: repositoryRoot });
}

describe("deck outline parser", () => {
  it("accepts an explicit no-external-material disclosure when no source blocks were supplied", () => {
    const outline = parseOutline(sourceFree, {
      expectedSlideCount: 1,
      sourceBlockIds: new Set(),
    });

    expect(outline.slides[0].sourceBlockIds).toEqual([]);
    expect(outline.slides[0].rawMarkdown).toContain("未提供外部材料");
    expect(outline.slides[0].visibleMarkdown).not.toContain("讲稿提示");
    expect(outline.slides[0].visibleMarkdown).not.toContain("从同学们熟悉的动画角色切入");
    expect(outline.slides[0].visibleMarkdown).toContain("未提供外部材料");
  });

  it("removes note sections while preserving visible content and source provenance", () => {
    const visible = removeSpeakerNotes(valid);
    const outline = parseOutline(valid, { expectedSlideCount: 2, sourceBlockIds });
    const projected = projectVisibleOutline(outline, { slideIds: ["slide-02"] });

    expect(visible).not.toContain("演讲备注");
    expect(visible).not.toContain("从经营结果切入");
    expect(visible).not.toContain("依次解释三个断点");
    expect(visible).toContain("生产数据依赖人工汇总");
    expect(visible).toContain("<!-- source:block-018 -->");
    expect(visible).toContain("<!-- source:block-031 -->");
    expect(projected).toMatchObject({
      title: "智能制造转型方案",
      slides: [{
        slideId: "slide-02",
        title: "三个信息断点造成主要损失",
        sourceBlockIds: ["block-031"],
      }],
    });
    expect(projected.slides[0].markdown).not.toContain("依次解释三个断点");
    expect(projected.slides[0].markdown).toContain("<!-- source:block-031 -->");
  });

  it("removes a heading-style note section through the next labeled section", () => {
    const markdown = `# Deck\n\n## 幻灯片 1：标题\n\n### 核心结论\n\n可见结论\n\n### 讲稿提示\n\nPRIVATE_NOTE\n\n- 只供讲者参考\n\n### 材料来源\n\n可见来源`;

    expect(removeSpeakerNotes(markdown)).toBe(
      "# Deck\n\n## 幻灯片 1：标题\n\n### 核心结论\n\n可见结论\n\n### 材料来源\n\n可见来源",
    );
  });

  it("preserves whitespace outside note ranges byte for byte", () => {
    const before = "# Deck\n\n\n\n## 幻灯片 1：标题\n\n**核心结论：** 可见\n\n";
    const note = "**讲稿提示：** PRIVATE\n\n- 仅供讲者\n\n";
    const after = "**材料来源：**\n\n```text\nVISIBLE\n\n\nDATA\n```\n\n\n";

    expect(removeSpeakerNotes(`${before}${note}${after}`)).toBe(`${before}${after}`);
  });

  it("does not let speaker-note length affect visible density", () => {
    const longNotes = valid.replace("从经营结果切入。", "仅供讲者".repeat(2_000));
    const baseline = parseOutline(valid, { expectedSlideCount: 2, sourceBlockIds });
    const expanded = parseOutline(longNotes, { expectedSlideCount: 2, sourceBlockIds });

    expect(expanded.slides[0].densityScore).toBe(baseline.slides[0].densityScore);
  });

  it("still requires a source comment when source blocks were supplied", () => {
    expect(() => parseOutline(sourceFree, {
      expectedSlideCount: 1,
      sourceBlockIds: new Set(["block-018"]),
    })).toThrow(/sources/i);
  });

  it("rejects invented human-readable sources in topic-only mode", () => {
    const inventedSource = sourceFree.replace(
      "未提供外部材料；内容基于模型通用知识生成，重要事实需核验。",
      "某百科网站与虚构的参考资料。",
    );

    expect(() => parseOutline(inventedSource, {
      expectedSlideCount: 1,
      sourceBlockIds: new Set(),
    })).toThrow(/no-external-material disclosure/i);
  });

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

describe("validate-outline CLI input safety", () => {
  it("accepts exact outline and sources limits and rejects one byte over each", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deck-outline-cli-"));
    temporaryRoots.push(root);
    const [outlineText, sourcesText] = await Promise.all([
      readFile(outlineFixture, "utf8"),
      readFile(sourcesFixture, "utf8"),
    ]);
    const outlinePath = path.join(root, "outline.md");
    const sourcesPath = path.join(root, "sources.json");

    await writeFile(outlinePath, padToBytes(outlineText, cliByteLimits.outline), "utf8");
    await writeFile(sourcesPath, sourcesText, "utf8");
    await expect(runValidateOutline(outlinePath, sourcesPath)).resolves.toMatchObject({
      stdout: expect.stringContaining('"valid":true'),
    });

    await writeFile(outlinePath, outlineText, "utf8");
    await writeFile(sourcesPath, padToBytes(sourcesText, cliByteLimits.sources), "utf8");
    await expect(runValidateOutline(outlinePath, sourcesPath)).resolves.toMatchObject({
      stdout: expect.stringContaining('"valid":true'),
    });

    await writeFile(outlinePath, padToBytes(outlineText, cliByteLimits.outline + 1), "utf8");
    await expect(runValidateOutline(outlinePath, sourcesPath)).rejects.toMatchObject({
      stdout: expect.stringContaining(`Outline file: exceeds ${cliByteLimits.outline} byte limit`),
    });

    await writeFile(outlinePath, outlineText, "utf8");
    await writeFile(sourcesPath, padToBytes(sourcesText, cliByteLimits.sources + 1), "utf8");
    await expect(runValidateOutline(outlinePath, sourcesPath)).rejects.toMatchObject({
      stdout: expect.stringContaining(`Sources file: exceeds ${cliByteLimits.sources} byte limit`),
    });
  });

  it("rejects symlinked CLI inputs before reading them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "deck-outline-cli-"));
    temporaryRoots.push(root);
    const outlinePath = path.join(root, "outline.md");
    await symlink(outlineFixture, outlinePath);

    await expect(runValidateOutline(outlinePath, sourcesFixture)).rejects.toMatchObject({
      stdout: expect.stringContaining("Outline file: symbolic links are forbidden"),
    });
  });
});
