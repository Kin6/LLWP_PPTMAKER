import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
const qaCalibrationSlideIds = ["slide-01", "slide-06"];
const qaBuildSlideIds = qaSlideIds.filter((slideId) => !qaCalibrationSlideIds.includes(slideId));
const qaBuildBatches = [["slide-02", "slide-03", "slide-04"], ["slide-05", "slide-07", "slide-08"]];
const qaPageCheckpoints = qaBuildSlideIds.map((slideId) => ({ slideId, status: "valid" }));
const imageResolutionOrder = ["uploaded-assets", "licensed-internal-assets", "optional-generation", "no-image-layout"];
const byteLimits = {
  markdown: 2 * 1024 * 1024,
  slideHtml: 200 * 1024,
  slideCss: 120 * 1024,
  json: 10 * 1024 * 1024,
  image: 12 * 1024 * 1024,
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function score(setup, scenarioPath = scenarios) {
  const root = await mkdtemp(path.join(tmpdir(), "deck-score-"));
  temporaryRoots.push(root);
  const outputs = path.join(root, "outputs");
  const report = path.join(root, "report.json");
  await setup(outputs);
  try {
    await execFileAsync(process.execPath, [scorer, "--scenarios", scenarioPath, "--outputs", outputs, "--report", report], {
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

function padToBytes(contents, byteLength) {
  const padding = byteLength - Buffer.byteLength(contents, "utf8");
  if (padding < 0) throw new Error("Requested byte length is smaller than content");
  return `${contents}${" ".repeat(padding)}`;
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
    "deck.css": ":slide { width: 1920px; height: 1080px; overflow: hidden; }\n",
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

it("accepts at most one calibration correction, locks design, and builds only remaining slides", async () => {
  const report = await score((outputs) => writeScenario(outputs, "qa-under-budget", validQaFiles({
    processOverrides: {
      calibrationSlideIds: qaCalibrationSlideIds,
      calibrationCorrectionCount: 1,
      designRulesLocked: true,
      buildBatches: qaBuildBatches,
      pageCheckpoints: qaPageCheckpoints,
    },
  })));

  const record = scenario(report, "qa-under-budget");
  expect(field(record, "cover-dense-calibration")?.pass).toBe(true);
  expect(field(record, "batch-size-2-3")?.pass).toBe(true);
});

it("rejects calibration correction overflow or an unlocked design", async () => {
  const report = await score((outputs) => writeScenario(outputs, "qa-under-budget", validQaFiles({
    processOverrides: {
      calibrationSlideIds: qaCalibrationSlideIds,
      calibrationCorrectionCount: 2,
      designRulesLocked: false,
      buildBatches: qaBuildBatches,
      pageCheckpoints: qaPageCheckpoints,
    },
  })));

  expect(field(scenario(report, "qa-under-budget"), "cover-dense-calibration")?.pass).toBe(false);
});

it("rejects build batches without one valid checkpoint per remaining page", async () => {
  const report = await score((outputs) => writeScenario(outputs, "qa-under-budget", validQaFiles({
    processOverrides: {
      calibrationSlideIds: qaCalibrationSlideIds,
      calibrationCorrectionCount: 0,
      designRulesLocked: true,
      buildBatches: qaBuildBatches,
      pageCheckpoints: qaPageCheckpoints.slice(0, -1),
    },
  })));

  expect(field(scenario(report, "qa-under-budget"), "batch-size-2-3")?.pass).toBe(false);
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

it("rejects every prohibited hostile fragment element without URL attributes", async () => {
  const report = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<form></form><frame></frame><iframe></iframe><embed><object></object><svg><circle></circle></svg><math><mi>x</mi></math>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":root { --deck-bg: #fff; }\n:slide { width: 1920px; height: 1080px; }\n",
    "process.json": { designDirection: "one direction" },
  }));

  const security = field(scenario(report, "dense-fast-pressure"), "no-script");
  expect(security?.pass).toBe(false);
  for (const tag of ["form", "frame", "iframe", "embed", "object", "svg", "math"]) {
    expect(security?.evidence.violations).toEqual(expect.arrayContaining([
      expect.stringContaining(`<${tag}>`),
    ]));
  }
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

it("rejects image resolution that does not use the required ordered chain", async () => {
  const files = validSourceFiles();
  files["process.json"] = {
    ...files["process.json"],
    imageResolutionOrder: ["optional-generation", "uploaded-assets", "licensed-internal-assets", "no-image-layout"],
  };
  const report = await score((outputs) => writeScenario(outputs, "source-and-image-slots", files));

  expect(field(scenario(report, "source-and-image-slots"), "no-image-fallback")?.pass).toBe(false);
});

it("accepts an optional image failure that resolves to a no-image layout", async () => {
  const files = validSourceFiles();
  files["process.json"] = {
    ...files["process.json"],
    imageResolutionOrder,
    optionalImageFailures: [{ slot: "cover-image", outcome: "no-image-layout" }],
  };
  const report = await score((outputs) => writeScenario(outputs, "source-and-image-slots", files));

  expect(scenario(report, "source-and-image-slots").pass).toBe(true);
  expect(field(scenario(report, "source-and-image-slots"), "no-image-fallback")?.pass).toBe(true);
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

it("accepts a clean whole-deck review with zero findings and zero repairs", async () => {
  const report = await score((outputs) => writeScenario(outputs, "qa-under-budget", validQaFiles({
    processOverrides: {
      calibrationCorrectionCount: 0,
      designRulesLocked: true,
      buildBatches: qaBuildBatches,
      pageCheckpoints: qaPageCheckpoints,
      contactSheetReview: { slideIds: qaSlideIds, findings: [] },
      targetedRepairRounds: 0,
      targetedRepairs: [],
    },
  })));

  const record = scenario(report, "qa-under-budget");
  expect(field(record, "one-contact-sheet-review")?.pass).toBe(true);
  expect(field(record, "one-targeted-repair")?.pass).toBe(true);
  expect(record.pass).toBe(true);
});

it("accepts one targeted repair only for a matching failed slide", async () => {
  const report = await score((outputs) => writeScenario(outputs, "qa-under-budget", validQaFiles({
    processOverrides: {
      calibrationCorrectionCount: 1,
      designRulesLocked: true,
      buildBatches: qaBuildBatches,
      pageCheckpoints: qaPageCheckpoints,
      contactSheetReview: {
        slideIds: qaSlideIds,
        findings: [{ slideId: "slide-03", defect: "The metric panel clips its final line at the lower edge." }],
      },
      targetedRepairRounds: 1,
      targetedRepairs: [{ slideId: "slide-03", repair: "Reduced panel padding and rechecked the complete final line." }],
    },
  })));

  expect(field(scenario(report, "qa-under-budget"), "one-targeted-repair")?.pass).toBe(true);
});

it("rejects a later fixed-canvas override", async () => {
  const report = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":root { --deck-bg: #fff; }\n:slide { width: 1920px; height: 1080px; overflow: hidden; }\n:slide { width: 100%; }\n",
    "process.json": { designDirection: "one direction" },
  }));

  const record = scenario(report, "dense-fast-pressure");
  expect(record.pass).toBe(false);
  expect(field(record, "fixed-canvas")?.pass).toBe(false);
});

it("requires hidden overflow and rejects incompatible scoped canvas variants", async () => {
  const missingOverflow = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":slide { width: 1920px; height: 1080px; }\n",
    "process.json": { designDirection: "one direction" },
  }));
  const scopedOverride = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":slide { width: 1920px; height: 1080px; overflow: hidden; }\n:slide:first-child, :slide.cover { width: 100px; overflow: visible; }\n",
    "process.json": { designDirection: "one direction" },
  }));
  const importantOverride = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":slide { width: 100px !important; height: 1080px; overflow: hidden; }\n:slide { width: 1920px; }\n",
    "process.json": { designDirection: "one direction" },
  }));
  const axisOverride = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":slide { width: 1920px; height: 1080px; overflow: hidden; overflow-x: visible; }\n",
    "process.json": { designDirection: "one direction" },
  }));

  expect(field(scenario(missingOverflow, "dense-fast-pressure"), "fixed-canvas")?.pass).toBe(false);
  const overridden = field(scenario(scopedOverride, "dense-fast-pressure"), "fixed-canvas");
  expect(overridden?.pass).toBe(false);
  expect(overridden?.evidence.violations).toEqual(expect.arrayContaining([
    expect.stringContaining(":slide:first-child"),
    expect.stringContaining(":slide.cover"),
  ]));
  expect(field(scenario(importantOverride, "dense-fast-pressure"), "fixed-canvas")?.pass).toBe(false);
  expect(field(scenario(axisOverride, "dense-fast-pressure"), "fixed-canvas")?.pass).toBe(false);
});

it.each([
  ["missing slot", "<p data-slot=\"source\">block-018</p>", [{ slot: "cover-image", outcome: "no-image-layout" }]],
  ["unrelated slot", '<figure data-asset-slot="other-image"></figure><p data-slot="source">block-018</p>', [{ slot: "cover-image", outcome: "no-image-layout" }]],
  ["non-empty slot", '<figure data-asset-slot="cover-image"><span>fallback</span></figure><p data-slot="source">block-018</p>', [{ slot: "cover-image", outcome: "no-image-layout" }]],
  ["duplicate metadata", '<figure data-asset-slot="cover-image"></figure><p data-slot="source">block-018</p>', [{ slot: "cover-image", outcome: "no-image-layout" }, { slot: "cover-image", outcome: "no-image-layout" }]],
  ["invalid metadata", '<figure data-asset-slot="cover-image"></figure><p data-slot="source">block-018</p>', [{ slot: "cover-image", outcome: "remote-image" }]],
])("rejects optional image failure with %s", async (_label, slideHtml, optionalImageFailures) => {
  const files = validSourceFiles({ "slide-01.html": slideHtml });
  files["process.json"] = {
    ...files["process.json"],
    imageResolutionOrder,
    optionalImageFailures,
  };
  const report = await score((outputs) => writeScenario(outputs, "source-and-image-slots", files));

  expect(field(scenario(report, "source-and-image-slots"), "no-image-fallback")?.pass).toBe(false);
});

it("rejects the comprehensive URL-bearing attribute set", async () => {
  const attributes = ["cite", "ping", "data", "longdesc", "manifest", "usemap", "xlink:href", "background", "archive", "codebase", "classid", "profile", "attributionsrc", "dynsrc", "imagesrcset", "itemtype", "lowsrc"];
  const html = `<div ${attributes.map((name) => `${name}=\"asset://local-example\"`).join(" ")}>Cover</div>`;
  const report = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": html,
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":slide { width: 1920px; height: 1080px; overflow: hidden; }\n",
    "process.json": { designDirection: "one direction" },
  }));

  const violations = field(scenario(report, "dense-fast-pressure"), "no-external-url")?.evidence.violations.join("\n");
  for (const name of attributes) expect(violations).toContain(`${name}=asset://local-example`);
});

it("does not count source IDs hidden by common CSS declarations", async () => {
  const hidingDeclarations = [
    "display: none",
    "visibility: collapse",
    "opacity: 0",
    "color: transparent",
    "font-size: 0",
    "content-visibility: hidden",
    "clip: rect(0 0 0 0)",
    "clip-path: inset(50%)",
    "transform: scale(0)",
  ];

  for (const declaration of hidingDeclarations) {
    const report = await score((outputs) => writeScenario(outputs, "source-and-image-slots", validSourceFiles({
      "deck.css": `:slide [data-slot=\"source\"] { ${declaration}; }\n`,
    })));
    const sourceRefs = field(scenario(report, "source-and-image-slots"), "valid-source-refs");
    expect(sourceRefs?.pass, declaration).toBe(false);
    expect(sourceRefs?.evidence.cssHidingDeclarations.join("\n"), declaration).toContain(declaration.split(":")[0]);
  }
});

it("requires only the singular non-empty designDirection field", async () => {
  const pluralOnly = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":slide { width: 1920px; height: 1080px; overflow: hidden; }\n",
    "process.json": { designDirections: ["plural direction"] },
  }));
  const conflicting = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":slide { width: 1920px; height: 1080px; overflow: hidden; }\n",
    "process.json": { designDirection: "canonical direction", designDirections: ["conflicting direction"] },
  }));

  expect(field(scenario(pluralOnly, "dense-fast-pressure"), "one-design-direction")?.pass).toBe(false);
  expect(field(scenario(conflicting, "dense-fast-pressure"), "one-design-direction")?.pass).toBe(false);
});

it("rejects full-document wrappers through a universal fragment check", async () => {
  const report = await score(async (outputs) => {
    await writeScenario(outputs, "dense-fast-pressure", {
      "slide-01.html": "<!doctype html><p>Cover</p>",
      "slide-02.html": "<p>Evidence</p>",
      "deck.css": ":slide { width: 1920px; height: 1080px; overflow: hidden; }\n",
      "process.json": { designDirection: "one direction" },
    });
    await writeScenario(outputs, "source-and-image-slots", validSourceFiles({
      "slide-01.html": '<html><figure data-asset-slot="cover-image"></figure><p data-slot="source">block-018</p></html>',
    }));
    await writeScenario(outputs, "qa-under-budget", validQaFiles({
      htmlOverrides: { "slide-01.html": "<head><title>Wrapped</title></head><body><p>slide-01</p></body>" },
    }));
  });

  for (const id of ["dense-fast-pressure", "source-and-image-slots", "qa-under-budget"]) {
    const structure = field(scenario(report, id), "fragment-structure");
    expect(structure?.pass).toBe(false);
    expect(structure?.evidence.violations.length).toBeGreaterThan(0);
  }
});

it("bounds the scenarios file at exactly 10 MiB and rejects symlinks before reading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-score-scenario-input-"));
  temporaryRoots.push(root);
  const exactPath = path.join(root, "exact.json");
  const oversizedPath = path.join(root, "oversized.json");
  const symlinkPath = path.join(root, "linked.json");
  const scenarioText = await readFile(scenarios, "utf8");
  await writeFile(exactPath, padToBytes(scenarioText, byteLimits.json), "utf8");
  const exactReport = await score(async () => {}, exactPath);
  expect(exactReport.scenarios).toHaveLength(3);

  await writeFile(oversizedPath, padToBytes(scenarioText, byteLimits.json + 1), "utf8");
  const outputs = path.join(root, "outputs");
  const report = path.join(root, "oversized-report.json");
  await expect(execFileAsync(process.execPath, [scorer, "--scenarios", oversizedPath, "--outputs", outputs, "--report", report], {
    cwd: repositoryRoot,
  })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(`Scenarios file: exceeds ${byteLimits.json} byte limit`),
  });

  await symlink(scenarios, symlinkPath);
  await expect(execFileAsync(process.execPath, [scorer, "--scenarios", symlinkPath, "--outputs", outputs, "--report", report], {
    cwd: repositoryRoot,
  })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Scenarios file: symbolic links are forbidden"),
  });
});

it("reports scenario-root and artifact symlinks as safety evidence", async () => {
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "deck-score-outside-"));
  temporaryRoots.push(outsideRoot);
  await writeScenario(outsideRoot, "dense-fast-pressure", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":root { --deck-bg: #fff; }\n:slide { width: 1920px; height: 1080px; }\n",
    "process.json": { designDirection: "one direction" },
  });
  const outsideFile = path.join(outsideRoot, "outside.html");
  await writeFile(outsideFile, "<p>outside</p>", "utf8");

  const report = await score(async (outputs) => {
    await mkdir(outputs, { recursive: true });
    await symlink(path.join(outsideRoot, "dense-fast-pressure"), path.join(outputs, "dense-fast-pressure"));
    await writeScenario(outputs, "source-and-image-slots", validSourceFiles());
    await symlink(outsideFile, path.join(outputs, "source-and-image-slots/escape.html"));
  });

  for (const id of ["dense-fast-pressure", "source-and-image-slots"]) {
    const safety = field(scenario(report, id), "artifact-safety");
    expect(safety?.pass).toBe(false);
    expect(safety?.evidence.violations.join("\n")).toMatch(/symbolic link/i);
  }
});

it("reports a scenario-id path escape instead of reading outside the outputs root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-score-scenarios-"));
  temporaryRoots.push(root);
  const scenarioPath = path.join(root, "scenarios.json");
  await writeFile(scenarioPath, `${JSON.stringify([{
    id: "../escaped-scenario",
    request: "escape test",
    mustPass: ["one-design-direction"],
  }])}\n`, "utf8");
  const report = await score((outputs) => writeScenario(outputs, "../escaped-scenario", {
    "slide-01.html": "<p>Cover</p>",
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": ":root { --deck-bg: #fff; }\n:slide { width: 1920px; height: 1080px; }\n",
    "process.json": { designDirection: "one direction" },
  }), scenarioPath);

  const safety = field(scenario(report, "../escaped-scenario"), "artifact-safety");
  expect(safety?.pass).toBe(false);
  expect(safety?.evidence.violations.join("\n")).toMatch(/escape.*output root/i);
});

it("reports exact Markdown, slide HTML, slide CSS, and JSON byte limits before reading", async () => {
  const report = await score((outputs) => writeScenario(outputs, "dense-fast-pressure", {
    "notes.md": "x".repeat(byteLimits.markdown + 1),
    "slide-01.html": padToBytes("<p>Cover</p>", byteLimits.slideHtml + 1),
    "slide-02.html": "<p>Evidence</p>",
    "deck.css": padToBytes(":slide { width: 1920px; height: 1080px; }", byteLimits.slideCss + 1),
    "process.json": padToBytes(JSON.stringify({ designDirection: "one direction" }), byteLimits.json + 1),
  }));

  const safety = field(scenario(report, "dense-fast-pressure"), "artifact-safety");
  expect(safety?.pass).toBe(false);
  expect(safety?.evidence.violations).toEqual(expect.arrayContaining([
    `notes.md: exceeds ${byteLimits.markdown} byte limit`,
    `slide-01.html: exceeds ${byteLimits.slideHtml} byte limit`,
    `deck.css: exceeds ${byteLimits.slideCss} byte limit`,
    `process.json: exceeds ${byteLimits.json} byte limit`,
  ]));
});

it("reports symlinked and oversized media catalog files without crashing", async () => {
  const { loadMediaCatalog } = await import("./score-output.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "deck-media-root-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "deck-media-outside-"));
  temporaryRoots.push(root, outsideRoot);
  const catalogPath = path.join(root, "catalog.json");
  const outsideCatalog = path.join(outsideRoot, "catalog.json");
  await writeFile(outsideCatalog, '{"assets":[]}\n', "utf8");
  await symlink(outsideCatalog, catalogPath);

  let media = await loadMediaCatalog({ mediaRoot: root, catalogPath });
  expect(media.violations).toContain("catalog.json: symbolic links are forbidden");

  await rm(catalogPath);
  const entry = {
    id: "reviewed-image",
    file: "reviewed-image.png",
    tags: ["evidence"],
    license: "internal",
    sourceUrl: "https://example.invalid/license",
    sha256: "0".repeat(64),
  };
  await writeFile(catalogPath, `${JSON.stringify({ assets: [entry] })}\n`, "utf8");
  const outsideImage = path.join(outsideRoot, "outside.png");
  await writeFile(outsideImage, "image", "utf8");
  await symlink(outsideImage, path.join(root, entry.file));
  media = await loadMediaCatalog({ mediaRoot: root, catalogPath });
  expect(media.violations).toContain(`${entry.file}: symbolic links are forbidden`);

  await rm(path.join(root, entry.file));
  await writeFile(path.join(root, entry.file), Buffer.alloc(byteLimits.image + 1));
  media = await loadMediaCatalog({ mediaRoot: root, catalogPath });
  expect(media.violations).toContain(`${entry.file}: exceeds ${byteLimits.image} byte limit`);

  await writeFile(catalogPath, padToBytes('{"assets":[]}', byteLimits.json + 1), "utf8");
  media = await loadMediaCatalog({ mediaRoot: root, catalogPath });
  expect(media.violations).toContain(`catalog.json: exceeds ${byteLimits.json} byte limit`);
});
