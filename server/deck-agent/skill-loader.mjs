import { readFile } from "node:fs/promises";
import path from "node:path";

const STAGE_FILES = Object.freeze({
  outline: ["SKILL.md", "references/content-density.md", "references/source-provenance.md"],
  design: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md", "references/security-contract.md"],
  calibrating: ["SKILL.md", "references/design-direction.md", "references/layout-catalog.md", "references/visual-rubric.md", "references/security-contract.md"],
  building: ["SKILL.md", "references/content-density.md", "references/layout-catalog.md", "references/source-provenance.md", "references/security-contract.md"],
  verifying: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
  repairing: ["SKILL.md", "references/visual-rubric.md", "references/security-contract.md"],
});

async function readAllowedSkillFile(skillRoot, relativePath) {
  const root = path.resolve(skillRoot);
  const target = path.resolve(root, relativePath);
  const relation = path.relative(root, target);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Skill file escapes root: ${relativePath}`);
  }
  return readFile(target, "utf8");
}

export function createSkillLoader({ skillRoot, maxChars = 24_000 }) {
  if (typeof skillRoot !== "string" || !skillRoot) throw new TypeError("skillRoot is required");
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new TypeError("maxChars must be a positive integer");

  return {
    async load(stage) {
      if (!Object.hasOwn(STAGE_FILES, stage)) throw new Error(`Unknown stage: ${stage}`);
      const files = STAGE_FILES[stage];
      const parts = await Promise.all(files.map((relativePath) => readAllowedSkillFile(skillRoot, relativePath)));
      const instructions = parts.join("\n\n");
      if (instructions.length > maxChars) throw new Error(`Skill context exceeds ${maxChars} characters`);
      return { files: [...files], instructions, charCount: instructions.length };
    },
  };
}
