import { deckEventSchema, TERMINAL_JOB_STATUSES } from "./contracts.mjs";

const JOB_ID = /^job-[0-9a-f-]{36}$/;
const HEARTBEAT_INTERVAL_MS = 15_000;

function validateAfter(after) {
  if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("Event sequence must be a nonnegative integer");
  return after;
}

function parsePersistedEvent(line, lineNumber, jobId) {
  let input;
  try {
    input = JSON.parse(line);
  } catch (error) {
    throw new Error(`Corrupt persisted event at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let event;
  try {
    event = deckEventSchema.parse(input);
  } catch (error) {
    throw new Error(`Corrupt persisted event at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (event.jobId !== jobId) throw new Error(`Corrupt persisted event at line ${lineNumber}: job id mismatch`);
  return event;
}

function assertMonotonic(events) {
  let previous = 0;
  for (const event of events) {
    if (event.seq <= previous) throw new Error(`Corrupt persisted event sequence at seq ${event.seq}`);
    previous = event.seq;
  }
}

function terminalJobEvent(event) {
  return event.type === "job" && TERMINAL_JOB_STATUSES.includes(event.stage);
}

function createNdjsonPipe({ readAfter, subscribe, now }) {
  return async function pipeNdjson(req, res, { jobId, after = 0 } = {}) {
    validateAfter(after);
    if (!req?.once || !res?.write) throw new TypeError("NDJSON streaming requires request and response streams");

    res.setHeader?.("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader?.("Cache-Control", "no-cache, no-transform");
    res.setHeader?.("Connection", "keep-alive");
    res.flushHeaders?.();

    let closed = false;
    let replaying = true;
    let lastSeq = after;
    const liveQueue = [];
    let unsubscribe = () => {};
    let heartbeat;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });

    function removeRequestListener() {
      if (typeof req.off === "function") req.off("close", onRequestClose);
      else if (typeof req.removeListener === "function") req.removeListener("close", onRequestClose);
    }

    function close({ endResponse }) {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      removeRequestListener();
      if (endResponse && !res.writableEnded && !res.destroyed) res.end?.();
      resolveCompletion();
    }

    function onRequestClose() {
      close({ endResponse: false });
    }

    function writeObject(value) {
      if (!closed) res.write(`${JSON.stringify(value)}\n`);
    }

    function writeEvent(event) {
      if (closed || event.seq <= lastSeq) return;
      lastSeq = event.seq;
      writeObject(event);
      if (terminalJobEvent(event)) close({ endResponse: true });
    }

    req.once("close", onRequestClose);
    unsubscribe = subscribe(jobId, (event) => {
      if (closed || event.seq <= lastSeq) return;
      if (replaying) liveQueue.push(event);
      else writeEvent(event);
    });
    heartbeat = setInterval(() => writeObject({ type: "heartbeat", createdAt: now() }), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    try {
      const persisted = await readAfter(jobId, after);
      if (!closed) {
        for (const event of [...persisted].sort((left, right) => left.seq - right.seq)) writeEvent(event);
        replaying = false;
        for (const event of liveQueue.sort((left, right) => left.seq - right.seq)) writeEvent(event);
        liveQueue.length = 0;
      }
    } catch (error) {
      close({ endResponse: true });
      throw error;
    }

    return completion;
  };
}

export function createEventStore({ store, now = () => new Date().toISOString() }) {
  if (!store || typeof store.runExclusive !== "function") throw new TypeError("Event store requires an artifact store");
  if (typeof now !== "function") throw new TypeError("Event store now must be a function");
  const listeners = new Map();

  async function readPersistedUnlocked(jobId) {
    const raw = await store.readArtifact(jobId, "events.ndjson", { optional: true }) || "";
    const hasPartialTail = raw.length > 0 && !raw.endsWith("\n");
    const lines = raw.split("\n");
    if (raw.endsWith("\n")) lines.pop();
    let tail;
    if (hasPartialTail) tail = lines.pop();

    const events = [];
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      events.push(parsePersistedEvent(line, index + 1, jobId));
    }
    if (tail) {
      try {
        events.push(parsePersistedEvent(tail, lines.length + 1, jobId));
      } catch {
        // An unterminated final record may be truncated at any field boundary.
      }
    }
    assertMonotonic(events);

    if (hasPartialTail) {
      const repaired = events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
      await store.writeArtifact(jobId, "events.ndjson", repaired, { alreadyLocked: true });
    }
    const lastSeq = events.at(-1)?.seq || 0;
    const job = await store.readJob(jobId, { alreadyLocked: true });
    if (job.lastSeq !== lastSeq) await store.updateJob(jobId, { lastSeq }, { alreadyLocked: true });
    return events;
  }

  async function append(jobId, input) {
    return store.runExclusive(jobId, async () => {
      const persisted = await readPersistedUnlocked(jobId);
      const event = deckEventSchema.parse({ ...input, seq: (persisted.at(-1)?.seq || 0) + 1, jobId, createdAt: now() });
      await store.appendLine(jobId, "events.ndjson", `${JSON.stringify(event)}\n`, { alreadyLocked: true });
      await store.updateJob(jobId, { lastSeq: event.seq }, { alreadyLocked: true });
      for (const listener of listeners.get(jobId) || []) {
        try {
          listener(event);
        } catch {
          // A disconnected consumer cannot roll back an already persisted event.
        }
      }
      return event;
    });
  }

  async function readAfter(jobId, after) {
    validateAfter(after);
    return store.runExclusive(jobId, async () => {
      return (await readPersistedUnlocked(jobId)).filter((event) => event.seq > after);
    });
  }

  function subscribe(jobId, listener) {
    if (!JOB_ID.test(jobId) || typeof listener !== "function") throw new TypeError("Invalid event subscription");
    const set = listeners.get(jobId) || new Set();
    set.add(listener);
    listeners.set(jobId, set);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(listener);
      if (!set.size) listeners.delete(jobId);
    };
  }

  return { append, readAfter, subscribe, pipeNdjson: createNdjsonPipe({ readAfter, subscribe, now }) };
}
