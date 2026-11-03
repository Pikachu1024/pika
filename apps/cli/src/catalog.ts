import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmEndpoint, ModelCatalog, ModelPreset } from "@pika-harness/schema";
import { ModelCatalogSchema } from "@pika-harness/schema";
import type { Credentials } from "./credentials.js";
import { configDirectory } from "./home.js";

/** Alias of the implicit preset built from explicit LLM flags or environment values. */
export const ENV_PRESET_NAME = "env";

/** Where a preset was defined, used by `/models` and `/config`. */
export type PresetSource = "env" | "user" | "project";

export interface CatalogState {
  projectPath?: string;
  userPath?: string;
  presets: ModelPreset[];
  /** Source of each named preset; the implicit environment preset is reported separately. */
  sources: Record<string, PresetSource>;
  /** Non-fatal catalog problems, already formatted with the file path. */
  warnings: string[];
  defaultAlias?: string;
  envPreset?: ModelPreset;
  envEndpoint?: LlmEndpoint;
  credentials?: Credentials;
}

export interface LoadCatalogInput {
  cwd: string;
  env: Record<string, string | undefined>;
  llm?: LlmEndpoint;
  credentials?: Credentials;
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

/** Loads the user and project catalogs, or returns only the implicit environment preset. */
export async function loadCatalog(input: LoadCatalogInput): Promise<CatalogState> {
  const envPreset = input.llm === undefined ? undefined : environmentPreset(input.llm);
  const envFields: Pick<CatalogState, "envPreset" | "envEndpoint"> =
    input.llm === undefined || envPreset === undefined ? {} : { envPreset, envEndpoint: input.llm };
  const explicitPath = input.env.PIKA_MODELS_FILE;
  const projectPath =
    explicitPath === undefined || explicitPath.length === 0
      ? path.join(input.cwd, ".pika", "models.json")
      : path.resolve(input.cwd, explicitPath);
  const userPath = path.join(configDirectory(input.env), "models.json");

  const explicit = explicitPath !== undefined && explicitPath.length > 0;
  const [project, user] = await Promise.all([
    readCatalogFile(projectPath, explicit),
    readCatalogFile(userPath),
  ]);
  const warnings = [project.warning, user.warning].filter(
    (warning): warning is string => warning !== undefined,
  );

  // User presets come first; a project preset with the same alias replaces it in place.
  const merged = new Map<string, ModelPreset>();
  const sources: Record<string, PresetSource> = {};
  for (const preset of user.catalog?.models ?? []) {
    merged.set(preset.name, preset);
    sources[preset.name] = "user";
  }
  for (const preset of project.catalog?.models ?? []) {
    merged.set(preset.name, preset);
    sources[preset.name] = "project";
  }

  const defaultAlias = project.catalog?.default ?? user.catalog?.default;
  return {
    ...(project.catalog === undefined ? {} : { projectPath }),
    ...(user.catalog === undefined ? {} : { userPath }),
    presets: [...merged.values()],
    sources,
    warnings,
    ...(defaultAlias === undefined ? {} : { defaultAlias }),
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...envFields,
  };
}

/** Persists one preset in the user catalog, replacing a same-name entry atomically. */
export async function saveUserPreset(
  env: Record<string, string | undefined>,
  preset: ModelPreset,
): Promise<void> {
  const directory = configDirectory(env);
  const file = path.join(directory, "models.json");
  const existing = await readUserCatalogForWrite(file);
  const models = [...existing.models.filter((entry) => entry.name !== preset.name), preset];
  const catalog: ModelCatalog = { default: preset.name, models };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new CatalogError(file, describeFileError(error));
  }
}

async function readUserCatalogForWrite(catalogPath: string): Promise<ModelCatalog> {
  let contents: string;
  try {
    contents = await readFile(catalogPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { models: [] };
    throw new CatalogError(catalogPath, describeFileError(error));
  }
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new CatalogError(catalogPath, "invalid JSON");
  }
  const parsed = ModelCatalogSchema.safeParse(document);
  if (!parsed.success) throw new CatalogError(catalogPath, formatIssues(parsed.error));
  return parsed.data;
}

interface CatalogFileResult {
  catalog?: ModelCatalog;
  warning?: string;
}

async function readCatalogFile(catalogPath: string, required = false): Promise<CatalogFileResult> {
  let contents: string;
  try {
    contents = await readFile(catalogPath, "utf8");
  } catch (error) {
    if (isMissingFile(error) && !required) return {};
    return { warning: new CatalogError(catalogPath, describeFileError(error)).message };
  }

  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    return { warning: new CatalogError(catalogPath, "invalid JSON").message };
  }
  const parsed = ModelCatalogSchema.safeParse(document);
  if (!parsed.success) {
    return { warning: new CatalogError(catalogPath, formatIssues(parsed.error)).message };
  }
  return { catalog: parsed.data };
}

/** Presets visible to `/models`, with the implicit environment preset first. */
export function catalogPresets(state: CatalogState): ModelPreset[] {
  return state.envPreset === undefined ? [...state.presets] : [state.envPreset, ...state.presets];
}

/** Source of a preset alias, defaulting to `project` for hand-built state. */
export function presetSource(state: CatalogState, alias: string): PresetSource {
  if (state.envPreset !== undefined && alias === state.envPreset.name) return "env";
  return state.sources[alias] ?? "project";
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
  const environmentKey = preset.apiKeyEnv === undefined ? undefined : env[preset.apiKeyEnv];
  const storedKey = state.credentials?.[alias];
  if (preset.apiKeyEnv !== undefined && !isSet(environmentKey) && !isSet(storedKey)) {
    throw new MissingApiKeyError(preset.apiKeyEnv, alias);
  }
  const apiKey = isSet(environmentKey) ? environmentKey : storedKey;
  return {
    alias,
    preset,
    endpoint: {
      baseUrl: preset.baseUrl,
      model: preset.model,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow }),
      ...(preset.maxTokens === undefined ? {} : { maxTokens: preset.maxTokens }),
      ...(preset.tools === undefined ? {} : { tools: preset.tools }),
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
    `project catalog: ${state.projectPath ?? "(none)"}`,
    `user catalog: ${state.userPath ?? "(none)"}`,
    `default: ${initialAlias(state) ?? "(none)"}`,
  ];
  const presets = catalogPresets(state);
  if (presets.length === 0) {
    lines.push("presets: (none)");
    return lines;
  }
  lines.push("presets:");
  for (const preset of presets) {
    const stored = isSet(state.credentials?.[preset.name]) ? "set" : "missing";
    const key =
      preset.apiKeyEnv === undefined
        ? `credentials ${stored}`
        : `${preset.apiKeyEnv} ${isSet(env[preset.apiKeyEnv]) ? "set" : "missing"}, credentials ${stored}`;
    lines.push(`  ${preset.name} (${preset.model}) [${presetSource(state, preset.name)}] - ${key}`);
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
    ...(llm.tools === undefined ? {} : { tools: llm.tools }),
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
