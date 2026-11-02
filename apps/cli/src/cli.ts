#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import type { SelectItem, Terminal } from "@mariozechner/pi-tui";
import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import { createWebSocketClientTransport, PikaClient } from "@pika-harness/client";
import type {
  EffectiveSandbox,
  LlmEndpoint,
  NetworkPolicy,
  SandboxMode,
  SessionSummary,
  ToolResult,
} from "@pika-harness/schema";
import type { CatalogState } from "./catalog.js";
import {
  catalogPresets,
  environmentPreset,
  initialAlias,
  loadCatalog,
  resolvePreset,
} from "./catalog.js";
import { createAutocomplete, createCommands, dispatchCommand } from "./commands/index.js";
import type { ControllerUi } from "./controller.js";
import { SessionController } from "./controller.js";

interface CliOptions {
  url: string;
  session?: string;
  cwd: string;
  prompt?: string;
  sandboxMode?: SandboxMode;
  network?: NetworkPolicy;
  llm?: LlmEndpoint;
  help: boolean;
}

const usage = `pika: interactive protocol client for the Pika Harness server

Usage:
  pika [--url ws://127.0.0.1:7331] [--session <id>] [--cwd <path>]
       [--prompt <text>] [--sandbox-mode read-only|workspace-write|danger-full-access]
       [--network none|proxy|full]
       [--llm-base-url <url>] [--llm-model <model>] [--llm-api-key <key>]
       [--llm-context-window <tokens>] [--llm-max-tokens <tokens>]

Without --prompt the client starts an interactive pi-tui session.
Slash commands: /help, /models, /model, /config, /status, /usage, /context,
/new, /sessions, /resume, /fork, /handoff, /sandbox, /compact, /btw,
/approve, /deny, /quit.
Model presets load from .pika/models.json or PIKA_MODELS_FILE.
Environment: PIKA_SERVER_URL, PIKA_MODELS_FILE, PIKA_LLM_BASE_URL,
PIKA_LLM_MODEL, PIKA_LLM_API_KEY, PIKA_LLM_CONTEXT_WINDOW, PIKA_LLM_MAX_TOKENS.
`;

/** Parses CLI flags, falling back to environment variables for LLM settings. */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    url: process.env.PIKA_SERVER_URL ?? "ws://127.0.0.1:7331",
    cwd: ".",
    help: false,
  };
  let llmBaseUrl = envString("PIKA_LLM_BASE_URL");
  let llmModel = envString("PIKA_LLM_MODEL");
  let llmApiKey = envString("PIKA_LLM_API_KEY");
  let llmContextWindow = envInt("PIKA_LLM_CONTEXT_WINDOW");
  let llmMaxTokens = envInt("PIKA_LLM_MAX_TOKENS");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--url":
        if (next !== undefined) options.url = next;
        index += 1;
        break;
      case "--session":
        if (next !== undefined) options.session = next;
        index += 1;
        break;
      case "--cwd":
        if (next !== undefined) options.cwd = next;
        index += 1;
        break;
      case "--prompt":
        if (next !== undefined) options.prompt = next;
        index += 1;
        break;
      case "--sandbox-mode":
        if (next !== undefined) options.sandboxMode = parseMode(next);
        index += 1;
        break;
      case "--network":
        if (next !== undefined) options.network = parseNetwork(next);
        index += 1;
        break;
      case "--llm-base-url":
        if (next !== undefined) llmBaseUrl = next;
        index += 1;
        break;
      case "--llm-model":
        if (next !== undefined) llmModel = next;
        index += 1;
        break;
      case "--llm-api-key":
        if (next !== undefined) llmApiKey = next;
        index += 1;
        break;
      case "--llm-context-window":
        if (next !== undefined) llmContextWindow = parsePositiveInt(next, "--llm-context-window");
        index += 1;
        break;
      case "--llm-max-tokens":
        if (next !== undefined) llmMaxTokens = parsePositiveInt(next, "--llm-max-tokens");
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  const llm = buildLlm({
    ...(llmBaseUrl === undefined ? {} : { baseUrl: llmBaseUrl }),
    ...(llmModel === undefined ? {} : { model: llmModel }),
    ...(llmApiKey === undefined ? {} : { apiKey: llmApiKey }),
    ...(llmContextWindow === undefined ? {} : { contextWindow: llmContextWindow }),
    ...(llmMaxTokens === undefined ? {} : { maxTokens: llmMaxTokens }),
  });
  if (llm !== undefined) options.llm = llm;
  return options;
}

interface LlmInput {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
}

function buildLlm(input: LlmInput): LlmEndpoint | undefined {
  if (input.baseUrl === undefined && input.model === undefined) return undefined;
  if (input.baseUrl === undefined || input.model === undefined) {
    throw new Error("--llm-base-url and --llm-model must be provided together");
  }
  return {
    baseUrl: input.baseUrl,
    model: input.model,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
  };
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function envInt(name: string): number | undefined {
  const value = envString(name);
  return value === undefined ? undefined : parsePositiveInt(value, name);
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseMode(value: string): SandboxMode {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  throw new Error(`invalid sandbox mode: ${value}`);
}

function parseNetwork(value: string): NetworkPolicy {
  if (value === "none" || value === "proxy" || value === "full") return value;
  throw new Error(`invalid network policy: ${value}`);
}

interface Connected {
  client: PikaClient;
  catalog: CatalogState;
  cwd: string;
  session: SessionSummary;
  sandbox: EffectiveSandbox;
  alias?: string;
}

async function connect(
  options: CliOptions,
  cwd: string,
  catalog: CatalogState,
): Promise<Connected> {
  const client = new PikaClient({
    transport: createWebSocketClientTransport(options.url),
    clientName: "pika-cli",
  });
  await client.initialize();
  if (options.session !== undefined) {
    const resumed = await client.resumeSession(options.session, options.llm);
    const alias = catalogPresets(catalog).find(
      (preset) => preset.model === resumed.session.model,
    )?.name;
    return {
      client,
      catalog,
      cwd,
      session: resumed.session,
      sandbox: resumed.sandbox,
      ...(alias === undefined ? {} : { alias }),
    };
  }
  const alias = initialAlias(catalog);
  const resolved = alias === undefined ? undefined : resolvePreset(catalog, alias, process.env);
  const sandbox =
    options.sandboxMode === undefined && options.network === undefined
      ? undefined
      : {
          ...(options.sandboxMode === undefined ? {} : { mode: options.sandboxMode }),
          ...(options.network === undefined ? {} : { network: options.network }),
        };
  const started = await client.startSession({
    cwd,
    ...(resolved === undefined ? {} : { model: resolved.preset.model }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(resolved === undefined
      ? options.llm === undefined
        ? {}
        : { llm: options.llm }
      : { llm: resolved.endpoint }),
  });
  return {
    client,
    catalog,
    cwd,
    session: started.session,
    sandbox: started.sandbox,
    ...(alias === undefined ? {} : { alias }),
  };
}

async function runOneShot(connected: Connected, prompt: string): Promise<number> {
  const { client, session } = connected;
  const sessionId = session.id;
  const subscription = await client.subscribe(sessionId);
  await client.prompt(sessionId, prompt);
  let failed = false;

  for await (const event of subscription) {
    if (event.type === "message_delta" && event.delta.kind === "text") {
      process.stdout.write(event.delta.text);
    } else if (event.type === "tool_execution_start") {
      process.stderr.write(`\n[tool] ${event.name}\n`);
    } else if (event.type === "tool_execution_end" && event.result.isError) {
      process.stderr.write(`[tool error] ${toolErrorText(event.result)}\n`);
    } else if (event.type === "approval_requested") {
      process.stderr.write(
        `\n[approval required] ${event.approval.toolName}: ${event.approval.reason}\n`,
      );
      await client.respondToApproval(sessionId, event.approval.id, "deny");
      process.stderr.write("[approval] denied; run interactively to approve escalations\n");
    } else if (event.type === "error") {
      failed = true;
      process.stderr.write(`\n[error] ${event.error.message}\n`);
    } else if (event.type === "settled") {
      process.stdout.write("\n");
      return failed ? 1 : 0;
    }
  }
  return 1;
}

function toolErrorText(result: ToolResult): string {
  const error = result.content.find((part) => part.type === "error");
  return error === undefined ? "unknown tool failure" : error.message;
}

const theme = {
  borderColor: (text: string): string => `\x1b[2m${text}\x1b[0m`,
  selectList: {
    selectedPrefix: (text: string): string => `\x1b[36m${text}\x1b[0m`,
    selectedText: (text: string): string => `\x1b[1m${text}\x1b[0m`,
    description: (text: string): string => `\x1b[2m${text}\x1b[0m`,
    scrollInfo: (text: string): string => `\x1b[2m${text}\x1b[0m`,
    noMatch: (text: string): string => `\x1b[2m${text}\x1b[0m`,
  },
};

export interface InteractiveOptions {
  terminal?: Terminal;
  onExit?: () => void;
}

export async function runInteractive(
  connected: Connected,
  options: InteractiveOptions = {},
): Promise<void> {
  const tui = new TUI(options.terminal ?? new ProcessTerminal());
  const intro = "Pika Harness client. Type a message or /help for commands. /quit exits.\n";
  const transcript = new Text(intro);
  const statusLine = new Text("");
  const editor = new Editor(tui, theme);
  tui.addChild(transcript);
  tui.addChild(statusLine);
  tui.addChild(editor);
  tui.setFocus(editor);

  let log = intro;
  let stopped = false;
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const render = (): void => {
    transcript.setText(log);
    tui.requestRender();
  };
  const append = (text: string): void => {
    log += text;
    render();
  };
  const select = (title: string, items: SelectItem[]): Promise<string | undefined> =>
    new Promise((resolve) => {
      const heading = new Text(title);
      const list = new SelectList(items, 8, theme.selectList);
      let done = false;
      const finish = (value: string | undefined): void => {
        if (done) return;
        done = true;
        tui.removeChild(heading);
        tui.removeChild(list);
        tui.setFocus(editor);
        tui.requestRender();
        resolve(value);
      };
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(undefined);
      tui.addChild(heading);
      tui.addChild(list);
      tui.setFocus(list);
      tui.requestRender();
    });

  const ui: ControllerUi = {
    append,
    setStatus: (text) => {
      statusLine.setText(text);
      tui.requestRender();
    },
    select,
    resetTranscript: () => {
      log = "";
      render();
    },
  };

  let controller: SessionController | undefined;
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    void controller?.dispose();
    connected.client.close();
    tui.stop();
    resolveExit();
    if (options.onExit === undefined) {
      process.exit(0);
    } else {
      options.onExit();
    }
  };

  const activeController = new SessionController({
    client: connected.client,
    ui,
    catalog: connected.catalog,
    cwd: connected.cwd,
    env: process.env,
    initial: {
      session: connected.session,
      sandbox: connected.sandbox,
      ...(connected.alias === undefined ? {} : { alias: connected.alias }),
    },
    onQuit: shutdown,
  });
  controller = activeController;
  const commands = createCommands(activeController);
  editor.setAutocompleteProvider(createAutocomplete(commands, connected.cwd));
  await activeController.start();

  editor.onSubmit = (input) => {
    const text = input.trim();
    if (text === "") return;
    editor.setText("");
    editor.addToHistory(text);
    void (async () => {
      if (await dispatchCommand(commands, text, activeController)) return;
      append(`> ${text}\n`);
      await activeController.prompt(text);
    })().catch((error: unknown) => {
      append(`[client error] ${errorMessage(error)}\n`);
    });
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      shutdown();
      return { consume: true };
    }
    return undefined;
  });

  if (options.onExit === undefined) {
    const onSignal = (): void => shutdown();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  tui.start();
  await exited;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const cwd = path.resolve(process.cwd(), options.cwd);
  const catalog = await loadInitialCatalog(cwd, options.llm);
  const connected = await connect(options, cwd, catalog);
  try {
    if (options.prompt !== undefined) {
      process.exitCode = await runOneShot(connected, options.prompt);
    } else {
      await runInteractive(connected);
    }
  } finally {
    connected.client.close();
  }
}

async function loadInitialCatalog(
  cwd: string,
  llm: LlmEndpoint | undefined,
): Promise<CatalogState> {
  try {
    return await loadCatalog({ cwd, env: process.env, ...(llm === undefined ? {} : { llm }) });
  } catch (error) {
    process.stderr.write(`[catalog] ${errorMessage(error)}\n`);
    return {
      presets: [],
      ...(llm === undefined ? {} : { envPreset: environmentPreset(llm), envEndpoint: llm }),
    };
  }
}
