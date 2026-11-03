import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseArgs, usage } from "../src/cli.js";

const ENV_KEYS = [
  "PIKA_LLM_BASE_URL",
  "PIKA_LLM_MODEL",
  "PIKA_LLM_API_KEY",
  "PIKA_LLM_CONTEXT_WINDOW",
  "PIKA_LLM_MAX_TOKENS",
];

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = "";
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("cli usage text", () => {
  it("documents the Pika home paths and environment variable", () => {
    expect(usage).toContain("PIKA_HOME");
    expect(usage).toContain("$PIKA_HOME/models.json (~/.pika/models.json)");
    expect(usage).toContain("$PIKA_HOME/credentials.json");
  });
});

describe("cli LLM options", () => {
  it("builds an endpoint from flags", () => {
    const options = parseArgs([
      "--llm-base-url",
      "http://127.0.0.1:59000/v1",
      "--llm-model",
      "local-model",
      "--llm-api-key",
      "secret-key",
      "--llm-context-window",
      "8192",
      "--llm-max-tokens",
      "1024",
    ]);
    expect(options.llm).toEqual({
      baseUrl: "http://127.0.0.1:59000/v1",
      model: "local-model",
      apiKey: "secret-key",
      contextWindow: 8192,
      maxTokens: 1024,
    });
  });

  it("reads environment values and lets flags override them", () => {
    process.env.PIKA_LLM_BASE_URL = "http://env.example/v1";
    process.env.PIKA_LLM_MODEL = "env-model";
    process.env.PIKA_LLM_API_KEY = "env-key";

    expect(parseArgs([]).llm).toEqual({
      baseUrl: "http://env.example/v1",
      model: "env-model",
      apiKey: "env-key",
    });
    expect(parseArgs(["--llm-model", "flag-model"]).llm).toEqual({
      baseUrl: "http://env.example/v1",
      model: "flag-model",
      apiKey: "env-key",
    });
  });

  it("leaves the endpoint undefined when no LLM settings are present", () => {
    expect(parseArgs([]).llm).toBeUndefined();
  });

  it("requires the base URL and model together", () => {
    expect(() => parseArgs(["--llm-base-url", "http://x/v1"])).toThrow(/must be provided together/);
    expect(() => parseArgs(["--llm-model", "m"])).toThrow(/must be provided together/);
  });

  it("rejects invalid token limits", () => {
    expect(() => parseArgs(["--llm-context-window", "0"])).toThrow(/invalid --llm-context-window/);
    expect(() => parseArgs(["--llm-max-tokens", "1.5"])).toThrow(/invalid --llm-max-tokens/);
  });
});
