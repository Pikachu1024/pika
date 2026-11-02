import { describe, expect, it } from "bun:test";
import { createOpenAiCompatibleModel } from "../../src/provider/openai-compatible.js";

describe("createOpenAiCompatibleModel", () => {
  it("builds an openai-completions model with strict-server defaults", () => {
    const model = createOpenAiCompatibleModel({
      id: "local-model",
      baseUrl: "http://127.0.0.1:8000/v1",
      contextWindow: 32_768,
      maxTokens: 4_096,
    });

    expect(model).toMatchObject({
      id: "local-model",
      name: "local-model",
      api: "openai-completions",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    });
  });

  it("merges caller compat overrides", () => {
    const model = createOpenAiCompatibleModel({
      id: "local-model",
      baseUrl: "http://127.0.0.1:8000/v1",
      contextWindow: 32_768,
      maxTokens: 4_096,
      compat: { supportsStore: true, supportsUsageInStreaming: true },
    });

    expect(model.compat).toMatchObject({
      supportsStore: true,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    });
  });
});
