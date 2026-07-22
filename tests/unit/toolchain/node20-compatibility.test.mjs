import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const projectManifest = readJson(join(projectRoot, "package.json"));

const node20Packages = [
  { group: "dependencies", name: "undici", version: "6.27.0", nodeEngine: ">=18.17" },
  { group: "devDependencies", name: "@testing-library/jest-dom", version: "6.9.1", nodeEngine: ">=14" },
  { group: "devDependencies", name: "@types/node", version: "20.19.43" },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("Node 20 dependency surface", () => {
  it.each(node20Packages)("pins compatible metadata for $name", ({ group, name, version, nodeEngine }) => {
    expect(projectManifest[group][name]).toBe(version);

    const installedManifest = readJson(join(projectRoot, "node_modules", name, "package.json"));
    expect(installedManifest.version).toBe(version);
    expect(installedManifest.engines?.node).toBe(nodeEngine);
  });
});
