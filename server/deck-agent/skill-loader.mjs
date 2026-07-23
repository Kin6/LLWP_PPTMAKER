import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

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

  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Skill root must be a real directory");
  let cursor = target;
  while (true) {
    const fileStat = await lstat(cursor);
    if (fileStat.isSymbolicLink()) throw new Error(`Symbolic links are forbidden for Skill file: ${relativePath}`);
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }

  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  const realRelation = path.relative(realRoot, realTarget);
  if (!realRelation || realRelation === ".." || realRelation.startsWith(`..${path.sep}`) || path.isAbsolute(realRelation)) {
    throw new Error(`Skill file escapes root: ${relativePath}`);
  }
  const targetStat = await lstat(realTarget);
  if (!targetStat.isFile()) throw new Error(`Skill file is not a regular file: ${relativePath}`);
  if (targetStat.size > MAX_MARKDOWN_BYTES) {
    throw new Error(`Skill file exceeds ${MAX_MARKDOWN_BYTES} byte limit: ${relativePath}`);
  }
  return readFile(realTarget, "utf8");
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
