import type { AutocompleteItem, SlashCommand } from "@mariozechner/pi-tui";
import { CombinedAutocompleteProvider } from "@mariozechner/pi-tui";
import type { NetworkPolicy, SandboxMode } from "@pika-harness/schema";
import { catalogPresets } from "../catalog.js";
import { parseCommand } from "./tokenizer.js";
import type { CommandContext, ConnectOptions, HandoffOptions, SandboxOptions } from "./types.js";

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
  getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[];
  run(args: string[], context: CommandContext): Promise<void> | void;
}

const sandboxModes: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const networkPolicies: NetworkPolicy[] = ["none", "proxy", "full"];

/** Builds the slash-command registry bound to a controller. */
export function createCommands(context: CommandContext): CommandDefinition[] {
  const commands: CommandDefinition[] = [];

  commands.push({
    name: "help",
    description: "List slash commands",
    run: () => context.print(formatHelp(commands)),
  });

  commands.push({
    name: "models",
    description: "List model presets and mark the active model",
    run: () => context.showModels(),
  });

  commands.push({
    name: "model",
    argumentHint: "<alias>",
    description: "Fork the current session with another model preset",
    getArgumentCompletions: (prefix) => aliasCompletions(context, prefix),
    run: async (args) => context.switchModel(args[0]),
  });

  commands.push({
    name: "config",
    description: "Show the catalog path, presets, and key variable presence",
    run: () => context.showConfig(),
  });

  commands.push({
    name: "connect",
    description: "Configure an LLM endpoint and start a new session with it",
    run: async () => {
      const options = await collectConnectOptions(context);
      if (options !== undefined) await context.connect(options);
    },
  });

  commands.push({
    name: "status",
    description: "Show the active session, model, sandbox, and working directory",
    run: () => context.showStatus(),
  });

  commands.push({
    name: "usage",
    description: "Show aggregated token usage for the active session",
    run: () => context.showUsage(),
  });

  commands.push({
    name: "context",
    description: "Show the latest context projection",
    run: () => context.showContext(),
  });

  commands.push({
    name: "new",
    description: "Start a new session with the current model and directory",
    run: async () => context.startNewSession(),
  });

  commands.push({
    name: "sessions",
    description: "List sessions",
    run: async () => context.showSessions(),
  });

  commands.push({
    name: "resume",
    argumentHint: "[sessionId]",
    description: "Resume a session and move the transcript to it",
    getArgumentCompletions: (prefix) =>
      context
        .sessionIds()
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: id })),
    run: async (args) => context.resumeSession(args[0]),
  });

  commands.push({
    name: "fork",
    argumentHint: "[entryId]",
    description: "Fork the current session at an entry or the head",
    run: async (args) => context.forkSession(args[0]),
  });

  commands.push({
    name: "handoff",
    argumentHint: "<alias> [--cwd <path>] [--sandbox <mode>] [--network <policy>]",
    description: "Fork at the head with a preset model and environment overrides",
    getArgumentCompletions: (prefix) => aliasCompletions(context, prefix),
    run: async (args) => context.handoff(parseHandoffArgs(args)),
  });

  commands.push({
    name: "sandbox",
    argumentHint: "[mode] [--network <policy>]",
    description: "Request a sandbox mode and network policy",
    getArgumentCompletions: (prefix) => {
      const options = [...sandboxModes, ...networkPolicies].filter((value) =>
        value.startsWith(prefix),
      );
      return options.map((value) => ({ value, label: value }));
    },
    run: async (args) => context.setSandbox(parseSandboxArgs(args)),
  });

  commands.push({
    name: "compact",
    description: "Force context compaction on a settled session",
    run: async () => context.compact(),
  });

  commands.push({
    name: "btw",
    argumentHint: "<question>",
    description: "Ask a settled session a side question without recording it",
    run: async (args) => {
      const question = args.join(" ").trim();
      if (question.length === 0) throw new Error("usage: /btw <question>");
      await context.askSideQuestion(question);
    },
  });

  commands.push({
    name: "approve",
    description: "Approve the pending escalation for this session",
    run: async () => context.respondApproval("approve_for_session"),
  });

  commands.push({
    name: "deny",
    description: "Deny the pending escalation",
    run: async () => context.respondApproval("deny"),
  });

  commands.push({
    name: "quit",
    description: "Exit the client",
    run: () => context.quit(),
  });

  return commands;
}

/** Renders the command list shown by `/help`. */
export function formatHelp(commands: readonly CommandDefinition[]): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands.map((command) => {
    const usage = command.argumentHint === undefined ? "" : ` ${command.argumentHint}`;
    return `/${command.name.padEnd(width)}${usage}  ${command.description}`;
  });
  return `${lines.join("\n")}\n`;
}

/** pi-tui slash definitions for command and argument completion. */
export function slashCommands(commands: readonly CommandDefinition[]): SlashCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    ...(command.getArgumentCompletions === undefined
      ? {}
      : { getArgumentCompletions: command.getArgumentCompletions }),
  }));
}

/** Autocomplete provider combining slash commands with path completion. */
export function createAutocomplete(
  commands: readonly CommandDefinition[],
  cwd: string,
): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(slashCommands(commands), cwd);
}

/** Dispatches slash input locally; returns false when the input is a plain prompt. */
export async function dispatchCommand(
  commands: readonly CommandDefinition[],
  input: string,
  context: CommandContext,
): Promise<boolean> {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(input);
  } catch (error) {
    context.print(`[command error] ${errorMessage(error)}\n`);
    return true;
  }
  if (parsed === undefined) return false;
  const command = commands.find((candidate) => candidate.name === parsed.name);
  if (command === undefined) {
    context.print(`Unknown command: /${parsed.name}. Type /help for the command list.\n`);
    return true;
  }
  try {
    await command.run(parsed.args, context);
  } catch (error) {
    context.print(`[command error] ${errorMessage(error)}\n`);
  }
  return true;
}

function aliasCompletions(context: CommandContext, prefix: string): AutocompleteItem[] {
  return catalogPresets(context.catalog)
    .filter((preset) => preset.name.startsWith(prefix))
    .map((preset) => ({
      value: preset.name,
      label: preset.name,
      description: preset.model,
    }));
}

async function collectConnectOptions(context: CommandContext): Promise<ConnectOptions | undefined> {
  if (context.busy) {
    throw new Error("session is not settled; wait for the current turn to finish");
  }
  const provider = await context.select("Provider type", [
    {
      value: "openai-compatible",
      label: "OpenAI-compatible",
      description: "Chat completions over HTTP",
    },
  ]);
  if (provider !== "openai-compatible") return undefined;

  const baseUrlInput = await context.promptText("Base URL");
  if (baseUrlInput === undefined) return undefined;
  const baseUrl = baseUrlInput.trim();
  if (baseUrl === "") throw new Error("missing base URL for /connect");
  assertHttpUrl(baseUrl);

  const modelInput = await context.promptText("Model id");
  if (modelInput === undefined) return undefined;
  const model = modelInput.trim();
  if (model === "") throw new Error("missing model id for /connect");

  const aliasInput = await context.promptText(`Alias (default: ${model})`);
  if (aliasInput === undefined) return undefined;
  const alias = aliasInput.trim() === "" ? model : aliasInput.trim();
  if (alias === "env") throw new Error('alias "env" is reserved for environment flags');

  const keyInput = await context.promptSecret("API key (optional)");
  if (keyInput === undefined) return undefined;

  const windowInput = await context.promptText("Context window (optional)");
  if (windowInput === undefined) return undefined;
  const contextWindow = parseOptionalPositiveInteger(windowInput, "context window");

  const maxTokensInput = await context.promptText("Max output tokens (optional)");
  if (maxTokensInput === undefined) return undefined;
  const maxTokens = parseOptionalPositiveInteger(maxTokensInput, "max output tokens");

  const toolsChoice = await context.select("Tool calling", [
    {
      value: "enabled",
      label: "Enabled",
      description: "Declare built-in tools to the provider",
    },
    {
      value: "disabled",
      label: "Disabled",
      description: "For endpoints that reject the tools field",
    },
  ]);
  if (toolsChoice === undefined) return undefined;

  const apiKey = keyInput.trim();
  return {
    provider: "openai-compatible",
    alias,
    baseUrl,
    model,
    ...(apiKey === "" ? {} : { apiKey }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    tools: toolsChoice !== "disabled",
  };
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid base URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid base URL protocol: ${url.protocol}`);
  }
}

function parseOptionalPositiveInteger(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${label}: ${trimmed}`);
  }
  return parsed;
}

function parseHandoffArgs(args: string[]): HandoffOptions {
  const alias = args[0];
  if (alias === undefined || alias.startsWith("--")) {
    throw new Error(
      "usage: /handoff <alias> [--cwd <path>] [--sandbox <mode>] [--network <policy>]",
    );
  }
  const options: HandoffOptions = { alias };
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case "--cwd":
        options.cwd = value;
        break;
      case "--sandbox":
        options.mode = parseSandboxMode(value);
        break;
      case "--network":
        options.network = parseNetworkPolicy(value);
        break;
      default:
        throw new Error(`unknown /handoff option: ${flag}`);
    }
  }
  return options;
}

function parseSandboxArgs(args: string[]): SandboxOptions {
  const options: SandboxOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--network") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("missing value for --network");
      options.network = parseNetworkPolicy(value);
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown /sandbox option: ${arg}`);
    } else if (options.mode === undefined) {
      options.mode = parseSandboxMode(arg);
    } else {
      throw new Error(`unexpected /sandbox argument: ${arg}`);
    }
  }
  return options;
}

function parseSandboxMode(value: string): SandboxMode {
  if (sandboxModes.includes(value as SandboxMode)) return value as SandboxMode;
  throw new Error(`invalid sandbox mode: ${value}`);
}

function parseNetworkPolicy(value: string): NetworkPolicy {
  if (networkPolicies.includes(value as NetworkPolicy)) return value as NetworkPolicy;
  throw new Error(`invalid network policy: ${value}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
