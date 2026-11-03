#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  createOpenAiCompatibleModel,
  JsonlSessionStore,
  PiAiProvider,
} from "@pika-harness/adapters";
import type {
  IdGenerator,
  LlmEvent,
  LlmMessage,
  LlmRequest,
  ModelInfo,
  Provider,
} from "@pika-harness/core";
import type { ServeSandboxDependencies, ServeSandboxSelection } from "./serve-sandbox.js";
import {
  createServeSandbox,
  isServeSandboxSelection,
  SERVE_SANDBOX_SELECTIONS,
} from "./serve-sandbox.js";
import { createServeTooling } from "./serve-tooling.js";
import type { CompactionFactory, SessionContext } from "./session-server.js";
import { createSessionServer } from "./session-server.js";
import { startWebSocketServer } from "./websocket.js";

export interface ServeLlmOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
}

export interface ServeOptions {
  port: number;
  host: string;
  dir: string;
  /** Sandbox backend for tool execution; defaults to `auto`. */
  sandboxBackend?: ServeSandboxSelection;
  llm?: ServeLlmOptions;
  /** When set, WebSocket clients must present this token to connect. */
  token?: string;
  /** Internal flag used by the launcher so the server exits with its parent. */
  exitOnParentStdinClose?: boolean;
  /** Internal: injectable sandbox factories so tests do not depend on the host. */
  sandboxDeps?: ServeSandboxDependencies;
  help: boolean;
}

export interface RunningServe {
  url: string;
  close(): Promise<void>;
}

export const serveUsage = `pika serve: JSON-RPC session server over WebSocket

Usage: pika serve [--port <number>] [--host <address>] [--dir <path>] [--sandbox-backend <backend>]

Defaults: port 7331, host 127.0.0.1, sessions in $PIKA_HOME/sessions (~/.pika/sessions)
Set PIKA_HOME to relocate the Pika home directory, or PIKA_SESSION_DIR/--dir to
override the session directory itself.
Sandbox backends: auto (default), none, seatbelt, bwrap, docker.
auto selects seatbelt on macOS and bwrap on Linux, and fails when neither is
available. seatbelt, bwrap, and docker must be installed when requested
explicitly. none disables OS isolation; only the in-process path policy applies.
Set PIKA_SANDBOX_BACKEND or pass --sandbox-backend to choose the backend.
The default provider is a deterministic echo provider for smoke testing.
Set PIKA_PROVIDER=openai (or openai-compatible) plus PIKA_LLM_BASE_URL,
PIKA_LLM_API_KEY, and PIKA_LLM_MODEL to use an OpenAI-compatible endpoint.
Optional: PIKA_LLM_CONTEXT_WINDOW, PIKA_LLM_MAX_TOKENS.
When PIKA_SERVER_TOKEN is set, WebSocket connections must pass ?token=<value>.
--exit-on-parent-stdin-close is internal and used by the pika launcher.`;

/** Deterministic demo provider that echoes the last user message. */
class EchoProvider implements Provider {
  models(): ModelInfo[] {
    return [{ id: "echo-model", provider: "echo", contextWindow: 32_000 }];
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    const text = lastUserText(request.messages);
    for (const chunk of [`echo: ${text}`]) {
      if (signal.aborted) return;
      yield { type: "text_delta", text: chunk };
    }
    yield { type: "done", stopReason: "end" };
  }
}

function lastUserText(messages: LlmRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
  }
  return "";
}

/** Parses server flags and environment defaults. */
export function parseServeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ServeOptions {
  const token = env.PIKA_SERVER_TOKEN;
  const llm = llmFromEnv(env);
  const options: ServeOptions = {
    port: Number(env.PIKA_PORT ?? 7331),
    host: env.PIKA_HOST ?? "127.0.0.1",
    dir: env.PIKA_SESSION_DIR ?? defaultSessionDirectory(env),
    sandboxBackend: sandboxBackendValue(env.PIKA_SANDBOX_BACKEND),
    ...(llm === undefined ? {} : { llm }),
    ...(token === undefined || token.length === 0 ? {} : { token }),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--port":
        if (next !== undefined) options.port = Number(next);
        index += 1;
        break;
      case "--host":
        if (next !== undefined) options.host = next;
        index += 1;
        break;
      case "--dir":
        if (next !== undefined) options.dir = next;
        index += 1;
        break;
      case "--sandbox-backend":
        if (next === undefined) {
          throw new Error("missing value for --sandbox-backend");
        }
        options.sandboxBackend = sandboxBackendValue(next);
        index += 1;
        break;
      case "--exit-on-parent-stdin-close":
        options.exitOnParentStdinClose = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error(`invalid port: ${options.port}`);
  }
  return options;
}

function defaultSessionDirectory(env: NodeJS.ProcessEnv): string {
  if (env.PIKA_HOME !== undefined && env.PIKA_HOME.length > 0) {
    return path.join(path.resolve(env.PIKA_HOME), "sessions");
  }
  const home = env.HOME === undefined || env.HOME.length === 0 ? homedir() : env.HOME;
  return path.join(home, ".pika", "sessions");
}

function sandboxBackendValue(value: string | undefined): ServeSandboxSelection {
  const requested = value ?? "auto";
  if (!isServeSandboxSelection(requested)) {
    throw new Error(
      `invalid sandbox backend: ${requested}; expected one of: ${SERVE_SANDBOX_SELECTIONS.join(", ")}`,
    );
  }
  return requested;
}

/** Reads the optional OpenAI-compatible provider configuration. */
function llmFromEnv(env: NodeJS.ProcessEnv): ServeLlmOptions | undefined {
  const provider = env.PIKA_PROVIDER ?? "echo";
  if (provider === "echo") return undefined;
  if (provider !== "openai" && provider !== "openai-compatible") {
    throw new Error(`unsupported PIKA_PROVIDER: ${provider}`);
  }
  const baseUrl = env.PIKA_LLM_BASE_URL;
  const apiKey = env.PIKA_LLM_API_KEY;
  const model = env.PIKA_LLM_MODEL;
  if (baseUrl === undefined || model === undefined) {
    throw new Error("PIKA_LLM_BASE_URL and PIKA_LLM_MODEL are required when PIKA_PROVIDER=openai");
  }
  return {
    baseUrl,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    model,
    contextWindow: Number(env.PIKA_LLM_CONTEXT_WINDOW ?? 32_768),
    maxTokens: Number(env.PIKA_LLM_MAX_TOKENS ?? 4_096),
  };
}

/** Builds a per-session provider from the client-supplied or environment LLM config. */
function createProviderFactory(
  defaults: ServeLlmOptions | undefined,
): (context: SessionContext) => Provider {
  const echo = new EchoProvider();
  return (context) => {
    const llm = context.llm;
    const baseUrl = llm?.baseUrl ?? defaults?.baseUrl;
    const model = llm?.model ?? defaults?.model;
    if (baseUrl === undefined || model === undefined) return echo;
    const apiKey = llm?.apiKey ?? defaults?.apiKey;
    return new PiAiProvider({
      model: createOpenAiCompatibleModel({
        id: model,
        baseUrl,
        contextWindow: llm?.contextWindow ?? defaults?.contextWindow ?? 32_768,
        maxTokens: llm?.maxTokens ?? defaults?.maxTokens ?? 4_096,
      }),
      ...(apiKey === undefined ? {} : { apiKey }),
    });
  };
}

/** Builds per-session compaction settings from the resolved LLM endpoint. */
function createCompactionFactory(defaults: ServeLlmOptions | undefined): CompactionFactory {
  return (context, provider) => {
    const llm = context.llm ?? defaults;
    if (llm === undefined) return undefined;
    const contextWindow = llm.contextWindow ?? 32_768;
    const maxTokens = llm.maxTokens ?? 4_096;
    return {
      contextWindow,
      reserveTokens: Math.min(maxTokens, Math.max(1, Math.floor(contextWindow / 4))),
      keepRecentTurns: 2,
      summarize: (messages) => summarizeWithProvider(provider, context.model, messages),
    };
  };
}

/** Summarizes with no tools so summarization cannot execute anything. */
async function summarizeWithProvider(
  provider: Provider,
  model: string,
  messages: LlmMessage[],
): Promise<string> {
  const controller = new AbortController();
  const request: LlmRequest = {
    model,
    system: "Summarize the conversation so far for later context. Reply with plain text only.",
    messages,
    tools: [],
  };
  let summary = "";
  for await (const event of provider.stream(request, controller.signal)) {
    if (event.type === "text_delta") {
      summary += event.text;
    } else if (event.type === "error") {
      throw new Error(event.error.message);
    } else if (event.type === "done") {
      break;
    }
  }
  return summary;
}

/** Starts a session server and its WebSocket listener. */
export async function startServe(options: ServeOptions): Promise<RunningServe> {
  const sandbox = await createServeSandbox(
    options.sandboxBackend ?? "auto",
    options.sandboxDeps ?? {},
  );
  // Persistent session directories outlive a single server run, so ids must not reset per process.
  const ids: IdGenerator = { next: (prefix) => `${prefix}_${randomUUID()}` };
  const store = new JsonlSessionStore(options.dir, { ids });
  const provider = createProviderFactory(options.llm);
  const server = createSessionServer({
    store,
    provider,
    defaultModel: options.llm?.model ?? "echo-model",
    ids,
    compaction: createCompactionFactory(options.llm),
    tooling: createServeTooling({ sessionsDir: options.dir, executor: sandbox.executor }),
    sandbox: {
      backend: sandbox.backend,
      defaultMode: "workspace-write",
      defaultNetwork: "none",
    },
  });

  const listener = await startWebSocketServer({
    port: options.port,
    host: options.host,
    ...(options.token === undefined ? {} : { token: options.token }),
    onConnection: (transport) => {
      server.attach(transport);
    },
  });

  return {
    url: listener.url,
    close: async () => {
      await listener.close();
      await server.close();
    },
  };
}

/** Runs the server until a signal or parent-stdin close arrives. */
export async function serveMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseServeArgs(argv, env);
  if (options.help) {
    process.stdout.write(`${serveUsage}\n`);
    return;
  }
  const running = await startServe(options);
  process.stdout.write(`pika-server listening on ${running.url}\n`);
  await waitForShutdown(running, options.exitOnParentStdinClose === true);
}

function waitForShutdown(running: RunningServe, exitOnParentStdinClose: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const cleanup = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdin.off("end", onStdinClose);
      process.stdin.off("close", onStdinClose);
      if (exitOnParentStdinClose) process.stdin.pause();
    };
    const shutdown = (): void => {
      if (done) return;
      done = true;
      cleanup();
      void running.close().then(resolve, resolve);
    };
    const onSignal = (): void => shutdown();
    const onStdinClose = (): void => shutdown();

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (exitOnParentStdinClose) {
      process.stdin.resume();
      process.stdin.on("end", onStdinClose);
      process.stdin.on("close", onStdinClose);
      if (process.stdin.readableEnded) shutdown();
    }
  });
}
