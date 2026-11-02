import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";

export interface OpenAiCompatibleModelOptions {
  id: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  name?: string;
  provider?: string;
  input?: Array<"text" | "image">;
  compat?: OpenAICompletionsCompat;
}

// Strict OpenAI-compatible servers reject undeclared fields, so avoid the
// OpenAI-only extras (store, stream_options, max_completion_tokens, ...).
const strictCompat: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  supportsLongCacheRetention: false,
};

/** Builds a pi-ai model descriptor for an OpenAI-compatible chat endpoint. */
export function createOpenAiCompatibleModel(
  options: OpenAiCompatibleModelOptions,
): Model<"openai-completions"> {
  return {
    id: options.id,
    name: options.name ?? options.id,
    api: "openai-completions",
    provider: options.provider ?? "openai-compatible",
    baseUrl: options.baseUrl,
    reasoning: false,
    input: options.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow,
    maxTokens: options.maxTokens,
    compat: { ...strictCompat, ...options.compat },
  };
}
