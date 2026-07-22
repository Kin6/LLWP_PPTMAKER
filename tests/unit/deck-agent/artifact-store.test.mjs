import { describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createArtifactStore, DEFAULT_QUOTAS, resolveJobPath } from "../../../server/deck-agent/artifact-store.mjs";

const jobId = "job-00000000-0000-4000-8000-000000000001";

describe("artifact store", () => {
  it("resolves only server-owned paths inside a valid job workspace", () => {
    const rootDir = path.join(tmpdir(), "deck-root");
    expect(resolveJobPath(rootDir, jobId, "working/slides/slide-01.html").target)
      .toBe(path.join(rootDir, jobId, "working/slides/slide-01.html"));
    expect(() => resolveJobPath(rootDir, "../../other", "job.json")).toThrow(/path/i);
    expect(() => resolveJobPath(rootDir, jobId, "working/slides/slide-1.html")).toThrow(/path/i);
  });

  it("rejects traversal, encoded traversal, Windows separators, and symlink escape", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const store = createArtifactStore({ rootDir, quotas: { ...DEFAULT_QUOTAS, job: 1024 * 1024, markdown: 32 } });
    await store.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });
    for (const candidate of ["../.env", "%2e%2e/.env", "..\\.env", "/tmp/secret", "slides/x\0.html"]) {
      await expect(store.writeArtifact(jobId, candidate, "x")).rejects.toThrow(/path/i);
    }
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
    await mkdir(path.join(rootDir, jobId, "working"), { recursive: true });
    await symlink(outside, path.join(rootDir, jobId, "working", "slides"));
    await expect(store.writeArtifact(jobId, "working/slides/slide-01.html", "x")).rejects.toThrow(/symbolic link/i);
    await expect(store.writeArtifact(jobId, "slides-content.md", "x".repeat(33))).rejects.toThrow(/quota|limit/i);
  });

  it("keeps the previous artifact when rename fails", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const baseStore = createArtifactStore({ rootDir });
    await baseStore.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });
    await baseStore.writeArtifact(jobId, "slides-content.md", "old");
    const faultyStore = createArtifactStore({ rootDir, fsHooks: { beforeRename: () => { throw new Error("rename fault"); } } });
    await expect(faultyStore.writeArtifact(jobId, "slides-content.md", "new")).rejects.toThrow(/rename fault/);
    expect(await readFile(path.join(rootDir, jobId, "slides-content.md"), "utf8")).toBe("old");
  });

  it("persists state separately from restart input and material source blocks", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const store = createArtifactStore({ rootDir });
    const sourceBlocks = [{ id: "block-1", text: "material" }];
    const input = {
      source: {
        topic: "A safe topic", audience: "leaders", slideCount: 8, textInput: "notes",
        tableInput: "", imageBrief: "portrait", styleId: "blank",
        images: [{ name: "secret.png", dataUrl: "data:image/png;base64,c2VjcmV0", summary: "raw" }],
        sourceBlocks,
        provider: "attacker",
      },
      options: { imageEnabled: true, imageCount: 1, imageQuality: "high", imageTimeoutMs: 240000, imageMaxRetries: 1 },
      apiKey: "must-not-survive",
      provider: { baseUrl: "https://attacker.invalid" },
      rawModelOutput: "private chain of thought",
    };

    const created = await store.createJob({ jobId, title: "测试", input, sourceBlocks });
    expect(created).toMatchObject({ id: jobId, title: "测试", status: "queued", lastSeq: 0, revision: 0, attempts: {}, checkpoints: [] });
    expect(Object.keys(await store.readJson(jobId, "job.json")).sort()).toEqual([
      "attempts", "checkpoints", "createdAt", "id", "lastSeq", "revision", "status", "title", "updatedAt",
    ]);
    const persistedInput = await store.readJson(jobId, "job-input.json");
    expect(persistedInput.source).toMatchObject({ topic: "A safe topic", audience: "leaders", slideCount: 8 });
    expect(JSON.stringify(persistedInput)).not.toMatch(/apiKey|attacker|data:image|rawModelOutput|chain of thought|sourceBlocks/);
    expect(await store.readJson(jobId, "source-blocks.json")).toEqual(sourceBlocks);

    const updated = await store.updateJob(jobId, { status: "outline", checkpoints: ["queued"] });
    expect(updated).toMatchObject({ status: "outline", checkpoints: ["queued"] });
    expect(await store.readJob(jobId)).toEqual(updated);
  });

  it("checks individual and total quotas before invoking rename", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    let renameAttempts = 0;
    const store = createArtifactStore({
      rootDir,
      quotas: { ...DEFAULT_QUOTAS, job: 2_000, markdown: 4 },
      fsHooks: { beforeRename: () => { renameAttempts += 1; } },
    });
    await store.createJob({ jobId, title: "q", input: { source: {}, options: {} }, sourceBlocks: [] });
    const attemptsAfterCreate = renameAttempts;
    await expect(store.writeArtifact(jobId, "slides-content.md", "12345")).rejects.toThrow(/quota|limit/i);
    expect(renameAttempts).toBe(attemptsAfterCreate);

    const totalLimited = createArtifactStore({
      rootDir,
      quotas: { ...DEFAULT_QUOTAS, job: 1, markdown: 100 },
      fsHooks: { beforeRename: () => { renameAttempts += 1; } },
    });
    await expect(totalLimited.writeArtifact(jobId, "slides-content.md", "x")).rejects.toThrow(/quota|limit/i);
    expect(renameAttempts).toBe(attemptsAfterCreate);
  });

  it("supports atomic JSON, optional reads, complete event lines, and exclusive ordering", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const store = createArtifactStore({ rootDir });
    await store.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });
    await store.writeJson(jobId, "working/manifest.json", { slides: [1] });
    expect(await store.readJson(jobId, "working/manifest.json")).toEqual({ slides: [1] });
    expect(await store.readArtifact(jobId, "design-brief.md", { optional: true })).toBeUndefined();
    await expect(store.appendLine(jobId, "slides-content.md", "{}\n")).rejects.toThrow(/events\.ndjson/i);
    await expect(store.appendLine(jobId, "events.ndjson", "{}")).rejects.toThrow(/complete|line/i);
    await expect(store.appendLine(jobId, "events.ndjson", "{}\n{}\n")).rejects.toThrow(/complete|line/i);
    await store.appendLine(jobId, "events.ndjson", "{}\n");
    expect(await store.readArtifact(jobId, "events.ndjson")).toBe("{}\n");

    const order = [];
    await Promise.all([
      store.runExclusive(jobId, async () => { order.push(1); await new Promise((resolve) => setTimeout(resolve, 10)); order.push(2); }),
      store.runExclusive(jobId, async () => { order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("validates uploaded image data and persists server-owned provenance", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const store = createArtifactStore({ rootDir });
    await store.createJob({ jobId, title: "测试", input: { source: {}, options: {} }, sourceBlocks: [] });

    await expect(store.persistUploadedAssets(jobId, [{
      name: "wrong.png", dataUrl: `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`, summary: "bad",
    }])).rejects.toThrow(/signature/i);
    await expect(store.persistUploadedAssets(jobId, [{
      name: "space.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=\n", summary: "bad",
    }])).rejects.toThrow(/data URL|normalized/i);

    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    const [asset] = await store.persistUploadedAssets(jobId, [{
      name: "../../portrait.png", dataUrl: `data:image/png;base64,${png.toString("base64")}`, summary: "source portrait",
    }]);
    expect(asset).toMatchObject({ kind: "image", mimeType: "image/png", byteLength: png.length, originalName: "../../portrait.png" });
    expect(asset.id).toMatch(/^asset-[a-f0-9]+$/);
    expect(asset.filename).toBe(`${asset.id}.png`);
    expect(asset.sha256).toBe("1b56b50ac4e976f488f128cabdcdffb2fc9331d6974bb9968131a415d14ade24");
    expect(await readFile(path.join(rootDir, jobId, "assets", asset.filename))).toEqual(png);
    await expect(access(path.join(rootDir, "portrait.png"))).rejects.toThrow();
    expect(await store.readJson(jobId, "job-input.json")).toMatchObject({ uploadedAssets: [asset] });

    const listed = await store.listArtifacts(jobId);
    expect(listed).toContainEqual({
      id: asset.id, filename: asset.filename, kind: "image", stage: "queued", previewable: true, downloadable: true,
    });
    expect(JSON.stringify(listed)).not.toContain("../../portrait.png");
  });

  it("lists only valid nonterminal job directories as recoverable", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "deck-store-"));
    const store = createArtifactStore({ rootDir });
    const otherJobId = "job-00000000-0000-4000-8000-000000000002";
    await store.createJob({ jobId, title: "active", input: { source: {}, options: {} }, sourceBlocks: [] });
    await store.createJob({ jobId: otherJobId, title: "done", input: { source: {}, options: {} }, sourceBlocks: [] });
    await store.updateJob(otherJobId, { status: "ready" });
    await mkdir(path.join(rootDir, "not-a-job"));
    const outside = await mkdtemp(path.join(tmpdir(), "outside-job-"));
    await symlink(outside, path.join(rootDir, "job-00000000-0000-4000-8000-000000000003"));

    expect((await store.listRecoverableJobs()).map((job) => job.id)).toEqual([jobId]);
  });
});
