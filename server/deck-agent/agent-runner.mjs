const MAX_HISTORY_TEXT_CHARS = 1_000;
const MAX_MODEL_CONTENT_CHARS = 120_000;
const REDACTED = "[redacted]";

const AGENT_TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "final", "toolCalls"],
  properties: {
    message: { type: "string" },
    final: { type: "boolean" },
    toolCalls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "argumentsJson"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          argumentsJson: { type: "string" },
        },
      },
    },
  },
};

function bounded(text, maxChars = MAX_HISTORY_TEXT_CHARS) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function sanitizeHistoryText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const sanitized = value
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, REDACTED)
    .replace(
      /\b(?:api[_ -]?key|authorization|bearer|(?:access[_ -]?)?token|provider(?:[_ -]?url)?|(?:system[_ -]?)?prompt|source[_ -]?document|artifact[_ -]?body)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^;\n,]+)/gi,
      REDACTED,
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/(^|[\s("'=;])\/(?!\/)[^\s,;)"']+/g, `$1${REDACTED}`)
    .replace(/\b[a-z]:\\(?:[^\\\s]+\\)*[^,\s;)"']*/gi, REDACTED);
  return bounded(sanitized);
}

function historyTurn(value) {
  return {
    message: sanitizeHistoryText(value.message),
    final: value.final,
    toolCalls: value.toolCalls.map((call) => ({
      id: sanitizeHistoryText(call.id),
      name: sanitizeHistoryText(call.name),
      argumentsJson: REDACTED,
    })),
  };
}

function toolSummary(result) {
  return sanitizeHistoryText(result?.summary, "Tool completed");
}

function toolModelContent(result) {
  if (!Object.prototype.hasOwnProperty.call(result || {}, "modelContent")) return undefined;
  if (typeof result.modelContent !== "string") throw new TypeError("Tool modelContent must be a string");
  return bounded(result.modelContent, MAX_MODEL_CONTENT_CHARS);
}

function budgetError(kind, limit) {
  return new Error(`Stage exceeded ${kind} budget ${limit}`);
}

export function createAgentRunner({ modelClient }) {
  if (!modelClient || typeof modelClient.completeStructured !== "function") {
    throw new TypeError("Agent runner requires a model client");
  }

  return {
    async runStage({
      jobId,
      stage,
      messages,
      allowedTools,
      maxTurns,
      maxUpstreamCalls,
      timeoutMs,
      signal,
      emit,
    }) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const stageSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const history = [...messages];
      const onProgress = (progress) => emit?.({ type: "progress", progress });
      let upstreamCalls = 0;

      for (let turn = 0; turn < maxTurns; turn += 1) {
        stageSignal.throwIfAborted();
        if (upstreamCalls >= maxUpstreamCalls) {
          throw budgetError("upstream-call", maxUpstreamCalls);
        }

        const response = await modelClient.completeStructured({
          messages: history,
          schema: AGENT_TURN_SCHEMA,
          schemaName: "agent_turn",
          timeoutMs,
          signal: stageSignal,
          onProgress,
        });
        stageSignal.throwIfAborted();
        if (!Number.isSafeInteger(response.apiCalls) || response.apiCalls < 1) {
          throw new Error("Model response reported an invalid upstream-call count");
        }
        upstreamCalls += response.apiCalls;
        if (upstreamCalls > maxUpstreamCalls) {
          throw budgetError("upstream-call", maxUpstreamCalls);
        }

        const toolResults = [];
        for (const call of response.value.toolCalls) {
          stageSignal.throwIfAborted();
          const tool = Object.prototype.hasOwnProperty.call(allowedTools, call.name)
            ? allowedTools[call.name]
            : undefined;
          if (!tool) throw new Error(`Tool ${call.name} is not allowed in this stage`);

          let input;
          try {
            input = tool.schema.parse(JSON.parse(call.argumentsJson));
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid arguments for ${call.name}: ${detail}`);
          }

          const result = await tool.execute(input, {
            jobId,
            stage,
            signal: stageSignal,
            emit,
            onProgress,
          });
          stageSignal.throwIfAborted();
          const modelContent = toolModelContent(result);
          toolResults.push({
            id: sanitizeHistoryText(call.id),
            name: sanitizeHistoryText(call.name),
            summary: toolSummary(result),
            ...(modelContent === undefined ? {} : { modelContent }),
          });
        }

        if (response.value.final) {
          return { message: response.value.message, toolResults, upstreamCalls };
        }

        history.push(
          { role: "assistant", content: JSON.stringify(historyTurn(response.value)) },
          { role: "user", content: JSON.stringify({ toolResults }) },
        );
      }

      throw budgetError("turn", maxTurns);
    },
  };
}
