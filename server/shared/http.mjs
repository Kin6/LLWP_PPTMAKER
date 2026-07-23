import { fetch as undiciFetch, ProxyAgent } from "undici";
import { HttpError, JobCancelledError } from "./errors.mjs";

export function createHttpClient({ proxyUrl = "" } = {}) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  return {
    async fetch(url, options = {}, { timeoutMs = 60_000, signal } = {}) {
      if (signal?.aborted) throw new JobCancelledError("Job request was cancelled");
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
      let requestDispatcher = dispatcher;
      try {
        const host = new URL(url).hostname;
        if (["127.0.0.1", "localhost", "::1"].includes(host)) requestDispatcher = undefined;
        return await undiciFetch(url, { ...options, signal: combined, dispatcher: requestDispatcher });
      } catch (error) {
        if (signal?.aborted) throw new JobCancelledError("Job request was cancelled", { cause: error });
        if (timeoutController.signal.aborted) throw new HttpError(504, "Upstream request timed out", { cause: error });
        throw new HttpError(502, `Unable to reach upstream service: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
