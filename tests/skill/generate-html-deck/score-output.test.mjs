import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scorer = path.join(repositoryRoot, "tests/skill/generate-html-deck/score-output.mjs");
const scenarios = path.join(repositoryRoot, "tests/skill/generate-html-deck/scenarios.json");
const temporaryRoots = [];
const qaSlideIds = Array.from({ length: 8 }, (_, index) => `slide-${String(index + 1).padStart(2, "0")}`);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function score(setup) {
  const root = await mkdtemp(path.join(tmpdir(), "deck-score-"));
  temporaryRoots.push(root);
  const outputs = path.join(root, "outputs");
  const report = path.join(root, "report.json");
  await setup(outputs);
  try {
    await execFileAsync(process.execPath, [scorer, "--scenarios", scenarios, "--outputs", outputs, "--report", report], {
      cwd: repositoryRoot,
    });
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  return JSON.parse(await readFile(report, "utf8"));
}

async function writeScenario(outputs, id, files) {
  const directory = path.join(outputs, id);
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(
    path.join(directory, name),
    typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`,
    "utf8",
  )));
}

function scenario(report, id) {
  return report.scenarios.find((record) => record.id === id);
}

function field(record, name) {
  return record.fields.find((item) => item.field === name);
}

function validSourceFiles(htmlOverrides = {}) {
  return {
    "slide-01.html": '<figure data-asset-slot="cover-image"></figure><p data-slot="source">block-018</p>',
    "slide-02.html": '<p data-slot="source">block-031</p>',
    "process.json": {
      slides: [
        { slideId: "slide-01", sourceRefs: ["block-018"] },
        { slideId: "slide-02", sourceRefs: ["block-031"] },
      ],
      imageFallbacks: [],
    },
    ...htmlOverrides,
  };
}

function validQaFiles({ htmlOverrides = {}, processOverrides = {} } = {}) {
  return {
    ...Object.fromEntries(qaSlideIds.map((slideId) => [`${slideId}.html`, `<p>${slideId}</p>`])),
    "deck.css": ":slide { width: 1920px; height: 1080px; }\n",
    "process.json": {
      calibrationSlideIds: ["slide-01", "slide-06"],
      buildBatches: [["slide-01", "slide-02"], ["slide-03", "slide-04"], ["slide-05", "slide-06"], ["slide-07", "slide-08"]],
      maxConcurrency: 2,
      contactSheetReviewCount: 1,
      contactSheetReview: {
        slideIds: qaSlideIds,
        findings: [{ slideId: "slide-03", defect: "The metric panel clips its final line at the lower edge." }],
      },
      targetedRepairRounds: 1,
      targetedRepairs: [{ slideId: "slide-03", repair: "Reduced the metric panel padding and rechecked the final line." }],
      ...processOverrides,
    },
    ...htmlOverrides,
  };
}

it("rejects QA metadata without the eight slide artifacts and exact ordered batch coverage", async () => {
  const report = await score((outputs) => writeScenario(outputs, "qa-under-budget", {
    "process.json": {
      calibrationSlideIds: ["slide-01", "slide-06"],
      buildBatches: [["slide-01", "slide-02"], ["slide-03", "slide-04"], ["slide-05", "slide-06"], ["slide-07", "slide-07"]],
      maxConcurrency: 2,
      contactSheetReviewCount: 1,
      targetedRepairRounds: 1,
    },
  }));

  expect(scenario(report, "qa-under-budget").pass).toBe(false);
});

it("rejects executable fragment attributes and nonexistent asset URLs", async () => {
  const report = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": '<iframe srcdoc="<script>alert(1)</script>"></iframe><img src="asset://ghost" style="background:url(https://example.com/x.png)">',
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":root { --deck-bg: #fff; }\n:slide { width: 1920px; height: 1080px; }\n",
    "process.json": { designDirection: "one direction" },
  }));

  expect(scenario(report, "dense-fast-pressure").pass).toBe(false);
});

it("requires canonical sourceRefs without duplicates and visible source evidence", async () => {
  const report = await score((outputs) => writeScenario(outputs, "source-and-image-slots", {
    "slide-01.html": '<figure data-asset-slot="cover-image"></figure><p>No source shown</p>',
    "slide-02.html": "<p>No source shown</p>",
    "deck.css": ":root { --deck-bg: #fff; }\n:slide { width: 1920px; height: 1080px; }\n",
    "process.json": {
      slides: [
        { slideId: "slide-01", sourceBlockIds: ["block-018", "block-018"] },
        { slideId: "slide-02", sourceBlockIds: ["block-031", "block-031"] },
      ],
      imageFallbacks: [],
    },
  }));

  expect(scenario(report, "source-and-image-slots").pass).toBe(false);
});

it("applies script and URL security checks to every scenario", async () => {
  const report = await score(async (outputs) => {
    await writeScenario(outputs, "source-and-image-slots", validSourceFiles({
      "slide-01.html": '<figure data-asset-slot="cover-image"></figure><p data-slot="source">block-018</p><script>alert(1)</script>',
    }));
    await writeScenario(outputs, "qa-under-budget", validQaFiles({
      htmlOverrides: {
        "slide-01.html": '<script>alert(1)</script><iframe srcdoc="unsafe"></iframe><div style="color:red"></div><a href="https://example.com">x</a><img src="asset://ghost">',
      },
    }));
  });

  const source = scenario(report, "source-and-image-slots");
  const qa = scenario(report, "qa-under-budget");
  expect(source.pass).toBe(false);
  expect(field(source, "no-script")?.pass).toBe(false);
  expect(qa.pass).toBe(false);
  expect(field(qa, "no-script")?.evidence.violations).toEqual(expect.arrayContaining([
    expect.stringContaining("<script>"),
    expect.stringContaining("srcdoc"),
  ]));
  expect(field(qa, "no-external-url")?.evidence.violations).toEqual(expect.arrayContaining([
    expect.stringContaining("inline style"),
    expect.stringContaining("https://example.com"),
    expect.stringContaining("asset://ghost"),
  ]));
});

it("does not count hidden source IDs as visible evidence", async () => {
  const report = await score((outputs) => writeScenario(outputs, "source-and-image-slots", validSourceFiles({
    "slide-01.html": '<figure data-asset-slot="cover-image"></figure><p data-slot="source" hidden>block-018</p>',
    "slide-02.html": '<div aria-hidden="true"><p data-slot="source">block-031</p></div>',
  })));

  const record = scenario(report, "source-and-image-slots");
  expect(record.pass).toBe(false);
  expect(field(record, "valid-source-refs")?.pass).toBe(false);
});

it("requires concrete contact-sheet defects and meaningful targeted repairs", async () => {
  const report = await score((outputs) => writeScenario(outputs, "qa-under-budget", validQaFiles({
    processOverrides: {
      contactSheetReview: {
        slideIds: qaSlideIds,
        findings: [{ slideId: "slide-03", defect: "ok" }],
      },
      targetedRepairs: [{ slideId: "slide-03", repair: "fixed" }],
    },
  })));

  const record = scenario(report, "qa-under-budget");
  expect(record.pass).toBe(false);
  expect(field(record, "one-contact-sheet-review")?.pass).toBe(false);
  expect(field(record, "one-targeted-repair")?.pass).toBe(false);
});

it("rejects a later fixed-canvas override", async () => {
  const report = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":root { --deck-bg: #fff; }\n:slide { width: 1920px; height: 1080px; }\n:slide { width: 100%; }\n",
    "process.json": { designDirection: "one direction" },
  }));

  const record = scenario(report, "dense-fast-pressure");
  expect(record.pass).toBe(false);
  expect(field(record, "fixed-canvas")?.pass).toBe(false);
});
