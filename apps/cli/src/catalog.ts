import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LlmEndpoint, ModelCatalog, ModelPreset } from "@pika-harness/schema";
import { ModelCatalogSchema } from "@pika-harness/schema";

/** Alias of the implicit preset built from explicit LLM flags or environment values. */
export const ENV_PRESET_NAME = "env";

export interface CatalogState {
  path?: string;
  presets: ModelPreset[];
  defaultAlias?: string;
  envPreset?: ModelPreset;
  envEndpoint?: LlmEndpoint;
}

export interface LoadCatalogInput {
  cwd: string;
  env: Record<string, string | undefined>;
  llm?: LlmEndpoint;
}

export interface ResolvedPreset {
  alias: string;
  preset: ModelPreset;
  endpoint: LlmEndpoint;
}

/** A catalog file could not be read or validated. */
export class CatalogError extends Error {
  readonly catalogPath: string;

  constructor(catalogPath: string, reason: string) {
    super(`invalid model catalog at ${catalogPath}: ${reason}`);
    this.name = "CatalogError";
    this.catalogPath = catalogPath;
  }
}

/** A preset references an environment variable that is unset or empty. */
export class MissingApiKeyError extends Error {
  readonly variable: string;

  constructor(variable: string, alias: string) {
    super(`model preset "${alias}" requires environment variable ${variable}`);
    this.name = "MissingApiKeyError";
    this.variable = variable;
  }
}

/** Builds the implicit preset that represents explicit LLM flags or environment values. */
export function environmentPreset(llm: LlmEndpoint): ModelPreset {
  return presetFromEndpoint(llm);
}

/** Loads the project catalog, or returns only the implicit environment preset. */
export async function loadCatalog(input: LoadCatalogInput): Promise<CatalogState> {
  const envPreset = input.llm === undefined ? undefined : environmentPreset(input.llm);
  const envFields: Pick<CatalogState, "envPreset" | "envEndpoint"> =
    input.llm === undefined || envPreset === undefined ? {} : { envPreset, envEndpoint: input.llm };
  const explicitPath = input.env.PIKA_MODELS_FILE;
  const catalogPath =
    explicitPath === undefined || explicitPath.length === 0
      ? path.join(input.cwd, ".pika", "models.json")
      : path.resolve(input.cwd, explicitPath);

  let contents: string;
  try {
    contents = await readFile(catalogPath, "utf8");
  } catch (error) {
    if (explicitPath === undefined && isMissingFile(error)) {
      return { presets: [], ...envFields };
    }
    throw new CatalogError(catalogPath, describeFileError(error));
  }

  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new CatalogError(catalogPath, "invalid JSON");
  }
  const parsed = ModelCatalogSchema.safeParse(document);
  if (!parsed.success) {
    throw new CatalogError(catalogPath, formatIssues(parsed.error));
  }
  const catalog: ModelCatalog = parsed.data;
  return {
    path: catalogPath,
    presets: catalog.models,
    ...(catalog.default === undefined ? {} : { defaultAlias: catalog.default }),
    ...envFields,
  };
}

/** Presets visible to `/models`, with the implicit environment preset first. */
export function catalogPresets(state: CatalogState): ModelPreset[] {
  return state.envPreset === undefined ? [...state.presets] : [state.envPreset, ...state.presets];
}

/** Picks the alias used when the client connects: env flags, then default, then first preset. */
export function initialAlias(state: CatalogState): string | undefined {
  if (state.envPreset !== undefined) return state.envPreset.name;
  if (state.defaultAlias !== undefined) return state.defaultAlias;
  return state.presets[0]?.name;
}

/** Resolves an alias to a concrete endpoint and fails when its API key variable is unset. */
export function resolvePreset(
  state: CatalogState,
  alias: string,
  env: Record<string, string | undefined>,
): ResolvedPreset {
  if (state.envPreset !== undefined && alias === state.envPreset.name) {
    return {
      alias,
      preset: state.envPreset,
      endpoint: state.envEndpoint as LlmEndpoint,
    };
  }
  const preset = state.presets.find((candidate) => candidate.name === alias);
  if (preset === undefined) {
    throw new Error(`unknown model preset: ${alias}`);
  }
  const apiKey = preset.apiKeyEnv === undefined ? undefined : env[preset.apiKeyEnv];
  if (preset.apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)) {
    throw new MissingApiKeyError(preset.apiKeyEnv, alias);
  }
  return {
    alias,
    preset,
    endpoint: {
      baseUrl: preset.baseUrl,
      model: preset.model,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow }),
      ...(preset.maxTokens === undefined ? {} : { maxTokens: preset.maxTokens }),
    },
  };
}

/** Finds an endpoint for an existing session model, or undefined when no preset matches. */
export function endpointForModel(
  state: CatalogState,
  model: string,
  env: Record<string, string | undefined>,
): LlmEndpoint | undefined {
  const preset = catalogPresets(state).find((candidate) => candidate.model === model);
  if (preset === undefined) return undefined;
  return resolvePreset(state, preset.name, env).endpoint;
}

/** Read-only catalog lines for `/config`; API keys are reported as set or missing only. */
export function describeCatalog(
  state: CatalogState,
  env: Record<string, string | undefined>,
): string[] {
  const lines = [
    `catalog: ${state.path ?? "(none)"}`,
    `default: ${initialAlias(state) ?? "(none)"}`,
  ];
  const presets = catalogPresets(state);
  if (presets.length === 0) {
    lines.push("presets: (none)");
    return lines;
  }
  lines.push("presets:");
  for (const preset of presets) {
    const key =
      preset.apiKeyEnv === undefined
        ? "no api key variable"
        : `${preset.apiKeyEnv} ${isSet(env[preset.apiKeyEnv]) ? "set" : "missing"}`;
    lines.push(`  ${preset.name} (${preset.model}) - ${key}`);
  }
  return lines;
}

function presetFromEndpoint(llm: LlmEndpoint): ModelPreset {
  return {
    name: ENV_PRESET_NAME,
    model: llm.model,
    baseUrl: llm.baseUrl,
    ...(llm.contextWindow === undefined ? {} : { contextWindow: llm.contextWindow }),
    ...(llm.maxTokens === undefined ? {} : { maxTokens: llm.maxTokens }),
  };
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function describeFileError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatIssues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}
