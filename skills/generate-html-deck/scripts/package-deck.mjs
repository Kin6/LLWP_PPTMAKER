#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createRenderer } from "../../../server/deck-agent/renderer.mjs";

const USAGE = "package-deck.mjs --job <job-id> --revision <working|revision-NNNNNN>";
const JOB_ID = /^job-[0-9a-f-]{36}$/;
const REVISION_ID = /^(?:working|revision-\d{6})$/;
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/runtime");

function parseArguments(argv) {
  if (argv.length !== 4) throw new Error(`Usage: ${USAGE}`);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--job", "--revision"].includes(flag) || !value || values[flag]) throw new Error(`Usage: ${USAGE}`);
    values[flag] = value;
  }
  if (!JOB_ID.test(values["--job"])) throw new Error("Invalid job id");
  if (!REVISION_ID.test(values["--revision"])) throw new Error("Invalid revision id");
  return { jobId: values["--job"], revisionId: values["--revision"] };
}
async function main() {
  const rootDir = process.env.DECK_JOB_ROOT;
  if (!rootDir) throw new Error("DECK_JOB_ROOT is required");
  const options = parseArguments(process.argv.slice(2));
  const store = createArtifactStore({ rootDir });
  const renderer = createRenderer({ store, runtimeRoot, appOrigin: "http://127.0.0.1" });
  const html = await renderer.assembleStandalone(options);
  const prefix = options.revisionId === "working" ? "working" : `revisions/${options.revisionId}`;
  await store.writeArtifact(options.jobId, `${prefix}/dist/index.html`, html);
  return { ok: true, ...options, artifactId: "deck-preview", byteLength: Buffer.byteLength(html, "utf8") };
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
