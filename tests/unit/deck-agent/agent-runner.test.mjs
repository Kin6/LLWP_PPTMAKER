import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentRunner } from "../../../server/deck-agent/agent-runner.mjs";

function agentTurn(overrides = {}) {
  return {
    message: "",
    final: false,
    toolCalls: [],
    ...overrides,
  };
}

function stageOptions(overrides = {}) {
  return {
    jobId: "job-1",
    stage: "outline",
    messages: [],
    allowedTools: {},
    maxTurns: 2,
    maxUpstreamCalls: 4,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function structuredStageOptions(overrides = {}) {
  return {
    stage: "building",
    messages: [{ role: "user", content: "Generate slide-01" }],
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["slides"],
      properties: {
        slides: { type: "array", minItems: 1, maxItems: 1, items: { type: "object" } },
      },
    },
    schemaName: "deck_slide_batch",
    maxUpstreamCalls: 3,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function abortablePending(signal, onSignal) {
  onSignal(signal);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("restricted Agent runner", () => {
  it("completes a direct structured stage with the requested schema and model metadata", async () => {
    const value = { slides: [{ slideId: "slide-01" }] };
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value,
        apiCalls: 1,
        provider: "compatible",
        model: "mock-model",
      }),
    };
    const runner = createAgentRunner({ modelClient });
    const options = structuredStageOptions();

    await expect(runner.completeStructuredStage(options)).resolves.toEqual({
      value,
      upstreamCalls: 1,
      provider: "compatible",
      model: "mock-model",
    });
    expect(modelClient.completeStructured).toHaveBeenCalledWith(expect.objectContaining({
      messages: options.messages,
      schema: options.schema,
      schemaName: "deck_slide_batch",
      timeoutMs: 1_000,
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }));
  });

  it("allows three compatibility calls but rejects them above the stage budget", async () => {
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: { slides: [{ slideId: "slide-01" }] },
        apiCalls: 3,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.completeStructuredStage(structuredStageOptions({
      maxUpstreamCalls: 3,
    }))).resolves.toMatchObject({ upstreamCalls: 3 });
    await expect(runner.completeStructuredStage(structuredStageOptions({
      maxUpstreamCalls: 2,
    }))).rejects.toThrow(/upstream-call budget.*2/i);
  });

  it("publishes direct structured progress under the requested stage", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const modelClient = {
      completeStructured: vi.fn(async ({ onProgress }) => {
        onProgress({ type: "request", message: "Model request sent" });
        onProgress({ type: "request", message: "Compatibility retry sent" });
        onProgress({ type: "request", message: "JSON repair request sent" });
        return { value: { slides: [{ slideId: "slide-01" }] }, apiCalls: 3 };
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await runner.completeStructuredStage(structuredStageOptions({
      stage: "calibrating",
      emit,
    }));

    expect(emit.mock.calls.map(([event]) => event.message)).toEqual([
      "正在请求模型生成校准页面",
      "模型服务正在进行兼容重试",
      "正在修复模型返回格式",
    ]);
    expect(emit.mock.calls.every(([event]) => (
      event.stage === "calibrating"
      && event.type === "progress"
      && event.status === "running"
    ))).toBe(true);
  });

  it("propagates external cancellation into a direct structured model call", async () => {
    const controller = new AbortController();
    let signalModelStarted;
    const modelStarted = new Promise((resolve) => { signalModelStarted = resolve; });
    let modelSignal;
    const modelClient = {
      completeStructured: vi.fn(({ signal }) => abortablePending(signal, (received) => {
        modelSignal = received;
        signalModelStarted();
      })),
    };
    const runner = createAgentRunner({ modelClient });
    const pending = runner.completeStructuredStage(structuredStageOptions({
      signal: controller.signal,
    }));
    await modelStarted;
    controller.abort(new Error("user cancelled direct generation"));

    await expect(pending).rejects.toThrow(/user cancelled direct generation/i);
    expect(modelSignal.aborted).toBe(true);
  });

  it("uses a provider-portable structured turn envelope", async () => {
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({ message: "done", final: true }),
        apiCalls: 1,
        provider: "compatible",
        model: "mock-model",
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions())).resolves.toEqual({
      message: "done",
      toolResults: [],
      upstreamCalls: 1,
    });
    expect(modelClient.completeStructured).toHaveBeenCalledWith(expect.objectContaining({
      schemaName: "agent_turn",
      timeoutMs: 1_000,
      schema: {
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
      },
    }));
  });

  it("rejects a model-requested tool outside the current stage", async () => {
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({
          toolCalls: [{ id: "1", name: "write_slide", argumentsJson: "{}" }],
        }),
        apiCalls: 1,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      allowedTools: {
        write_outline: {
          schema: z.object({ markdown: z.string() }),
          execute: vi.fn(),
        },
      },
      maxTurns: 1,
      maxUpstreamCalls: 1,
    }))).rejects.toThrow(/write_slide.*not allowed/i);
  });

  it("rejects malformed JSON tool arguments before execution", async () => {
    const execute = vi.fn();
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({
          toolCalls: [{ id: "1", name: "write_outline", argumentsJson: "{not-json" }],
        }),
        apiCalls: 1,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      allowedTools: {
        write_outline: { schema: z.object({ markdown: z.string() }), execute },
      },
    }))).rejects.toThrow(/invalid arguments.*write_outline/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires exactly one named tool and completes after it succeeds", async () => {
    const execute = vi.fn().mockResolvedValue({ summary: "theme saved" });
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({
          toolCalls: [{ id: "theme-1", name: "write_theme", argumentsJson: JSON.stringify({ brief: "one" }) }],
        }),
        apiCalls: 1,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      stage: "design",
      allowedTools: {
        write_theme: { schema: z.object({ brief: z.string() }).strict(), execute },
      },
      requiredToolName: "write_theme",
      maxTurns: 1,
      maxUpstreamCalls: 3,
    }))).resolves.toMatchObject({ upstreamCalls: 1 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(modelClient.completeStructured.mock.calls[0][0].schema.properties.toolCalls).toMatchObject({
      minItems: 1,
      maxItems: 1,
      items: { properties: { name: { type: "string", enum: ["write_theme"] } } },
    });
  });

  it("rejects a required-tool stage when the model only returns text", async () => {
    const execute = vi.fn();
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({ message: "Here is a direction", final: true }),
        apiCalls: 1,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      stage: "design",
      allowedTools: {
        write_theme: { schema: z.object({ brief: z.string() }).strict(), execute },
      },
      requiredToolName: "write_theme",
      maxTurns: 1,
      maxUpstreamCalls: 3,
    }))).rejects.toThrow(/requires exactly one write_theme/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates parsed tool arguments with the stage tool schema", async () => {
    const execute = vi.fn();
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({
          toolCalls: [{ id: "1", name: "write_outline", argumentsJson: JSON.stringify({ markdown: 42 }) }],
        }),
        apiCalls: 1,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      allowedTools: {
        write_outline: { schema: z.object({ markdown: z.string() }).strict(), execute },
      },
    }))).rejects.toThrow(/invalid arguments.*write_outline/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("counts compatibility repairs against the upstream-call budget", async () => {
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({ message: "done", final: true }),
        apiCalls: 3,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      stage: "design",
      maxUpstreamCalls: 2,
    }))).rejects.toThrow(/upstream-call budget.*2/i);
  });

  it("rejects more than three upstream calls from one logical model turn", async () => {
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({ message: "done", final: true }),
        apiCalls: 4,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      maxTurns: 2,
      maxUpstreamCalls: 6,
    }))).rejects.toThrow(/per-turn upstream-call budget 3/i);
  });

  it("does not begin another turn after the cumulative upstream budget is spent", async () => {
    const modelClient = {
      completeStructured: vi.fn()
        .mockResolvedValueOnce({ value: agentTurn(), apiCalls: 1 })
        .mockResolvedValueOnce({ value: agentTurn({ final: true }), apiCalls: 1 }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      maxTurns: 2,
      maxUpstreamCalls: 1,
    }))).rejects.toThrow(/upstream-call budget.*1/i);
    expect(modelClient.completeStructured).toHaveBeenCalledTimes(1);
  });

  it("rejects a stage that does not finish within its turn budget", async () => {
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({ value: agentTurn(), apiCalls: 1 }),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({
      maxTurns: 2,
      maxUpstreamCalls: 3,
    }))).rejects.toThrow(/turn budget.*2/i);
    expect(modelClient.completeStructured).toHaveBeenCalledTimes(2);
  });

  it("returns only bounded, sanitized tool summaries to subsequent model history", async () => {
    const sensitiveArguments = {
      markdown: "ARGUMENT_ARTIFACT_BODY",
      path: "/Users/example/private/outline.md",
      prompt: "ARGUMENT_MODEL_PROMPT",
    };
    const modelClient = {
      completeStructured: vi.fn()
        .mockResolvedValueOnce({
          value: agentTurn({
            message: "Calling https://api.openai.com/v1/responses",
            toolCalls: [{
              id: "call-1",
              name: "write_outline",
              argumentsJson: JSON.stringify(sensitiveArguments),
            }],
          }),
          apiCalls: 1,
        })
        .mockResolvedValueOnce({
          value: agentTurn({ message: "done", final: true }),
          apiCalls: 1,
        }),
    };
    const execute = vi.fn().mockResolvedValue({
      summary: [
        "Saved /Users/example/private/outline.md",
        "prompt=PRIVATE_MODEL_PROMPT",
        "apiKey=sk-private-key-1234567890",
        "provider=https://api.openai.com/v1/responses",
        "x".repeat(2_000),
      ].join("; "),
      artifactBody: "TOOL_ARTIFACT_BODY",
      sourceDocument: "TOOL_SOURCE_DOCUMENT",
      prompt: "TOOL_MODEL_PROMPT",
      providerUrl: "https://provider.invalid/v1",
    });
    const runner = createAgentRunner({ modelClient });

    await runner.runStage(stageOptions({
      allowedTools: {
        write_outline: {
          schema: z.object({
            markdown: z.string(),
            path: z.string(),
            prompt: z.string(),
          }).strict(),
          execute,
        },
      },
    }));

    const history = modelClient.completeStructured.mock.calls[1][0].messages;
    const toolHistory = JSON.parse(history.at(-1).content);
    expect(toolHistory.toolResults[0].summary.length).toBeLessThanOrEqual(1_000);
    expect(toolHistory.toolResults[0].summary).toContain("[redacted]");

    const serializedHistory = JSON.stringify(history);
    for (const sensitive of [
      "ARGUMENT_ARTIFACT_BODY",
      "ARGUMENT_MODEL_PROMPT",
      "/Users/example/private/outline.md",
      "PRIVATE_MODEL_PROMPT",
      "sk-private-key-1234567890",
      "api.openai.com",
      "TOOL_ARTIFACT_BODY",
      "TOOL_SOURCE_DOCUMENT",
      "TOOL_MODEL_PROMPT",
      "provider.invalid",
    ]) {
      expect(serializedHistory).not.toContain(sensitive);
    }
  });

  it("returns only explicitly authorized bounded model content to the next turn", async () => {
    const modelClient = {
      completeStructured: vi.fn()
        .mockResolvedValueOnce({
          value: agentTurn({
            toolCalls: [{ id: "read-1", name: "read_source_blocks", argumentsJson: "{}" }],
          }),
          apiCalls: 1,
        })
        .mockResolvedValueOnce({ value: agentTurn({ final: true }), apiCalls: 1 }),
    };
    const runner = createAgentRunner({ modelClient });

    await runner.runStage(stageOptions({
      allowedTools: {
        read_source_blocks: {
          schema: z.object({}).strict(),
          execute: vi.fn(async () => ({
            summary: "Source blocks loaded",
            modelContent: `EVIDENCE_BODY_42${"x".repeat(200_000)}`,
            artifactBody: "MUST_NOT_REACH_MODEL",
          })),
        },
      },
    }));

    const history = modelClient.completeStructured.mock.calls[1][0].messages;
    const toolResult = JSON.parse(history.at(-1).content).toolResults[0];
    expect(toolResult.modelContent).toContain("EVIDENCE_BODY_42");
    expect(toolResult.modelContent.length).toBeLessThanOrEqual(120_000);
    expect(JSON.stringify(history)).not.toContain("MUST_NOT_REACH_MODEL");
  });

  it("propagates external cancellation into an in-flight tool", async () => {
    const controller = new AbortController();
    let signalToolStarted;
    const toolStarted = new Promise((resolve) => { signalToolStarted = resolve; });
    let toolSignal;
    const execute = vi.fn((_input, { signal }) => abortablePending(signal, (received) => {
      toolSignal = received;
      signalToolStarted();
    }));
    const modelClient = {
      completeStructured: vi.fn().mockResolvedValue({
        value: agentTurn({
          toolCalls: [{ id: "1", name: "write_outline", argumentsJson: JSON.stringify({ markdown: "ok" }) }],
        }),
        apiCalls: 1,
      }),
    };
    const runner = createAgentRunner({ modelClient });

    const pending = runner.runStage(stageOptions({
      signal: controller.signal,
      allowedTools: {
        write_outline: { schema: z.object({ markdown: z.string() }), execute },
      },
    }));
    await toolStarted;
    controller.abort(new Error("user cancelled"));

    await expect(pending).rejects.toThrow(/user cancelled/i);
    expect(toolSignal.aborted).toBe(true);
  });

  it("propagates the stage timeout into an in-flight model turn", async () => {
    let modelSignal;
    const modelClient = {
      completeStructured: vi.fn(({ signal }) => abortablePending(signal, (received) => {
        modelSignal = received;
      })),
    };
    const runner = createAgentRunner({ modelClient });

    await expect(runner.runStage(stageOptions({ timeoutMs: 20 }))).rejects.toThrow(/timeout/i);
    expect(modelSignal.aborted).toBe(true);
  });

  it("forwards model and tool progress through the stage emitter", async () => {
    const modelProgress = { type: "delta", deltaChars: 4, totalChars: 4 };
    const toolProgress = { completed: 1, total: 2 };
    const emit = vi.fn().mockResolvedValue(undefined);
    const modelClient = {
      completeStructured: vi.fn()
        .mockImplementationOnce(async ({ onProgress }) => {
          await onProgress(modelProgress);
          return {
            value: agentTurn({
              toolCalls: [{ id: "1", name: "write_outline", argumentsJson: JSON.stringify({ markdown: "ok" }) }],
            }),
            apiCalls: 1,
          };
        })
        .mockResolvedValueOnce({
          value: agentTurn({ message: "done", final: true }),
          apiCalls: 1,
        }),
    };
    const execute = vi.fn(async (_input, { onProgress }) => {
      await onProgress(toolProgress);
      return { summary: "outline saved" };
    });
    const runner = createAgentRunner({ modelClient });

    await runner.runStage(stageOptions({
      emit,
      allowedTools: {
        write_outline: { schema: z.object({ markdown: z.string() }), execute },
      },
    }));

    expect(emit).not.toHaveBeenCalledWith({ type: "progress", progress: modelProgress });
    expect(emit).toHaveBeenCalledWith({
      stage: "outline",
      type: "progress",
      status: "running",
      title: "整理幻灯片内容大纲并写入 Markdown",
      message: "正在写入 Markdown 大纲",
      progress: { completed: 0, total: 1 },
    });
    expect(emit).toHaveBeenCalledWith({
      stage: "outline",
      type: "progress",
      status: "running",
      title: "整理幻灯片内容大纲并写入 Markdown",
      progress: toolProgress,
    });
    expect(execute).toHaveBeenCalledWith(
      { markdown: "ok" },
      expect.objectContaining({
        jobId: "job-1",
        stage: "outline",
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
  });

  it("publishes durable request, compatibility, and JSON repair milestones", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const modelClient = {
      completeStructured: vi.fn(async ({ onProgress }) => {
        onProgress({ type: "request", message: "Model request sent" });
        onProgress({ type: "request", message: "Compatibility retry sent" });
        onProgress({ type: "request", message: "JSON repair request sent" });
        return { value: agentTurn({ final: true }), apiCalls: 3 };
      }),
    };
    const runner = createAgentRunner({ modelClient });

    await runner.runStage(stageOptions({
      stage: "design",
      emit,
      maxTurns: 1,
      maxUpstreamCalls: 3,
    }));

    expect(emit.mock.calls.map(([event]) => event.message)).toEqual([
      "正在请求模型生成设计方向",
      "模型服务正在进行兼容重试",
      "正在修复模型返回格式",
    ]);
    expect(emit.mock.calls.every(([event]) => (
      event.stage === "design"
      && event.type === "progress"
      && event.status === "running"
      && event.progress.completed === 0
      && event.progress.total === 1
    ))).toBe(true);
  });
});
