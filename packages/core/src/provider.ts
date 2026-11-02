import type {
  ContentPart,
  NormalizedError,
  StopReason,
  ToolCall,
  Usage,
} from "@pika-harness/schema";

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; content: ContentPart[]; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName?: string; content: ContentPart[] };

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ProviderTool[];
  temperature?: number;
  maxOutputTokens?: number;
}

export type LlmEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason }
  | { type: "error"; error: NormalizedError };

export interface ModelInfo {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens?: number;
}

/** Provider boundary consumed by the runtime; implementations never expose wire formats. */
export interface Provider {
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
  models(): ModelInfo[];
}
