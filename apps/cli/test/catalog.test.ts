import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LlmEndpoint, ModelPreset } from "@pika-harness/schema";
import {
  catalogPresets,
  describeCatalog,
  endpointForModel,
  initialAlias,
  loadCatalog,
  MissingApiKeyError,
  presetSource,
  resolvePreset,
} from "../src/catalog.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function workspace(files: Record<string, unknown | string>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pika-cli-catalog-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(cwd, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return cwd;
}

function preset(name: string, overrides: Partial<ModelPreset> = {}): ModelPreset {
  return {
    name,
    model: `${name}-model`,
    baseUrl: `http://127.0.0.1/${name}/v1`,
    ...overrides,
  };
}

function isolatedEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: cwd, PIKA_HOME: path.join(cwd, "home"), ...extra };
}

const llm: LlmEndpoint = {
  baseUrl: "http://127.0.0.1:59000/v1",
  model: "env-model",
  apiKey: "env-secret",
};

describe("model catalog", () => {
  it("loads the project catalog and resolves the default preset", async () => {
    const cwd = await workspace({
      ".pika/models.json": {
        default: "beta",
        models: [preset("alpha"), preset("beta")],
      },
    });
    const state = await loadCatalog({ cwd, env: isolatedEnv(cwd) });

    expect(state.projectPath).toBe(path.join(cwd, ".pika", "models.json"));
    expect(initialAlias(state)).toBe("beta");
    expect(resolvePreset(state, "beta", {}).endpoint).toEqual({
      baseUrl: "http://127.0.0.1/beta/v1",
      model: "beta-model",
    });
  });

  it("prefers the implicit environment preset over the catalog default", async () => {
    const cwd = await workspace({
      ".pika/models.json": { default: "alpha", models: [preset("alpha")] },
    });
    const state = await loadCatalog({ cwd, env: isolatedEnv(cwd), llm });

    expect(initialAlias(state)).toBe("env");
    expect(catalogPresets(state).map((entry) => entry.name)).toEqual(["env", "alpha"]);
    expect(resolvePreset(state, "env", {}).endpoint).toEqual(llm);
  });

  it("falls back to the first preset when the catalog has no default", async () => {
    const cwd = await workspace({
      ".pika/models.json": { models: [preset("alpha"), preset("beta")] },
    });
    const state = await loadCatalog({ cwd, env: isolatedEnv(cwd) });
    expect(initialAlias(state)).toBe("alpha");
  });

  it("honors PIKA_MODELS_FILE relative to the working directory", async () => {
    const cwd = await workspace({
      "custom.json": { default: "alpha", models: [preset("alpha")] },
    });
    const state = await loadCatalog({
      cwd,
      env: isolatedEnv(cwd, { PIKA_MODELS_FILE: "custom.json" }),
    });
    expect(state.projectPath).toBe(path.join(cwd, "custom.json"));
    expect(initialAlias(state)).toBe("alpha");
  });

  it("exposes one implicit preset when no catalog exists", async () => {
    const cwd = await workspace({});
    const withoutLlm = await loadCatalog({ cwd, env: isolatedEnv(cwd) });
    expect(withoutLlm).toEqual({ presets: [], sources: {}, warnings: [] });
    expect(initialAlias(withoutLlm)).toBeUndefined();

    const withLlm = await loadCatalog({ cwd, env: isolatedEnv(cwd), llm });
    expect(initialAlias(withLlm)).toBe("env");
    expect(endpointForModel(withLlm, "env-model", {})).toEqual(llm);
  });

  it("merges user presets under the project catalog by alias", async () => {
    const cwd = await workspace({
      "user/models.json": {
        models: [preset("alpha", { model: "user-alpha" }), preset("beta")],
      },
      ".pika/models.json": {
        models: [preset("alpha", { model: "project-alpha" })],
      },
    });
    const state = await loadCatalog({
      cwd,
      env: isolatedEnv(cwd, { PIKA_CONFIG_DIR: path.join(cwd, "user") }),
    });

    expect(state.userPath).toBe(path.join(cwd, "user", "models.json"));
    expect(state.projectPath).toBe(path.join(cwd, ".pika", "models.json"));
    expect(state.presets.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(state.presets[0]?.model).toBe("project-alpha");
    expect(presetSource(state, "alpha")).toBe("project");
    expect(presetSource(state, "beta")).toBe("user");
  });

  it("prefers project defaults over user defaults and env flags over both", async () => {
    const cwd = await workspace({
      "user/models.json": { default: "beta", models: [preset("beta")] },
      ".pika/models.json": { default: "alpha", models: [preset("alpha")] },
    });
    const env = isolatedEnv(cwd, { PIKA_CONFIG_DIR: path.join(cwd, "user") });
    expect(initialAlias(await loadCatalog({ cwd, env }))).toBe("alpha");
    expect(initialAlias(await loadCatalog({ cwd, env, llm }))).toBe("env");

    const userOnly = await workspace({
      "user/models.json": { default: "beta", models: [preset("beta")] },
    });
    expect(
      initialAlias(
        await loadCatalog({
          cwd: userOnly,
          env: isolatedEnv(userOnly, { PIKA_CONFIG_DIR: path.join(userOnly, "user") }),
        }),
      ),
    ).toBe("beta");
  });

  it("keeps the remaining catalog when one file is invalid", async () => {
    const cwd = await workspace({
      "user/models.json": "{ not json",
      ".pika/models.json": { models: [preset("alpha")] },
    });
    const state = await loadCatalog({
      cwd,
      env: isolatedEnv(cwd, { PIKA_CONFIG_DIR: path.join(cwd, "user") }),
    });

    expect(state.presets.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(state.projectPath).toBe(path.join(cwd, ".pika", "models.json"));
    expect(state.userPath).toBeUndefined();
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toContain(path.join("user", "models.json"));
    expect(state.warnings[0]).toContain("invalid JSON");
  });

  it("resolves API keys only from the named environment variable", async () => {
    const cwd = await workspace({
      ".pika/models.json": {
        models: [preset("alpha", { apiKeyEnv: "ALPHA_KEY" })],
      },
    });
    const state = await loadCatalog({ cwd, env: isolatedEnv(cwd) });

    expect(() => resolvePreset(state, "alpha", {})).toThrow(MissingApiKeyError);
    try {
      resolvePreset(state, "alpha", {});
    } catch (error) {
      expect(error).toMatchObject({ variable: "ALPHA_KEY" });
      expect((error as Error).message).toContain("ALPHA_KEY");
    }
    expect(resolvePreset(state, "alpha", { ALPHA_KEY: "secret" }).endpoint.apiKey).toBe("secret");
  });

  it("falls back to credentials after the environment variable", async () => {
    const cwd = await workspace({
      ".pika/models.json": {
        models: [preset("alpha", { apiKeyEnv: "ALPHA_KEY" }), preset("local")],
      },
    });
    const state = await loadCatalog({
      cwd,
      env: isolatedEnv(cwd),
      credentials: { alpha: "stored-alpha", local: "stored-local" },
    });

    expect(resolvePreset(state, "alpha", { ALPHA_KEY: "env-secret" }).endpoint.apiKey).toBe(
      "env-secret",
    );
    expect(resolvePreset(state, "alpha", {}).endpoint.apiKey).toBe("stored-alpha");
    expect(resolvePreset(state, "local", {}).endpoint.apiKey).toBe("stored-local");
  });

  it("reports the file path and reason for invalid catalogs without throwing", async () => {
    const duplicate = await workspace({
      ".pika/models.json": { models: [preset("alpha"), preset("alpha")] },
    });
    const duplicateState = await loadCatalog({ cwd: duplicate, env: isolatedEnv(duplicate) });
    expect(duplicateState.presets).toEqual([]);
    expect(duplicateState.warnings[0]).toContain(".pika/models.json");
    expect(duplicateState.warnings[0]).toContain("duplicate");

    const malformed = await workspace({ ".pika/models.json": "{ not json" });
    const malformedState = await loadCatalog({ cwd: malformed, env: isolatedEnv(malformed) });
    expect(malformedState.warnings[0]).toContain("invalid JSON");

    const missingExplicit = await workspace({});
    const missingState = await loadCatalog({
      cwd: missingExplicit,
      env: isolatedEnv(missingExplicit, { PIKA_MODELS_FILE: "absent.json" }),
    });
    expect(missingState.warnings[0]).toContain("absent.json");
  });

  it("describes presets without printing secret values", async () => {
    const cwd = await workspace({});
    const state = await loadCatalog({ cwd, env: isolatedEnv(cwd), llm });
    state.projectPath = "/workspace/.pika/models.json";
    state.presets = [preset("alpha", { apiKeyEnv: "ALPHA_KEY" })];
    state.sources = { alpha: "project" };
    state.defaultAlias = "alpha";
    state.credentials = { alpha: "credential-secret" };

    const lines = describeCatalog(state, { ALPHA_KEY: "super-secret" });
    const text = lines.join("\n");
    expect(text).toContain("project catalog: /workspace/.pika/models.json");
    expect(text).toContain("user catalog: (none)");
    expect(text).toContain("ALPHA_KEY set");
    expect(text).toContain("credentials set");
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("credential-secret");
    expect(text).toContain("env (env-model)");
  });
});
