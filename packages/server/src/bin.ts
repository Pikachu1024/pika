#!/usr/bin/env bun
import path from "node:path";
import {
  createOpenAiCompatibleModel,
  JsonlSessionStore,
  PiAiProvider,
} from "@pika-harness/adapters";
import type { LlmEvent, LlmMessage, LlmRequest, ModelInfo, Provider } from "@pika-harness/core";
import { createIdGenerator } from "@pika-harness/core";
import type { CompactionFactory, SessionContext } from "./session-server.js";
import { createSessionServer } from "./session-server.js";
import { startWebSocketServer } from "./websocket.js";

interface LlmOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
}

interface Options {
  port: number;
  host: string;
  dir: string;
  llm: LlmOptions | undefined;
  help: boolean;
}

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

function parseArgs(argv: string[]): Options {
  const options: Options = {
    port: Number(process.env.PIKA_PORT ?? 7331),
    host: process.env.PIKA_HOST ?? "127.0.0.1",
    dir: process.env.PIKA_SESSION_DIR ?? path.join(process.cwd(), ".pika", "sessions"),
    llm: llmFromEnv(),
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

/** Reads the optional OpenAI-compatible provider configuration. */
function llmFromEnv(): LlmOptions | undefined {
  const provider = process.env.PIKA_PROVIDER ?? "echo";
  if (provider === "echo") return undefined;
  if (provider !== "openai" && provider !== "openai-compatible") {
    throw new Error(`unsupported PIKA_PROVIDER: ${provider}`);
  }
  const baseUrl = process.env.PIKA_LLM_BASE_URL;
  const apiKey = process.env.PIKA_LLM_API_KEY;
  const model = process.env.PIKA_LLM_MODEL;
  if (baseUrl === undefined || model === undefined) {
    throw new Error("PIKA_LLM_BASE_URL and PIKA_LLM_MODEL are required when PIKA_PROVIDER=openai");
  }
  return {
    baseUrl,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
    model,
    contextWindow: Number(process.env.PIKA_LLM_CONTEXT_WINDOW ?? 32_768),
    maxTokens: Number(process.env.PIKA_LLM_MAX_TOKENS ?? 4_096),
  };
}

const usage = `pika-server: JSON-RPC session server over WebSocket

Usage: pika-server [--port <number>] [--host <address>] [--dir <path>]

Defaults: port 7331, host 127.0.0.1, sessions in ./.pika/sessions
The default provider is a deterministic echo provider for smoke testing.
Set PIKA_PROVIDER=openai (or openai-compatible) plus PIKA_LLM_BASE_URL,
PIKA_LLM_API_KEY, and PIKA_LLM_MODEL to use an OpenAI-compatible endpoint.
Optional: PIKA_LLM_CONTEXT_WINDOW, PIKA_LLM_MAX_TOKENS.`;

/** Builds a per-session provider from the client-supplied or environment LLM config. */
function createProviderFactory(
  defaults: LlmOptions | undefined,
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
function createCompactionFactory(defaults: LlmOptions | undefined): CompactionFactory {
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const ids = createIdGenerator();
  const store = new JsonlSessionStore(options.dir, { ids });
  const provider = createProviderFactory(options.llm);
  const server = createSessionServer({
    store,
    provider,
    defaultModel: options.llm?.model ?? "echo-model",
    ids,
    compaction: createCompactionFactory(options.llm),
    sandbox: { backend: "none", defaultMode: "workspace-write", defaultNetwork: "none" },
  });

  const listener = await startWebSocketServer({
    port: options.port,
    host: options.host,
    onConnection: (transport) => {
      server.attach(transport);
    },
  });
  process.stdout.write(`pika-server listening on ${listener.url}\n`);

  const shutdown = async (): Promise<void> => {
    await listener.close();
    await server.close();
  };
  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
