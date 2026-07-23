import { z } from "zod";
import {
  deckArtifactIdSchema,
  deckEditRequestSchema,
  deckJobEventSchema,
  deckJobIdSchema,
  deckJobSnapshotSchema,
  type DeckEditRequest,
  type DeckJobEvent,
  type DeckJobSnapshot,
} from "./types";

const API_ROOT = "/api/html-deck/jobs";
const heartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  createdAt: z.string().datetime().optional(),
}).strict();
const jobResponseSchema = z.object({
  ok: z.literal(true),
  job: deckJobSnapshotSchema,
}).strict();
const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
}).strict();
const undoRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
}).strict();

export interface ArtifactUrlOptions {
  download?: boolean;
}

export interface FetchArtifactOptions extends ArtifactUrlOptions {
  signal?: AbortSignal;
}

function jobPath(jobId: string): string {
  return `${API_ROOT}/${encodeURIComponent(deckJobIdSchema.parse(jobId))}`;
}

function invalidResponse(detail: string): Error {
  return new Error(`Invalid deck API response: ${detail}`);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse("expected JSON");
  }
}

async function parseJobResponse(response: Response): Promise<DeckJobSnapshot> {
  const value = await responseJson(response);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(value);
    if (!error.success) throw invalidResponse(error.error.message);
    throw new Error(error.data.error);
  }

  const parsed = jobResponseSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse(parsed.error.message);
  return parsed.data.job;
}

async function requestJob(
  url: string,
  init: RequestInit,
): Promise<DeckJobSnapshot> {
  return parseJobResponse(await fetch(url, init));
}

function jsonRequest(method: "POST", body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  };
}

export async function createDeckJob(
  request: unknown,
  signal?: AbortSignal,
): Promise<DeckJobSnapshot> {
  return requestJob(API_ROOT, jsonRequest("POST", request, signal));
}

export async function getDeckJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<DeckJobSnapshot> {
  return requestJob(jobPath(jobId), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
}

export async function* decodeDeckEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<DeckJobEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line: string): DeckJobEvent | null => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Invalid deck event: malformed JSON");
    }
    if (heartbeatSchema.safeParse(value).success) return null;
    const parsed = deckJobEventSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid deck event: ${parsed.error.message}`);
    return parsed.data;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseLine(line);
        if (event) yield event;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      throw new Error("Deck event stream ended with an incomplete record");
    }
  } finally {
    reader.releaseLock();
  }
}

export async function streamDeckJobEvents(
  jobId: string,
  after: number,
  signal: AbortSignal,
  onEvent: (event: DeckJobEvent) => void,
): Promise<void> {
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new TypeError("Event sequence must be a nonnegative integer");
  }
  const response = await fetch(`${jobPath(jobId)}/events?after=${after}`, {
    method: "GET",
    headers: { Accept: "application/x-ndjson" },
    signal,
  });
  if (!response.ok) {
    const value = await responseJson(response);
    const parsed = errorResponseSchema.safeParse(value);
    if (!parsed.success) throw invalidResponse(parsed.error.message);
    throw new Error(parsed.data.error);
  }
  if (!response.body) throw invalidResponse("event response has no body");
  for await (const event of decodeDeckEventStream(response.body)) onEvent(event);
}

export async function cancelDeckJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<DeckJobSnapshot> {
  return requestJob(`${jobPath(jobId)}/cancel`, jsonRequest("POST", {}, signal));
}

export async function retryDeckJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<DeckJobSnapshot> {
  return requestJob(`${jobPath(jobId)}/retry`, jsonRequest("POST", {}, signal));
}

export async function sendDeckMessage(
  jobId: string,
  request: DeckEditRequest,
  signal?: AbortSignal,
): Promise<DeckJobSnapshot> {
  const body = deckEditRequestSchema.parse(request);
  return requestJob(`${jobPath(jobId)}/messages`, jsonRequest("POST", body, signal));
}

export async function undoDeckRevision(
  jobId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<DeckJobSnapshot> {
  const body = undoRequestSchema.parse({ expectedRevision });
  return requestJob(`${jobPath(jobId)}/undo`, jsonRequest("POST", body, signal));
}

export function artifactUrl(
  jobId: string,
  artifactId: string,
  options: ArtifactUrlOptions | boolean = {},
): string {
  const validArtifactId = deckArtifactIdSchema.parse(artifactId);
  const download = typeof options === "boolean" ? options : options.download === true;
  return `${jobPath(jobId)}/artifacts/${encodeURIComponent(validArtifactId)}${download ? "?download=1" : ""}`;
}

export async function fetchArtifact(
  jobId: string,
  artifactId: string,
  options: FetchArtifactOptions | AbortSignal = {},
): Promise<Response> {
  const normalized = options instanceof AbortSignal ? { signal: options } : options;
  const response = await fetch(artifactUrl(jobId, artifactId, normalized), {
    method: "GET",
    signal: normalized.signal,
  });
  if (response.ok) return response;

  const value = await responseJson(response);
  const parsed = errorResponseSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse(parsed.error.message);
  throw new Error(parsed.data.error);
}
