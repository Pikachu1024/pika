import { describe, expect, it } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreamOptions,
} from "@mariozechner/pi-ai";
import type { LlmEvent, LlmRequest } from "@pika-harness/core";
import type { PiAiStream } from "../../src/provider/pi-ai-provider.js";
import { PiAiProvider } from "../../src/provider/pi-ai-provider.js";

const model: Model<"openai-completions"> = {
  id: "gpt-test",
  name: "GPT Test",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "gpt-test",
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

interface Captured {
  context: Context;
  options: ProviderStreamOptions | undefined;
}

function fakeStream(events: AssistantMessageEvent[], captured?: Captured[]): PiAiStream {
  return async function* (_model, context, options) {
    captured?.push({ context, options });
    for (const event of events) {
      yield event;
    }
  };
}

const request: LlmRequest = {
  model: "gpt-test",
  system: "be helpful",
  messages: [
    { role: "user", content: [{ type: "text", text: "read a.txt" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "reading" }],
      toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      content: [{ type: "text", text: "contents" }],
    },
  ],
  tools: [
    {
      name: "read_file",
      description: "Reads a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
  temperature: 0.2,
  maxOutputTokens: 1_024,
};

async function collect(provider: PiAiProvider, signal = new AbortController().signal) {
  const events: LlmEvent[] = [];
  for await (const event of provider.stream(request, signal)) {
    events.push(event);
  }
  return events;
}

describe("PiAiProvider", () => {
  it("converts history, tools, and options into a pi-ai context", async () => {
    const captured: Captured[] = [];
    const provider = new PiAiProvider({
      model,
      stream: fakeStream([], captured),
      apiKey: "test-key",
      sessionId: "session_1",
      cacheRetention: "short",
      headers: { "x-test": "1" },
      now: () => 42,
    });
    const signal = new AbortController().signal;

    await collect(provider, signal);

    const [entry] = captured;
    expect(entry?.context.systemPrompt).toBe("be helpful");
    expect(entry?.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(entry?.context.messages[0]).toEqual({
      role: "user",
      content: "read a.txt",
      timestamp: 42,
    });
    expect(entry?.context.messages[1]).toMatchObject({
      role: "assistant",
      api: "openai-completions",
      provider: "openai",
      model: "gpt-test",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "reading" },
        {
          type: "toolCall",
          id: "call_1",
          name: "read_file",
          arguments: { path: "a.txt" },
        },
      ],
    });
    expect(entry?.context.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read_file",
      isError: false,
      content: [{ type: "text", text: "contents" }],
    });
    expect(entry?.context.tools?.[0]).toMatchObject({
      name: "read_file",
      description: "Reads a file",
      parameters: { type: "object", required: ["path"] },
    });
    expect(entry?.options).toMatchObject({
      signal,
      apiKey: "test-key",
      sessionId: "session_1",
      cacheRetention: "short",
      temperature: 0.2,
      maxTokens: 1_024,
      headers: { "x-test": "1" },
    });
  });

  it("maps text, reasoning, streamed tool calls, usage, and stop reasons", async () => {
    const events: AssistantMessageEvent[] = [
      {
        type: "text_start",
        contentIndex: 0,
        partial: assistant([{ type: "text", text: "" }]),
      },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: assistant([{ type: "text", text: "hello" }]),
      },
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "plan",
        partial: assistant([
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "plan" },
        ]),
      },
      {
        type: "toolcall_start",
        contentIndex: 2,
        partial: assistant([
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "plan" },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: {} },
        ]),
      },
      {
        type: "toolcall_delta",
        contentIndex: 2,
        delta: '{"path":',
        partial: assistant([
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "plan" },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: {} },
        ]),
      },
      {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: {
          type: "toolCall",
          id: "call_1",
          name: "read_file",
          arguments: { path: "a.txt" },
        },
        partial: assistant([
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "plan" },
          {
            type: "toolCall",
            id: "call_1",
            name: "read_file",
            arguments: { path: "a.txt" },
          },
        ]),
      },
      {
        type: "done",
        reason: "toolUse",
        message: assistant([], {
          stopReason: "toolUse",
          usage: {
            input: 10,
            output: 4,
            cacheRead: 3,
            cacheWrite: 2,
            totalTokens: 19,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ];
    const provider = new PiAiProvider({ model, stream: fakeStream(events) });

    await expect(collect(provider)).resolves.toEqual([
      { type: "text_delta", text: "hello" },
      { type: "reasoning_delta", text: "plan" },
      { type: "tool_call_delta", index: 2, id: "call_1", name: "read_file" },
      {
        type: "tool_call_delta",
        index: 2,
        argumentsDelta: '{"path":',
      },
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 },
      },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  it("emits the complete arguments when a tool call never streams deltas", async () => {
    const events: AssistantMessageEvent[] = [
      {
        type: "toolcall_start",
        contentIndex: 0,
        partial: assistant([{ type: "toolCall", id: "call_1", name: "glob", arguments: {} }]),
      },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "glob", arguments: { pattern: "*.ts" } },
        partial: assistant([{ type: "toolCall", id: "call_1", name: "glob", arguments: {} }]),
      },
      {
        type: "done",
        reason: "toolUse",
        message: assistant([], { stopReason: "toolUse" }),
      },
    ];
    const provider = new PiAiProvider({ model, stream: fakeStream(events) });

    const mapped = await collect(provider);

    expect(mapped.slice(0, 2)).toEqual([
      { type: "tool_call_delta", index: 0, id: "call_1", name: "glob" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"pattern":"*.ts"}' },
    ]);
  });

  it("normalizes provider errors and preserves partial usage", async () => {
    const events: AssistantMessageEvent[] = [
      {
        type: "error",
        reason: "error",
        error: assistant([{ type: "text", text: "partial" }], {
          stopReason: "error",
          errorMessage: "boom",
          usage: {
            input: 3,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 4,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ];
    const provider = new PiAiProvider({ model, stream: fakeStream(events) });

    await expect(collect(provider)).resolves.toEqual([
      { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } },
      {
        type: "error",
        error: { code: "provider_error", message: "boom", retryable: false },
      },
    ]);
  });

  it("maps an aborted pi-ai error", async () => {
    const provider = new PiAiProvider({
      model,
      stream: fakeStream([
        {
          type: "error",
          reason: "aborted",
          error: assistant([], { stopReason: "aborted" }),
        },
      ]),
    });

    const mapped = await collect(provider);

    expect(mapped.at(-1)).toEqual({
      type: "error",
      error: { code: "aborted", message: "request aborted", retryable: false },
    });
  });

  it("keeps content blocks for user messages that contain images", async () => {
    const captured: Captured[] = [];
    const provider = new PiAiProvider({ model, stream: fakeStream([], captured) });
    const imageRequest: LlmRequest = {
      ...request,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", data: "aGVsbG8=", mediaType: "image/png" },
          ],
        },
      ],
    };

    for await (const _event of provider.stream(imageRequest, new AbortController().signal)) {
      // Drain the stream; the captured context is the assertion target.
    }

    expect(captured[0]?.context.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      timestamp: expect.any(Number),
    });
  });

  it("exposes model metadata", () => {
    const provider = new PiAiProvider({ model });

    expect(provider.models()).toEqual([
      {
        id: "gpt-test",
        provider: "openai",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
      },
    ]);
  });
});
