#!/usr/bin/env node
import path from "node:path";
import { JsonlSessionStore } from "@pika-harness/adapters";
import type { LlmEvent, LlmRequest, ModelInfo, Provider } from "@pika-harness/core";
import { createIdGenerator } from "@pika-harness/core";
import { createSessionServer } from "./session-server.js";
import { startWebSocketServer } from "./websocket.js";

interface Options {
  port: number;
  host: string;
  dir: string;
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

const usage = `pika-server: JSON-RPC session server over WebSocket

Usage: pika-server [--port <number>] [--host <address>] [--dir <path>]

Defaults: port 7331, host 127.0.0.1, sessions in ./.pika/sessions
The default provider is a deterministic echo provider for smoke testing.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const ids = createIdGenerator();
  const store = new JsonlSessionStore(options.dir, { ids });
  const server = createSessionServer({
    store,
    provider: new EchoProvider(),
    defaultModel: "echo-model",
    ids,
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

await main();
