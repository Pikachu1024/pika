import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Message,
  Model,
  Tool as PiTool,
  ProviderStreamOptions,
  TSchema,
} from "@mariozechner/pi-ai";
import { stream as piStream, Type } from "@mariozechner/pi-ai";
import type {
  LlmEvent,
  LlmMessage,
  LlmRequest,
  ModelInfo,
  Provider,
  ProviderTool,
} from "@pika-harness/core";
import type { ContentPart, StopReason, Usage } from "@pika-harness/schema";

export type PiAiStream = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export interface PiAiProviderOptions {
  model: Model<Api>;
  /** Injectable transport; defaults to pi-ai's stream(). */
  stream?: PiAiStream;
  apiKey?: string;
  sessionId?: string;
  cacheRetention?: CacheRetention;
  headers?: Record<string, string>;
  /** Injectable clock for deterministic message timestamps. */
  now?: () => number;
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...zeroCost },
  };
}

/** Adapts pi-ai models and streams to the harness provider boundary. */
export class PiAiProvider implements Provider {
  readonly #model: Model<Api>;
  readonly #stream: PiAiStream;
  readonly #headers: Record<string, string> | undefined;
  readonly #apiKey: string | undefined;
  readonly #sessionId: string | undefined;
  readonly #cacheRetention: CacheRetention | undefined;
  readonly #now: () => number;

  constructor(options: PiAiProviderOptions) {
    this.#model = options.model;
    this.#stream =
      options.stream ??
      ((model, context, streamOptions) => piStream(model, context, streamOptions));
    this.#headers = options.headers;
    this.#apiKey = options.apiKey;
    this.#sessionId = options.sessionId;
    this.#cacheRetention = options.cacheRetention;
    this.#now = options.now ?? Date.now;
  }

  models(): ModelInfo[] {
    return [
      {
        id: this.#model.id,
        provider: this.#model.provider,
        contextWindow: this.#model.contextWindow,
        maxOutputTokens: this.#model.maxTokens,
      },
    ];
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    const context = toContext(request, this.#model, this.#now);
    const options: ProviderStreamOptions = {
      signal,
      ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#cacheRetention === undefined ? {} : { cacheRetention: this.#cacheRetention }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
      ...(this.#headers === undefined ? {} : { headers: this.#headers }),
    };

    const identities = new Set<number>();
    const argumentDeltas = new Set<number>();
    for await (const event of this.#stream(this.#model, context, options)) {
      switch (event.type) {
        case "text_delta":
          yield { type: "text_delta", text: event.delta };
          break;
        case "thinking_delta":
          yield { type: "reasoning_delta", text: event.delta };
          break;
        case "toolcall_start": {
          const identity = callIdentity(event.partial, event.contentIndex);
          identities.add(event.contentIndex);
          yield {
            type: "tool_call_delta",
            index: event.contentIndex,
            ...identity,
          };
          break;
        }
        case "toolcall_delta": {
          const identity = identities.has(event.contentIndex)
            ? {}
            : callIdentity(event.partial, event.contentIndex);
          identities.add(event.contentIndex);
          argumentDeltas.add(event.contentIndex);
          yield {
            type: "tool_call_delta",
            index: event.contentIndex,
            ...identity,
            argumentsDelta: event.delta,
          };
          break;
        }
        case "toolcall_end": {
          const identity = identities.has(event.contentIndex)
            ? {}
            : callIdentity(event.partial, event.contentIndex);
          identities.add(event.contentIndex);
          if (!argumentDeltas.has(event.contentIndex)) {
            argumentDeltas.add(event.contentIndex);
            yield {
              type: "tool_call_delta",
              index: event.contentIndex,
              ...identity,
              argumentsDelta: JSON.stringify(event.toolCall.arguments),
            };
          } else if (Object.keys(identity).length > 0) {
            yield { type: "tool_call_delta", index: event.contentIndex, ...identity };
          }
          break;
        }
        case "done":
          yield { type: "usage", usage: toUsage(event.message.usage) };
          yield { type: "done", stopReason: toStopReason(event.reason) };
          break;
        case "error": {
          yield { type: "usage", usage: toUsage(event.error.usage) };
          yield { type: "error", error: toError(event) };
          break;
        }
        default:
          break;
      }
    }
  }
}

function toContext(request: LlmRequest, model: Model<Api>, now: () => number): Context {
  const toolNames = new Map<string, string>();
  const messages: Message[] = [];
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: toUserContent(message.content), timestamp: now() });
      continue;
    }
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.name);
      }
      messages.push(toAssistantMessage(message, model, now));
      continue;
    }
    const toolName = message.toolName ?? toolNames.get(message.toolCallId) ?? "unknown";
    messages.push({
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName,
      content: toToolResultContent(message.content),
      isError: message.content.some((part) => part.type === "error"),
      timestamp: now(),
    });
  }

  return {
    ...(request.system.length === 0 ? {} : { systemPrompt: request.system }),
    messages,
    ...(request.tools.length === 0 ? {} : { tools: request.tools.map(toPiTool) }),
  };
}

function toPiTool(tool: ProviderTool): PiTool {
  // Zod's JSON Schema output is structurally compatible with TypeBox's TSchema.
  return {
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters as TSchema),
  };
}

function toUserContent(
  content: ContentPart[],
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const blocks: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "image":
        blocks.push({ type: "image", data: part.data, mimeType: part.mediaType });
        break;
      case "error":
        blocks.push({ type: "text", text: `[error] ${part.message}` });
        break;
    }
  }
  return blocks;
}

function toToolResultContent(
  content: ContentPart[],
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  return toUserContent(content);
}

function toAssistantMessage(
  message: Extract<LlmMessage, { role: "assistant" }>,
  model: Model<Api>,
  now: () => number,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      content.push({ type: "text", text: `[image omitted: ${part.mediaType}]` });
    } else {
      content.push({ type: "text", text: `[error] ${part.message}` });
    }
  }
  for (const call of message.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: parseArguments(call.arguments),
    });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: (message.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
    timestamp: now(),
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function callIdentity(partial: AssistantMessage, index: number): { id?: string; name?: string } {
  const block = partial.content[index];
  if (block?.type !== "toolCall") {
    return {};
  }
  return {
    ...(block.id.length === 0 ? {} : { id: block.id }),
    ...(block.name.length === 0 ? {} : { name: block.name }),
  };
}

function toUsage(usage: AssistantMessage["usage"]): Usage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

function toStopReason(reason: "stop" | "length" | "toolUse"): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "tool_use";
  }
}

function toError(event: Extract<AssistantMessageEvent, { type: "error" }>) {
  const message = event.error.errorMessage;
  if (event.reason === "aborted") {
    return {
      code: "aborted",
      message: message === undefined || message.length === 0 ? "request aborted" : message,
      retryable: false as const,
    };
  }
  return {
    code: "provider_error",
    message: message === undefined || message.length === 0 ? "provider request failed" : message,
    retryable: false as const,
  };
}
