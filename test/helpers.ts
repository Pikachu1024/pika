import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Clock,
  LlmEvent,
  Provider,
  SessionStore,
  Tool,
  ToolExecutor,
} from "@pika-harness/core";
import {
  createIdGenerator,
  FauxProvider,
  MemorySessionStore,
  ToolBatchExecutor,
  ToolRegistry,
} from "@pika-harness/core";
import type { AgentEvent } from "@pika-harness/schema";
import type {
  ServerSandboxOptions,
  SessionServer,
  SessionServerOptions,
} from "@pika-harness/server";
import { createSessionServer } from "@pika-harness/server";

export const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export const textTurn: LlmEvent[] = [
  { type: "text_delta", text: "Hello " },
  { type: "text_delta", text: "world." },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
  { type: "done", stopReason: "end" },
];

export function toolCallTurn(name: string, args: Record<string, unknown>): LlmEvent[] {
  return [
    { type: "tool_call_delta", index: 0, id: "call_1", name },
    { type: "tool_call_delta", index: 0, argumentsDelta: JSON.stringify(args) },
    { type: "usage", usage: { inputTokens: 12, outputTokens: 4 } },
    { type: "done", stopReason: "tool_use" },
  ];
}

export interface TestServerOptions {
  provider?: Provider;
  turns?: LlmEvent[][];
  tools?: Tool[];
  sandbox?: Partial<ServerSandboxOptions>;
  approvalTimeoutMs?: number;
  toolExecutor?: ToolExecutor;
  /** Reuses an external store, for example a JSONL store on disk. */
  store?: SessionStore;
}

export interface TestServer {
  server: SessionServer;
  store: SessionStore;
  provider: Provider;
  cwd: string;
  cleanup(): Promise<void>;
}

/** Builds a deterministic server rooted in a temporary workspace. */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pika-protocol-"));
  const clock: Clock = { now: () => new Date(FIXED_TIMESTAMP) };
  const ids = createIdGenerator();
  const store = options.store ?? new MemorySessionStore({ ids });
  const provider = options.provider ?? new FauxProvider(options.turns ?? [textTurn]);

  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);

  let toolExecutor = options.toolExecutor;
  if (toolExecutor === undefined && options.tools !== undefined) {
    toolExecutor = new ToolBatchExecutor(registry);
  }

  const serverOptions: SessionServerOptions = {
    store,
    provider,
    defaultCwd: cwd,
    defaultModel: "faux-model",
    clock,
    ids,
    ...(toolExecutor === undefined ? {} : { toolExecutor }),
    ...(options.tools === undefined ? {} : { tools: registry.toProviderTools() }),
    sandbox: {
      backend: "none",
      defaultMode: "workspace-write",
      defaultNetwork: "none",
      ...options.sandbox,
    },
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
  };
  const server = createSessionServer(serverOptions);

  return {
    server,
    store,
    provider,
    cwd,
    cleanup: async () => {
      await server.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

/** Collects subscription events until the runtime settles. */
export async function collectUntilSettled(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.type === "settled") return collected;
  }
  return collected;
}

/** Waits for a specific event type on an async event stream. */
export async function waitForEvent<T extends AgentEvent["type"]>(
  events: AsyncIterable<AgentEvent>,
  type: T,
): Promise<Extract<AgentEvent, { type: T }>> {
  for await (const event of events) {
    if (event.type === type) return event as Extract<AgentEvent, { type: T }>;
  }
  throw new Error(`stream ended before ${type}`);
}
