import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LlmEndpoint, ModelPreset } from "@pika-harness/schema";
import {
  CatalogError,
  catalogPresets,
  describeCatalog,
  endpointForModel,
  initialAlias,
  loadCatalog,
  MissingApiKeyError,
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
    const state = await loadCatalog({ cwd, env: {} });

    expect(state.path).toBe(path.join(cwd, ".pika", "models.json"));
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
    const state = await loadCatalog({ cwd, env: {}, llm });

    expect(initialAlias(state)).toBe("env");
    expect(catalogPresets(state).map((entry) => entry.name)).toEqual(["env", "alpha"]);
    expect(resolvePreset(state, "env", {}).endpoint).toEqual(llm);
  });

  it("falls back to the first preset when the catalog has no default", async () => {
    const cwd = await workspace({
      ".pika/models.json": { models: [preset("alpha"), preset("beta")] },
    });
    const state = await loadCatalog({ cwd, env: {} });
    expect(initialAlias(state)).toBe("alpha");
  });

  it("honors PIKA_MODELS_FILE relative to the working directory", async () => {
    const cwd = await workspace({
      "custom.json": { default: "alpha", models: [preset("alpha")] },
    });
    const state = await loadCatalog({ cwd, env: { PIKA_MODELS_FILE: "custom.json" } });
    expect(state.path).toBe(path.join(cwd, "custom.json"));
    expect(initialAlias(state)).toBe("alpha");
  });

  it("exposes one implicit preset when no catalog exists", async () => {
    const cwd = await workspace({});
    const withoutLlm = await loadCatalog({ cwd, env: {} });
    expect(withoutLlm).toEqual({ presets: [] });
    expect(initialAlias(withoutLlm)).toBeUndefined();

    const withLlm = await loadCatalog({ cwd, env: {}, llm });
    expect(initialAlias(withLlm)).toBe("env");
    expect(endpointForModel(withLlm, "env-model", {})).toEqual(llm);
  });

  it("resolves API keys only from the named environment variable", async () => {
    const cwd = await workspace({
      ".pika/models.json": {
        models: [preset("alpha", { apiKeyEnv: "ALPHA_KEY" })],
      },
    });
    const state = await loadCatalog({ cwd, env: {} });

    expect(() => resolvePreset(state, "alpha", {})).toThrow(MissingApiKeyError);
    try {
      resolvePreset(state, "alpha", {});
    } catch (error) {
      expect(error).toMatchObject({ variable: "ALPHA_KEY" });
      expect((error as Error).message).toContain("ALPHA_KEY");
    }
    expect(resolvePreset(state, "alpha", { ALPHA_KEY: "secret" }).endpoint.apiKey).toBe("secret");
  });

  it("reports the file path and reason for invalid catalogs", async () => {
    const duplicate = await workspace({
      ".pika/models.json": { models: [preset("alpha"), preset("alpha")] },
    });
    const duplicateError = await loadCatalog({ cwd: duplicate, env: {} }).catch(
      (error: unknown) => error,
    );
    expect(duplicateError).toBeInstanceOf(CatalogError);
    expect((duplicateError as CatalogError).message).toContain(".pika/models.json");
    expect((duplicateError as CatalogError).message).toContain("duplicate");

    const malformed = await workspace({ ".pika/models.json": "{ not json" });
    await expect(loadCatalog({ cwd: malformed, env: {} })).rejects.toThrow(/invalid JSON/);

    const missingExplicit = await workspace({});
    await expect(
      loadCatalog({ cwd: missingExplicit, env: { PIKA_MODELS_FILE: "absent.json" } }),
    ).rejects.toThrow(/absent\.json/);
  });

  it("describes presets without printing secret values", async () => {
    const cwd = await workspace({});
    const state = await loadCatalog({ cwd, env: {}, llm });
    state.path = "/workspace/.pika/models.json";
    state.presets = [preset("alpha", { apiKeyEnv: "ALPHA_KEY" })];
    state.defaultAlias = "alpha";

    const lines = describeCatalog(state, { ALPHA_KEY: "super-secret" });
    const text = lines.join("\n");
    expect(text).toContain("/workspace/.pika/models.json");
    expect(text).toContain("ALPHA_KEY set");
    expect(text).not.toContain("super-secret");
    expect(text).toContain("env (env-model)");
  });
});
