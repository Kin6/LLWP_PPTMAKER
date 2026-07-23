import { MAX_UPSTREAM_CALLS_PER_MODEL_TURN } from "./upstream-budget.mjs";

const MAX_HISTORY_TEXT_CHARS = 1_000;
const MAX_MODEL_CONTENT_CHARS = 120_000;
const REDACTED = "[redacted]";
const STAGE_TITLES = Object.freeze({
  outline: "整理幻灯片内容大纲并写入 Markdown",
  design: "建立单一设计方向",
  calibrating: "校准代表页面",
  building: "生成 HTML 幻灯片页面",
  "generating-assets": "处理页面素材",
  verifying: "检查排版、内容溢出与视觉一致性",
  repairing: "修复未通过检查的页面",
});
const STAGE_OUTPUTS = Object.freeze({
  outline: "内容大纲",
  design: "设计方向",
  calibrating: "校准页面",
  building: "幻灯片页面",
  "generating-assets": "页面素材",
  verifying: "检查结果",
  repairing: "修复方案",
});
const TOOL_PROGRESS_MESSAGES = Object.freeze({
  write_outline: "正在写入 Markdown 大纲",
  write_theme: "正在写入设计方向与主题",
  write_slide: "正在写入幻灯片页面",
});

function agentTurnSchema(allowedTools, requiredToolName) {
  const allowedToolNames = Object.keys(allowedTools || {});
  const name = allowedToolNames.length
    ? { type: "string", enum: requiredToolName ? [requiredToolName] : allowedToolNames }
    : { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "final", "toolCalls"],
    properties: {
      message: { type: "string" },
      final: { type: "boolean" },
      toolCalls: {
        type: "array",
        ...(requiredToolName ? { minItems: 1, maxItems: 1 } : {}),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "argumentsJson"],
          properties: {
            id: { type: "string" },
            name,
            argumentsJson: { type: "string" },
          },
        },
      },
    },
  };
}

function stageProgressEvent(stage, progress) {
  if (!progress || typeof progress !== "object") return undefined;
  let message;
  let completed = 0;
  let total = 1;
  if (progress.type === "request") {
    if (progress.message === "Compatibility retry sent") message = "模型服务正在进行兼容重试";
    else if (progress.message === "JSON repair request sent") message = "正在修复模型返回格式";
    else message = `正在请求模型生成${STAGE_OUTPUTS[stage] || "结果"}`;
  } else if (progress.type === "tool") {
    message = TOOL_PROGRESS_MESSAGES[progress.name] || "正在写入生成结果";
  } else if (Number.isSafeInteger(progress.completed) && Number.isSafeInteger(progress.total)
    && progress.completed >= 0 && progress.total > 0) {
    completed = progress.completed;
    total = progress.total;
    message = typeof progress.message === "string" ? progress.message : undefined;
  } else {
    return undefined;
  }
  return {
    stage,
    type: "progress",
    status: "running",
    title: STAGE_TITLES[stage] || "正在生成",
    ...(message ? { message } : {}),
    progress: { completed, total },
  };
}

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

function createStageProgress(stage, emit) {
  const pending = new Set();
  let deliveryError;
  const onProgress = (progress) => {
    const event = stageProgressEvent(stage, progress);
    if (!event || typeof emit !== "function") return;
    const delivery = Promise.resolve()
      .then(() => emit(event))
      .catch((error) => { deliveryError ||= error; });
    pending.add(delivery);
    delivery.then(() => pending.delete(delivery));
  };
  const flush = async () => {
    if (pending.size) await Promise.all([...pending]);
    if (deliveryError) throw deliveryError;
  };
  return { onProgress, flush };
}

function validateUpstreamCalls(response, maxUpstreamCalls) {
  if (!Number.isSafeInteger(response?.apiCalls) || response.apiCalls < 1) {
    throw new Error("Model response reported an invalid upstream-call count");
  }
  if (response.apiCalls > MAX_UPSTREAM_CALLS_PER_MODEL_TURN) {
    throw budgetError("per-turn upstream-call", MAX_UPSTREAM_CALLS_PER_MODEL_TURN);
  }
  if (response.apiCalls > maxUpstreamCalls) {
    throw budgetError("upstream-call", maxUpstreamCalls);
  }
  return response.apiCalls;
}

export function createAgentRunner({ modelClient }) {
  if (!modelClient || typeof modelClient.completeStructured !== "function") {
    throw new TypeError("Agent runner requires a model client");
  }

  return {
    async completeStructuredStage({
      stage,
      messages,
      schema,
      schemaName,
      maxUpstreamCalls,
      timeoutMs,
      signal,
      emit,
    }) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const stageSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const progress = createStageProgress(stage, emit);
      stageSignal.throwIfAborted();
      const response = await modelClient.completeStructured({
        messages,
        schema,
        schemaName,
        timeoutMs,
        signal: stageSignal,
        onProgress: progress.onProgress,
      });
      await progress.flush();
      stageSignal.throwIfAborted();
      const upstreamCalls = validateUpstreamCalls(response, maxUpstreamCalls);
      return {
        value: response.value,
        upstreamCalls,
        ...(response.provider === undefined ? {} : { provider: response.provider }),
        ...(response.model === undefined ? {} : { model: response.model }),
      };
    },

    async runStage({
      jobId,
      stage,
      messages,
      allowedTools,
      requiredToolName,
      maxTurns,
      maxUpstreamCalls,
      timeoutMs,
      signal,
      emit,
    }) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const stageSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      if (requiredToolName !== undefined
        && (typeof requiredToolName !== "string" || !Object.prototype.hasOwnProperty.call(allowedTools, requiredToolName))) {
        throw new TypeError("Required tool must be allowed in this stage");
      }
      const history = [...messages];
      const turnSchema = agentTurnSchema(allowedTools, requiredToolName);
      const progress = createStageProgress(stage, emit);
      let upstreamCalls = 0;

      for (let turn = 0; turn < maxTurns; turn += 1) {
        stageSignal.throwIfAborted();
        if (upstreamCalls >= maxUpstreamCalls) {
          throw budgetError("upstream-call", maxUpstreamCalls);
        }

        const response = await modelClient.completeStructured({
          messages: history,
          schema: turnSchema,
          schemaName: "agent_turn",
          timeoutMs,
          signal: stageSignal,
          onProgress: progress.onProgress,
        });
        await progress.flush();
        stageSignal.throwIfAborted();
        upstreamCalls += validateUpstreamCalls(response, maxUpstreamCalls);
        if (upstreamCalls > maxUpstreamCalls) {
          throw budgetError("upstream-call", maxUpstreamCalls);
        }

        if (requiredToolName && (response.value.toolCalls.length !== 1
          || response.value.toolCalls[0]?.name !== requiredToolName)) {
          throw new Error(`Stage ${stage} requires exactly one ${requiredToolName} tool call`);
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

          progress.onProgress({ type: "tool", name: call.name });
          await progress.flush();
          const result = await tool.execute(input, {
            jobId,
            stage,
            signal: stageSignal,
            emit,
            onProgress: progress.onProgress,
          });
          await progress.flush();
          stageSignal.throwIfAborted();
          const modelContent = toolModelContent(result);
          toolResults.push({
            id: sanitizeHistoryText(call.id),
            name: sanitizeHistoryText(call.name),
            summary: toolSummary(result),
            ...(modelContent === undefined ? {} : { modelContent }),
          });
        }

        if (requiredToolName || response.value.final) {
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
