import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "../../../server/config.mjs";
import { createModelClient } from "../../../server/model/client.mjs";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

describe("Codex CLI model backend", () => {
  it("defaults a keyless remote text provider to Codex CLI", () => {
    const config = loadServerConfig({
      env: { TEXT_API_BASE_URL: "https://models.example.test/v1" },
      argv: [],
      rootDir: "/workspace",
    });

    expect(config.text.backend).toBe("codex-cli");
  });

  it("honors an explicit HTTP backend and rejects unknown backends", () => {
    const config = loadServerConfig({
      env: { TEXT_MODEL_BACKEND: "http" },
      argv: [],
      rootDir: "/workspace",
    });

    expect(config.text.backend).toBe("http");
    expect(() => loadServerConfig({
      env: { TEXT_MODEL_BACKEND: "shell-script" },
      argv: [],
      rootDir: "/workspace",
    })).toThrow("TEXT_MODEL_BACKEND must be http or codex-cli");
  });

  it("sends the prompt over stdin, keeps source material out of argv, and cleans temporary files", async () => {
    const harness = createCliHarness({ output: JSON.stringify({ ok: true }) });
    const privateMaterial = "PRIVATE_SOURCE_MATERIAL_7f59c";
    const client = createCliClient(harness);

    const result = await client.completeStructured({
      messages: [
        { role: "system", content: "Return a boolean result." },
        { role: "user", content: privateMaterial },
      ],
      schema: RESULT_SCHEMA,
      schemaName: "result",
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      value: { ok: true },
      apiCalls: 1,
      provider: "codex-cli",
      model: "codex-test-model",
    });
    expect(harness.command).toBe("test-codex");
    expect(harness.options).toMatchObject({ shell: false, stdio: ["pipe", "pipe", "pipe"] });
    expect(harness.args.at(-1)).toBe("-");
    expect(harness.args.join(" ")).not.toContain(privateMaterial);
    expect(harness.stdinPrompt).toContain(privateMaterial);
    expect(harness.stdinPrompt).toContain("ROLE_LABELLED_CONVERSATION_JSON");

    const schemaPath = argumentValue(harness.args, "--output-schema");
    const outputPath = argumentValue(harness.args, "--output-last-message");
    expect(path.dirname(schemaPath)).toBe(harness.tempDir);
    expect(path.dirname(outputPath)).toBe(harness.tempDir);
    expect(harness.fileSystem.chmod).toHaveBeenCalledWith(harness.tempDir, 0o700);
    expect(harness.schemaWrite).toMatchObject({
      filePath: schemaPath,
      text: JSON.stringify(RESULT_SCHEMA),
      options: { encoding: "utf8", mode: 0o600 },
    });
    expect(harness.fileSystem.rm).toHaveBeenCalledWith(
      harness.tempDir,
      { recursive: true, force: true },
    );
    expect(harness.files.size).toBe(0);
  });

  it("maps ordered image attachments to their slide names in the prompt", async () => {
    const harness = createCliHarness({ output: JSON.stringify({ ok: true }) });
    const client = createCliClient(harness);

    await client.completeStructured({
      messages: [{ role: "user", content: "Review the supplied calibration slide." }],
      schema: RESULT_SCHEMA,
      schemaName: "result",
      images: [{
        name: "slide-06.png",
        summary: "1920x1080 calibration screenshot for slide-06",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      }],
      timeoutMs: 1_000,
    });

    expect(harness.stdinPrompt).toContain("attachments are passed to Codex in this exact order");
    expect(harness.stdinPrompt).toContain("1. slide-06.png - 1920x1080 calibration screenshot for slide-06");
    const imageIndex = harness.args.indexOf("--image");
    expect(imageIndex).toBeGreaterThan(-1);
    expect(harness.args[imageIndex + 1]).toBe(`${harness.tempDir}/attachment-1.png`);
  });

  it("does not expose stderr tokens or paths when Codex exits non-zero", async () => {
    const secret = "sk-secret-token-4891";
    const privatePath = "/Users/example/private/source-notes.md";
    const harness = createCliHarness({
      exitCode: 7,
      stderr: `fatal: bearer ${secret} while reading ${privatePath}`,
    });
    const client = createCliClient(harness);

    let failure;
    try {
      await client.completeStructured({
        messages: [{ role: "user", content: "Make a deck." }],
        schema: RESULT_SCHEMA,
        schemaName: "result",
        timeoutMs: 1_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: "HttpError", status: 502 });
    expect(failure.message).toContain("Codex CLI exited before returning a result");
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain(privatePath);
    expect(harness.fileSystem.rm).toHaveBeenCalledOnce();
  });

  it("terminates the Codex process when the request is aborted", async () => {
    const harness = createCliHarness({ holdOpen: true });
    const client = createCliClient(harness);
    const controller = new AbortController();
    const pending = client.completeStructured({
      messages: [{ role: "user", content: "Make a deck." }],
      schema: RESULT_SCHEMA,
      schemaName: "result",
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    await harness.spawned;
    controller.abort("test cancellation");

    await expect(pending).rejects.toMatchObject({ name: "JobCancelledError", status: 499 });
    expect(harness.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.fileSystem.rm).toHaveBeenCalledOnce();
  });
});

function createCliClient(harness) {
  return createModelClient({
    config: {
      text: {
        backend: "codex-cli",
        cliCommand: "test-codex",
        cliModel: "codex-test-model",
        cliReasoningEffort: "medium",
      },
    },
    spawnProcess: harness.spawnProcess,
    fileSystem: harness.fileSystem,
  });
}

function createCliHarness({ output = JSON.stringify({ ok: true }), stderr = "", exitCode = 0, holdOpen = false } = {}) {
  const tempDir = "/virtual/tmp/deck-codex-test";
  const files = new Map();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = vi.fn((signal) => {
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });

  let command;
  let args = [];
  let options;
  let stdinPrompt = "";
  let schemaWrite;
  let resolveSpawned;
  const spawned = new Promise((resolve) => { resolveSpawned = resolve; });
  const fileSystem = {
    mkdtemp: vi.fn(async () => tempDir),
    chmod: vi.fn(async () => {}),
    writeFile: vi.fn(async (filePath, data, writeOptions) => {
      const value = Buffer.isBuffer(data) ? Buffer.from(data) : String(data);
      files.set(filePath, value);
      if (path.basename(filePath) === "output-schema.json") {
        schemaWrite = { filePath, text: String(data), options: writeOptions };
      }
    }),
    stat: vi.fn(async (filePath) => {
      const value = files.get(filePath);
      if (value == null) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return { size: Buffer.byteLength(value) };
    }),
    readFile: vi.fn(async (filePath) => String(files.get(filePath) ?? "")),
    rm: vi.fn(async (directory) => {
      for (const filePath of files.keys()) {
        if (filePath.startsWith(`${directory}${path.sep}`)) files.delete(filePath);
      }
    }),
  };

  child.stdin.end = vi.fn((prompt) => {
    stdinPrompt = String(prompt);
    const outputPath = argumentValue(args, "--output-last-message");
    files.set(outputPath, output);
    if (holdOpen) return;
    queueMicrotask(() => {
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", exitCode, null);
    });
  });

  const spawnProcess = vi.fn((nextCommand, nextArgs, nextOptions) => {
    command = nextCommand;
    args = [...nextArgs];
    options = nextOptions;
    resolveSpawned();
    return child;
  });

  return {
    tempDir,
    files,
    child,
    spawned,
    spawnProcess,
    fileSystem,
    get command() { return command; },
    get args() { return args; },
    get options() { return options; },
    get stdinPrompt() { return stdinPrompt; },
    get schemaWrite() { return schemaWrite; },
  };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name} argument`);
  return args[index + 1];
}
