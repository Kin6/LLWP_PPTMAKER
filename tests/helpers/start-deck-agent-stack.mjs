import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import {
  createFixtureJobRequest,
  seedPublishedRuntimeJob,
} from "./seed-runtime-job.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_LOG_BYTES = 24_000;
const START_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 3_000;
const TEST_API_KEY = "test-key";

async function reserveLoopbackPorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      servers.push(server);
      server.unref();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unable to allocate a loopback port");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function captureChildLogs(child, label) {
  let value = "";
  const append = (chunk) => {
    value = `${value}${String(chunk)}`.slice(-MAX_LOG_BYTES);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => {
    const sanitized = value
      .replaceAll(TEST_API_KEY, "[redacted]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
      .replace(/(?:api[_-]?key|authorization)[=:]\s*[^\s,]+/gi, "[redacted]");
    return sanitized ? `${label}:\n${sanitized}` : `${label}: no captured output`;
  };
}

function childRunning(child) {
  return Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
}

function signalProcessTree(child, signal) {
  if (!childRunning(child)) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try { child.kill(signal); } catch { /* Process already exited. */ }
    }
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (!childRunning(child)) return true;
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(!childRunning(child)), timeoutMs);
  });
}

async function terminateChild(child) {
  if (!childRunning(child)) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForChildExit(child, STOP_TIMEOUT_MS)) return;
  signalProcessTree(child, "SIGKILL");
  await waitForChildExit(child, STOP_TIMEOUT_MS);
}

async function waitForHttp(url, child, readLogs) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = "endpoint did not respond";
  while (Date.now() < deadline) {
    if (!childRunning(child)) {
      throw new Error(`Test service exited during startup.\n${readLogs()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}\n${readLogs()}`);
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(`${label} failed (HTTP ${response.status}): ${String(body?.error || "unknown error").slice(0, 1_000)}`);
  }
  return body;
}

export async function startDeckAgentStack() {
  const [mockPort, appPort] = await reserveLoopbackPorts(2);
  const jobRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deck-agent-e2e-"));
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const mockBaseUrl = `http://127.0.0.1:${mockPort}/v1`;
  const children = [];
  const readers = [];
  let stopping;
  let signalForwarding = false;

  const stop = async () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (signalForwarding) {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        signalForwarding = false;
      }
      await Promise.all(children.map(terminateChild));
      await fs.rm(jobRoot, { recursive: true, force: true });
    })();
    return stopping;
  };
  const forwardSignal = (signal) => {
    void stop().finally(() => {
      try { process.kill(process.pid, signal); } catch { process.exitCode = 1; }
    });
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  const registerSignalForwarding = () => {
    if (signalForwarding) return;
    signalForwarding = true;
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  };

  try {
    const mock = spawn(process.execPath, ["scripts/mock-openai.mjs"], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        MOCK_PORT: String(mockPort),
        MOCK_DISABLE_IMAGE_FAILURES: "0",
        MOCK_IMAGE_ALWAYS_FAIL: "0",
        MOCK_IMAGE_FAILURE_MODE: "",
        MOCK_STREAM_DELAY_MS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(mock);
    readers.push(captureChildLogs(mock, "mock gateway"));
    registerSignalForwarding();
    await waitForHttp(`${mockBaseUrl}/models`, mock, readers[0]);

    const app = spawn(process.execPath, ["server/index.mjs", "--port", String(appPort)], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(appPort),
        DECK_JOB_ROOT: jobRoot,
        DECK_PARENT_ORIGIN: appOrigin,
        OPENAI_API_KEY: TEST_API_KEY,
        IMAGE_API_KEY: TEST_API_KEY,
        OPENAI_API_BASE: mockBaseUrl,
        OPENAI_API_FALLBACK_BASE: "",
        TEXT_API_PROVIDER: "openai",
        TEXT_API_BASE_URL: mockBaseUrl,
        TEXT_API_FALLBACK_BASE_URL: "",
        TEXT_MODEL: "mock-vision",
        IMAGE_API_PROVIDER: "openai",
        IMAGE_API_BASE_URL: mockBaseUrl,
        IMAGE_API_FALLBACK_BASE_URL: "",
        IMAGE_MODEL: "mock-image",
        IMAGE_API_TIMEOUT_MS: "240000",
        IMAGE_API_MAX_RETRIES: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(app);
    readers.push(captureChildLogs(app, "deck app"));
    await waitForHttp(`${appOrigin}/api/health`, app, readers[1]);
  } catch (error) {
    const logs = readers.map((reader) => reader()).join("\n");
    await stop();
    throw new Error(`${String(error?.message || error)}${logs ? `\n${logs}` : ""}`);
  }

  const request = async (pathname, init = {}) => responseJson(await fetch(`${appOrigin}${pathname}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  }), `${init.method || "GET"} ${pathname}`);

  return Object.freeze({
    appOrigin,
    mockBaseUrl,
    jobRoot,
    async createFixtureJob(name, options = {}) {
      const body = await request("/api/html-deck/jobs", {
        method: "POST",
        body: JSON.stringify(await createFixtureJobRequest(name, options)),
      });
      return body.job;
    },
    async seedPublishedJob(name, state = {}) {
      const jobId = `job-${crypto.randomUUID()}`;
      const status = typeof state === "string" ? state : state.status || "ready";
      return seedPublishedRuntimeJob({
        rootDir: jobRoot,
        jobId,
        appOrigin,
        fixtureName: name,
        status,
      });
    },
    async getJob(jobId) {
      return (await request(`/api/html-deck/jobs/${encodeURIComponent(jobId)}`)).job;
    },
    async getMockDiagnostics() {
      return responseJson(await fetch(`${mockBaseUrl}/__diagnostics`, {
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/json" },
      }), "GET mock diagnostics");
    },
    async waitForJob(jobId, statuses, { timeoutMs = 120_000 } = {}) {
      const accepted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
      const deadline = Date.now() + timeoutMs;
      let latest;
      while (Date.now() < deadline) {
        latest = await this.getJob(jobId);
        if (accepted.has(latest.status)) return latest;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`Timed out waiting for ${jobId} to reach ${[...accepted].join(", ")}; last status was ${latest?.status || "unknown"}`);
    },
    async readEvents(jobId) {
      const source = await fs.readFile(path.join(jobRoot, jobId, "events.ndjson"), "utf8");
      return source.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    stop,
  });
}

export const test = base.extend({
  stack: [async ({}, use) => {
    const stack = await startDeckAgentStack();
    try {
      await use(stack);
    } finally {
      await stack.stop();
    }
  }, { scope: "worker" }],
});

export { expect };
