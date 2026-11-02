import { describe, expect, it } from "bun:test";
import type { LlmEvent } from "@pika-harness/core";
import { createOpenAiCompatibleModel } from "../../src/provider/openai-compatible.js";
import { PiAiProvider } from "../../src/provider/pi-ai-provider.js";

// Opt-in only: requires a reachable OpenAI-compatible endpoint. The default
// `bun test` run skips this file.
const enabled =
  process.env.PIKA_LIVE_LOCAL === "1" &&
  (process.env.PIKA_LLM_BASE_URL?.length ?? 0) > 0 &&
  (process.env.PIKA_LLM_API_KEY?.length ?? 0) > 0 &&
  (process.env.PIKA_LLM_MODEL?.length ?? 0) > 0;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when PIKA_LIVE_LOCAL=1`);
  }
  return value;
}

function createProvider(modelId = requiredEnv("PIKA_LLM_MODEL")): PiAiProvider {
  return new PiAiProvider({
    model: createOpenAiCompatibleModel({
      id: modelId,
      baseUrl: requiredEnv("PIKA_LLM_BASE_URL"),
      contextWindow: 32_768,
      maxTokens: 256,
    }),
    apiKey: requiredEnv("PIKA_LLM_API_KEY"),
  });
}

describe.skipIf(!enabled)("local OpenAI-compatible live provider", () => {
  it("streams text and completes", async () => {
    const provider = createProvider();
    const events: LlmEvent[] = [];
    for await (const event of provider.stream(
      {
        model: requiredEnv("PIKA_LLM_MODEL"),
        system: "回答控制在五十字以内。",
        messages: [{ role: "user", content: [{ type: "text", text: "用一句话说明什么是气血。" }] }],
        tools: [],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end" });
  }, 60_000);

  it("normalizes provider failures into an error event", async () => {
    const modelId = "definitely-not-a-model";
    const provider = createProvider(modelId);
    const events: LlmEvent[] = [];
    for await (const event of provider.stream(
      {
        model: modelId,
        system: "",
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        tools: [],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "provider_error", retryable: false },
    });
  }, 60_000);
});
