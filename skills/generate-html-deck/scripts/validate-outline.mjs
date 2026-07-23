#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { parseOutline, selectCalibrationSlides } from "../../../server/deck-agent/outline.mjs";

const USAGE = "validate-outline.mjs --outline <file> --sources <file> --expected-slides <count>";
const BYTE_LIMITS = Object.freeze({ outline: 2 * 1024 * 1024, sources: 10 * 1024 * 1024 });

function parseArguments(argv) {
  if (argv.length !== 6) throw new Error(`Usage: ${USAGE}`);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--outline', '--sources', '--expected-slides'].includes(flag) || !value || values[flag]) {
      throw new Error(`Usage: ${USAGE}`);
    }
    values[flag] = value;
  }
  const expectedSlideCount = Number(values["--expected-slides"]);
  if (!Number.isSafeInteger(expectedSlideCount) || expectedSlideCount <= 0) {
    throw new Error("--expected-slides must be a positive integer");
  }
  return {
    outlinePath: values["--outline"],
    sourcesPath: values["--sources"],
    expectedSlideCount,
  };
}

function readSourceIds(input) {
  const blocks = Array.isArray(input) ? input : input?.sourceBlocks;
  if (!Array.isArray(blocks)) throw new Error("Sources file must contain an array of source blocks");
  const ids = blocks.map((block) => block?.id);
  if (ids.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Every source block must have a non-empty id");
  }
  return new Set(ids);
}

async function readInputFile(filePath, { byteLimit, label }) {
  try {
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink()) throw new Error(`${label}: symbolic links are forbidden`);
    if (!fileStat.isFile()) throw new Error(`${label}: is not a regular file`);
    if (fileStat.size > byteLimit) throw new Error(`${label}: exceeds ${byteLimit} byte limit`);
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error;
    throw new Error(`${label}: unreadable file (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [markdown, sourcesText] = await Promise.all([
    readInputFile(options.outlinePath, { byteLimit: BYTE_LIMITS.outline, label: "Outline file" }),
    readInputFile(options.sourcesPath, { byteLimit: BYTE_LIMITS.sources, label: "Sources file" }),
  ]);
  const sourceBlockIds = readSourceIds(JSON.parse(sourcesText));
  const outline = parseOutline(markdown, {
    expectedSlideCount: options.expectedSlideCount,
    sourceBlockIds,
  });
  return {
    valid: true,
    title: outline.title,
    slideCount: outline.slides.length,
    calibrationSlideIds: selectCalibrationSlides(outline),
  };
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  console.log(JSON.stringify({ valid: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
