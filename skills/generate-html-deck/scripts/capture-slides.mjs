#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { printBoundedJson, runVerificationCli } from "./inspect-dom.mjs";

async function main() {
  try {
    printBoundedJson(await runVerificationCli({ captureContactSheet: true }));
  } catch (error) {
    printBoundedJson({ ok: false, error: String(error?.message || error).slice(0, 500) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
