import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore } from "../../../server/deck-agent/artifact-store.mjs";
import { createRenderer } from "../../../server/deck-agent/renderer.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeRoot = path.join(repositoryRoot, "skills/generate-html-deck/assets/runtime");
const packageDeckCli = path.join(repositoryRoot, "skills/generate-html-deck/scripts/package-deck.mjs");
const jobId = "job-00000000-0000-4000-8000-000000000001";
const revisionId = "revision-000001";
const completeThemeCss = ":root{--deck-bg:#ffffff;--deck-surface:#f4f5f7;--deck-text:#111111;--deck-muted:#555555;--deck-primary:#075ccb;--deck-secondary:#243447;--deck-accent:#d9363e;--deck-positive:#14804a;--deck-negative:#b42318;--deck-font-sans:Arial,sans-serif;--deck-font-serif:Georgia,serif;--deck-title-size:72px;--deck-heading-size:48px;--deck-body-size:30px;--deck-caption-size:20px;--deck-radius:8px;--deck-space:24px;--deck-grid-gap:32px;}";
const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const temporaryRoots = [];

let rootDir;
let store;
let asset;
let renderer;

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function seedRevision(targetRevision = revisionId) {
  const prefix = targetRevision === "working" ? "working" : `revisions/${targetRevision}`;
  const manifest = {
    version: 1,
    title: "Quarterly Review",
    assets: [asset],
    slides: [
      {
        slideId: "slide-01",
        title: "Evidence first",
        speakerNotes: "Explain <the evidence> & the next step.\u2028Keep it grounded.",
        sourceRefs: ["block-018"],
        density: "tight",
        status: "done",
        assetSlots: [],
        charts: [{
          chartId: "chart-growth",
          type: "bar",
          labels: ["A</template>", "B & C"],
          series: [{ name: "Growth", values: [12, 19], colorToken: "primary" }],
        }],
      },
      {
        slideId: "slide-02",
        title: "Decision",
        speakerNotes: "Close with the decision.",
        sourceRefs: ["block-031"],
        status: "done",
        assetSlots: [],
        charts: [],
      },
    ],
  };
  await store.writeJson(jobId, `${prefix}/manifest.json`, manifest);
  await store.writeArtifact(jobId, `${prefix}/theme.css`, completeThemeCss);
  await store.writeArtifact(
    jobId,
    `${prefix}/slides/slide-01.html`,
    `<h1>Evidence first</h1><div data-chart-id="chart-growth"></div><img src="asset://${asset.id}" alt="Evidence image">`,
  );
  await store.writeArtifact(
    jobId,
    `${prefix}/slides/slide-01.css`,
    '[data-slide-id="slide-01"] h1{color:#111111;letter-spacing:0}',
  );
  await store.writeArtifact(jobId, `${prefix}/slides/slide-02.html`, "<h1>Decision</h1><p>Act now.</p>");
  await store.writeArtifact(
    jobId,
    `${prefix}/slides/slide-02.css`,
    '[data-slide-id="slide-02"] h1{color:#111111;letter-spacing:0}',
  );
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(tmpdir(), "deck-renderer-"));
  temporaryRoots.push(rootDir);
  store = createArtifactStore({ rootDir });
  await store.createJob({
    jobId,
    title: "Quarterly Review",
    input: {
      source: { topic: "Quarterly Review", audience: "leaders", slideCount: 2, textInput: "source document", apiKey: "must-not-leak" },
      options: {},
    },
    sourceBlocks: [{ id: "block-018" }, { id: "block-031" }],
  });
  [asset] = await store.persistUploadedAssets(jobId, [{ name: "pixel.png", summary: "Evidence", dataUrl: onePixelPng }]);
  await seedRevision();
  renderer = createRenderer({ store, runtimeRoot, appOrigin: "https://deck.example.test" });
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fixed deck renderer", () => {
  it("assembles a fixed 1920x1080 offline document without workspace leaks", async () => {
    const html = await renderer.assembleStandalone({ jobId, revisionId });

    expect(html).toContain("--deck-width:1920px");
    expect(html).toContain("--deck-height:1080px");
    expect(html).toContain("--deck-safe-inset:72px");
    expect(html).toMatch(/\.deck-slide\{[^}]*padding:0;/);
    expect(html).not.toContain("padding:var(--deck-safe-inset)");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("style-src-attr 'unsafe-inline'");
    expect(html).not.toContain("navigate-to");
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain("unsafe-eval");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain(rootDir);
    expect(html).not.toMatch(/api[_-]?key|toolCalls|system prompt/i);
    expect(html).not.toContain(jobId);
    expect(html).not.toContain(revisionId);
    expect(html).toContain("<!-- deck-third-party-notices:start");
    expect(html).toContain("Reveal.js 6.0.1");
    expect(html).toContain("MIT License");
    expect(html).toContain("Apache ECharts 6.1.0");
    expect(html).toContain("Apache License 2.0");
    expect(html).toContain("Copyright 2017-2026 The Apache Software Foundation");
    expect(html).toContain("deck-third-party-notices:end -->");
    expect(html).toContain(`data:image/png;base64,`);
    expect(html).not.toContain("asset://");
  });

  it("wraps rootless fragments with trusted slide identity, sources, density, and escaped notes", async () => {
    const html = await renderer.assembleStandalone({ jobId, revisionId });

    expect(html.match(/<article class="deck-slide" data-slide-root/g)).toHaveLength(2);
    expect(html).toContain('data-slide-id="slide-01" data-source-refs="block-018" data-density="tight"');
    expect(html).toContain('data-slide-id="slide-02" data-source-refs="block-031"');
    expect(html).toContain('<aside class="notes">Explain &lt;the evidence&gt; &amp; the next step.');
    expect(html).not.toContain("<the evidence>");
    expect(html.match(/<aside class="notes">/g)).toHaveLength(2);
  });

  it("normalizes legacy stored section markup and selectors before Reveal assembly", async () => {
    const prefix = `revisions/${revisionId}`;
    await store.writeArtifact(
      jobId,
      `${prefix}/slides/slide-02.html`,
      '<section class="legacy-shell"><h1>Decision</h1></section>',
    );
    await store.writeArtifact(
      jobId,
      `${prefix}/slides/slide-02.css`,
      '[data-slide-id="slide-02"] > section.legacy-shell { display:grid }',
    );

    const html = await renderer.assembleStandalone({ jobId, revisionId });

    expect(html).toContain('<div class="legacy-shell"><h1>Decision</h1></div>');
    expect(html).toContain('[data-slide-id="slide-02"]>div.legacy-shell{display:grid}');
    expect(html).not.toContain('<section class="legacy-shell"');
    expect(html).not.toContain('[data-slide-id="slide-02"]>section.legacy-shell');
  });

  it("embeds escaped, schema-validated chart options for the fixed ECharts runtime", async () => {
    const html = await renderer.assembleStandalone({ jobId, revisionId });

    expect(html).toContain('<template id="deck-chart-data">');
    expect(html).toContain("chart-growth");
    expect(html).toContain("\\u003c/template\\u003e");
    expect(html).not.toContain("A</template>");
    expect(html).toContain("template.content.textContent");
    expect(html).toContain("setOption");
    const serviceRuntime = html.slice(
      html.indexOf("/* deck-runtime:start */"),
      html.indexOf("/* deck-runtime:end */"),
    );
    expect(serviceRuntime).not.toContain("innerHTML");
  });

  it("assembles preview assets only under the configured origin and injects the guarded bridge", async () => {
    const html = await renderer.assemblePreview({ jobId, revisionId });

    expect(html).toContain(`https://deck.example.test/api/html-deck/jobs/${jobId}/artifacts/${asset.id}`);
    expect(html).toContain("img-src data: blob: https://deck.example.test");
    expect(html).toContain('event.origin !== "https://deck.example.test"');
    expect(html).toContain(`jobId: "${jobId}"`);
    expect(html).toContain("revision: 1");
    expect(html).not.toContain(`revision: "${revisionId}"`);
    expect(html).toContain('message.type !== "deck-command"');
    expect(html).toContain("event.source !== parent");
  });

  it("rejects arbitrary revisions and unknown manifest assets", async () => {
    await expect(renderer.assembleStandalone({ jobId, revisionId: "../working" })).rejects.toThrow(/revision/i);

    const prefix = `revisions/${revisionId}`;
    await store.writeArtifact(
      jobId,
      `${prefix}/slides/slide-01.html`,
      '<img src="asset://asset-missing" alt="Missing">',
    );
    await expect(renderer.assembleStandalone({ jobId, revisionId })).rejects.toThrow(/asset/i);
  });

  it("rejects duplicate slide identities before assembly", async () => {
    const prefix = `revisions/${revisionId}`;
    const manifest = await store.readJson(jobId, `${prefix}/manifest.json`);
    manifest.slides[1].slideId = "slide-01";
    await store.writeJson(jobId, `${prefix}/manifest.json`, manifest);

    await expect(renderer.assembleStandalone({ jobId, revisionId })).rejects.toThrow(/duplicate.*slide/i);
  });

  it("recomputes every pinned runtime hash and rejects tampering", async () => {
    const fakeRoot = await mkdtemp(path.join(tmpdir(), "deck-runtime-"));
    temporaryRoots.push(fakeRoot);
    const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "runtime-manifest.json"), "utf8"));
    const copiedRecords = [];
    for (const [index, record] of manifest.files.entries()) {
      const source = path.resolve(runtimeRoot, record.relativePath);
      const relativePath = `file-${index}${path.extname(record.relativePath)}`;
      await cp(source, path.join(fakeRoot, relativePath));
      copiedRecords.push({ ...record, relativePath });
    }
    await writeFile(path.join(fakeRoot, "runtime-manifest.json"), `${JSON.stringify({ version: 1, files: copiedRecords }, null, 2)}\n`);
    await writeFile(path.join(fakeRoot, copiedRecords[0].relativePath), "tampered runtime");
    const untrusted = createRenderer({ store, runtimeRoot: fakeRoot, appOrigin: "https://deck.example.test" });

    await expect(untrusted.verifyRuntime()).rejects.toThrow(/hash/i);
  });

  it("writes bounded QA artifacts through revision-safe paths", async () => {
    const result = await renderer.writeQaArtifact({
      jobId,
      revisionId,
      filename: "slides/slide-01.png",
      data: Buffer.from("png evidence"),
    });

    expect(result).toEqual({
      artifactId: "revisions-revision-000001-qa-slides-slide-01",
      relativePath: "revisions/revision-000001/qa/slides/slide-01.png",
    });
    expect(await store.readArtifact(jobId, result.relativePath, { encoding: null })).toEqual(Buffer.from("png evidence"));
    await expect(renderer.writeQaArtifact({ jobId, revisionId, filename: "../../secret.png", data: "x" }))
      .rejects.toThrow(/QA artifact/i);
  });

  it("fences QA artifact writes with the verification cancellation signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("verification cancelled"));

    await expect(renderer.writeQaArtifact({
      jobId,
      revisionId,
      filename: "slides/cancelled.png",
      data: Buffer.from("late evidence"),
      signal: controller.signal,
    })).rejects.toThrow(/verification cancelled/i);
    expect(await store.readArtifact(
      jobId,
      `revisions/${revisionId}/qa/slides/cancelled.png`,
      { optional: true, encoding: null },
    )).toBeUndefined();
  });

  it("packages standalone HTML through a bounded CLI with no output path option", async () => {
    const { stdout } = await execFileAsync(process.execPath, [packageDeckCli, "--job", jobId, "--revision", revisionId], {
      cwd: repositoryRoot,
      env: { ...process.env, DECK_JOB_ROOT: rootDir },
    });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ ok: true, jobId, revisionId });
    expect(result.byteLength).toBeGreaterThan(100_000);
    const packaged = await store.readArtifact(jobId, `revisions/${revisionId}/dist/index.html`);
    expect(packaged).toContain("connect-src 'none'");

    await expect(execFileAsync(process.execPath, [
      packageDeckCli,
      "--job", jobId,
      "--revision", revisionId,
      "--output", path.join(rootDir, "leak.html"),
    ], { cwd: repositoryRoot, env: { ...process.env, DECK_JOB_ROOT: rootDir } })).rejects.toMatchObject({
      stdout: expect.stringMatching(/"ok":false/),
    });
  });
});

it("pins the exact Reveal and ECharts packages in the runtime manifest", async () => {
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "runtime-manifest.json"), "utf8"));
  expect(manifest.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ package: "reveal.js", version: "6.0.1", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    expect.objectContaining({ package: "echarts", version: "6.1.0", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    expect.objectContaining({ package: "deckforge-runtime", relativePath: "base.css", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    expect.objectContaining({ package: "deckforge-runtime", relativePath: "bridge.js", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
  ]));
  expect(new Set(manifest.files.map((record) => `${record.package}:${record.relativePath}`)).size).toBe(5);
  for (const record of manifest.files) {
    expect(sha256(await readFile(path.resolve(runtimeRoot, record.relativePath)))).toBe(record.sha256);
  }
});
