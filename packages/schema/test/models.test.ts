import { describe, expect, it } from "bun:test";
import { ModelCatalogSchema, ModelPresetSchema } from "../src/index.js";

const documentedCatalog = {
  default: "jiuwei",
  models: [
    {
      name: "jiuwei",
      model: "jiuwei-tcm",
      baseUrl: "http://192.168.56.39:59000/v1",
      apiKeyEnv: "PIKA_LLM_API_KEY",
      contextWindow: 32_768,
      maxTokens: 4_096,
    },
    { name: "tiny", model: "tiny-model", baseUrl: "http://127.0.0.1:59000/v1" },
  ],
};

describe("model catalog schemas", () => {
  it("accepts the documented catalog", () => {
    expect(ModelCatalogSchema.parse(documentedCatalog)).toEqual(documentedCatalog);
    expect(ModelCatalogSchema.parse({ models: [] })).toEqual({ models: [] });
  });

  it("rejects duplicate preset names", () => {
    const result = ModelCatalogSchema.safeParse({
      default: "same",
      models: [
        { name: "same", model: "a", baseUrl: "http://x/v1" },
        { name: "same", model: "b", baseUrl: "http://x/v1" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("duplicate model preset name");
    }
  });

  it("rejects a default that names no preset", () => {
    const result = ModelCatalogSchema.safeParse({
      default: "missing",
      models: [{ name: "present", model: "m", baseUrl: "http://x/v1" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("default model preset not found");
    }
  });

  it("rejects empty names, endpoints, and non-positive limits", () => {
    const base = { name: "preset", model: "model", baseUrl: "http://x/v1" };
    expect(ModelPresetSchema.safeParse({ ...base, name: "" }).success).toBe(false);
    expect(ModelPresetSchema.safeParse({ ...base, model: "" }).success).toBe(false);
    expect(ModelPresetSchema.safeParse({ ...base, baseUrl: "" }).success).toBe(false);
    expect(ModelPresetSchema.safeParse({ ...base, apiKeyEnv: "" }).success).toBe(false);
    expect(ModelPresetSchema.safeParse({ ...base, contextWindow: 0 }).success).toBe(false);
    expect(ModelPresetSchema.safeParse({ ...base, maxTokens: 1.5 }).success).toBe(false);
    expect(ModelPresetSchema.safeParse(base).success).toBe(true);
  });
});
