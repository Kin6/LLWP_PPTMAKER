#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { parseOutline } from "../../../server/deck-agent/outline.mjs";
import { createRenderer } from "../../../server/deck-agent/renderer.mjs";
import { createVerifier } from "../../../server/deck-agent/verifier.mjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const REVISION_ID = /^(?:working|revision-\d{6})$/;
const SLIDE_ID = /^slide-\d{2}$/;
const MAX_OUTPUT_BYTES = 512 * 1024;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptDirectory, "../assets/runtime");

export async function runVerificationCli({ captureContactSheet, argv = process.argv.slice(2), env = process.env } = {}) {
  const rootDir = env.DECK_JOB_ROOT;
  if (typeof rootDir !== "string" || !rootDir) throw new Error("DECK_JOB_ROOT is required");
  const options = parseArguments(argv);
  const store = createArtifactStore({ rootDir });
  const renderer = createRenderer({ store, runtimeRoot, appOrigin: "http://127.0.0.1" });
  const verifier = createVerifier({ renderer, outlineReader: ({ jobId }) => readOutline(store, jobId) });
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error("Verification cancelled"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await verifier.verify({ ...options, captureContactSheet, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

export function printBoundedJson(value) {
  const output = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new Error("CLI JSON output exceeds byte limit");
  process.stdout.write(output);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw new Error("Expected --job, --revision, and --slides");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--job", "--revision", "--slides"].includes(flag) || values.has(flag) || typeof value !== "string" || !value) {
      throw new Error("Invalid or duplicate CLI option");
    }
    values.set(flag, value);
  }
  const jobId = values.get("--job");
  const revisionId = values.get("--revision");
  const slideIds = values.get("--slides").split(",");
  if (!JOB_ID.test(jobId) || !REVISION_ID.test(revisionId)
    || slideIds.length === 0 || slideIds.length > 50
    || slideIds.some((slideId) => !SLIDE_ID.test(slideId))
    || new Set(slideIds).size !== slideIds.length) {
    throw new Error("Invalid job, revision, or slide identity");
  }
  return { jobId, revisionId, slideIds };
}

async function readOutline(store, jobId) {
  const [markdown, sourceBlocks, input] = await Promise.all([
    store.readArtifact(jobId, "slides-content.md"),
    store.readJson(jobId, "source-blocks.json"),
    store.readJson(jobId, "job-input.json"),
  ]);
  const expectedSlideCount = input?.source?.slideCount;
  if (!Number.isSafeInteger(expectedSlideCount) || expectedSlideCount < 1 || expectedSlideCount > 50) {
    throw new Error("Persisted slide count is invalid");
  }
  const sourceBlockIds = new Set((Array.isArray(sourceBlocks) ? sourceBlocks : [])
    .map((block) => block?.id || block?.source?.blockId)
    .filter((id) => typeof id === "string" && id));
  return parseOutline(markdown, { expectedSlideCount, sourceBlockIds });
}

async function main() {
  try {
    printBoundedJson(await runVerificationCli({ captureContactSheet: false }));
  } catch (error) {
    printBoundedJson({ ok: false, error: String(error?.message || error).slice(0, 500) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
