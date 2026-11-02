#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Editor, Key, matchesKey, ProcessTerminal, Text, TUI } from "@mariozechner/pi-tui";
import { createWebSocketClientTransport, PikaClient } from "@pika-harness/client";
import type { AgentEvent, NetworkPolicy, SandboxMode, ToolResult } from "@pika-harness/schema";

interface CliOptions {
  url: string;
  session?: string;
  cwd: string;
  prompt?: string;
  sandboxMode?: SandboxMode;
  network?: NetworkPolicy;
  help: boolean;
}

const usage = `pika: interactive protocol client for the Pika Harness server

Usage:
  pika [--url ws://127.0.0.1:7331] [--session <id>] [--cwd <path>]
       [--prompt <text>] [--sandbox-mode read-only|workspace-write|danger-full-access]
       [--network none|proxy|full]

Without --prompt the client starts an interactive pi-tui session.
Environment: PIKA_SERVER_URL overrides the default server URL.`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    url: process.env.PIKA_SERVER_URL ?? "ws://127.0.0.1:7331",
    cwd: ".",
    help: false,
  };
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
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
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
  sessionId: string;
}

async function connect(options: CliOptions): Promise<Connected> {
  const client = new PikaClient({
    transport: createWebSocketClientTransport(options.url),
    clientName: "pika-cli",
  });
  await client.initialize();
  if (options.session !== undefined) {
    const resumed = await client.resumeSession(options.session);
    return { client, sessionId: resumed.session.id };
  }
  const sandbox =
    options.sandboxMode === undefined && options.network === undefined
      ? undefined
      : {
          ...(options.sandboxMode === undefined ? {} : { mode: options.sandboxMode }),
          ...(options.network === undefined ? {} : { network: options.network }),
        };
  const started = await client.startSession({
    cwd: path.resolve(process.cwd(), options.cwd),
    ...(sandbox === undefined ? {} : { sandbox }),
  });
  return { client, sessionId: started.session.id };
}

async function runOneShot(connected: Connected, prompt: string): Promise<number> {
  const { client, sessionId } = connected;
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

async function runInteractive(connected: Connected): Promise<void> {
  const { client, sessionId } = connected;
  const tui = new TUI(new ProcessTerminal());
  const intro =
    "Pika Harness client. Type a message. /approve or /deny a pending escalation, /quit to exit.\n";
  const transcript = new Text(intro);
  const editor = new Editor(tui, theme);
  tui.addChild(transcript);
  tui.addChild(editor);
  tui.setFocus(editor);

  let log = intro;
  let pendingApprovalId: string | undefined;
  let stopped = false;

  const render = (): void => {
    transcript.setText(log);
    tui.requestRender();
  };
  const append = (text: string): void => {
    log += text;
    render();
  };
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    tui.stop();
    client.close();
    process.exit(0);
  };

  const handleInteractiveEvent = (event: AgentEvent): void => {
    if (event.type === "message_delta" && event.delta.kind === "text") {
      append(event.delta.text);
    } else if (event.type === "message_end") {
      append("\n\n");
    } else if (event.type === "tool_execution_start") {
      append(`\n[tool] ${event.name}\n`);
    } else if (event.type === "tool_execution_end" && event.result.isError) {
      append(`[tool error] ${toolErrorText(event.result)}\n`);
    } else if (event.type === "approval_requested") {
      pendingApprovalId = event.approval.id;
      append(
        `\n[approval required] ${event.approval.toolName}: ${event.approval.reason}\nType /approve or /deny.\n`,
      );
    } else if (event.type === "approval_resolved") {
      pendingApprovalId = undefined;
      append(`[approval] ${event.resolution.decision}\n`);
    } else if (event.type === "error") {
      append(`\n[error] ${event.error.message}\n`);
    } else if (event.type === "turn_end") {
      append(`[turn ${event.stopReason}]\n`);
    }
  };

  const subscription = await client.subscribe(sessionId);
  subscription.onEvent(handleInteractiveEvent);

  editor.onSubmit = (input) => {
    const text = input.trim();
    if (text === "") return;
    editor.setText("");
    if (text === "/quit") {
      shutdown();
      return;
    }
    if (text === "/approve" || text === "/deny") {
      const approvalId = pendingApprovalId;
      if (approvalId === undefined) {
        append("No pending approval.\n");
        return;
      }
      const decision = text === "/approve" ? "approve_for_session" : "deny";
      append(`[approval] submitting ${decision}\n`);
      void client.respondToApproval(sessionId, approvalId, decision).catch((error: unknown) => {
        append(`[client error] ${errorMessage(error)}\n`);
      });
      return;
    }
    editor.addToHistory(text);
    append(`> ${text}\n`);
    void client.prompt(sessionId, text).catch((error: unknown) => {
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

  tui.start();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  shutdown();
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
  const connected = await connect(options);
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
