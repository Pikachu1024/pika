import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LlmEvent, Tool } from "@pika-harness/core";
import {
  createIdGenerator,
  FauxProvider,
  MemorySessionStore,
  ToolBatchExecutor,
  ToolRegistry,
} from "@pika-harness/core";
import type { AgentEvent, JsonRpcMessage } from "@pika-harness/schema";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SessionServer } from "../src/index.js";
import { createInProcessTransportPair, createSessionServer } from "../src/index.js";

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

const textTurn: LlmEvent[] = [
  { type: "text_delta", text: "done" },
  { type: "done", stopReason: "end" },
];

function toolCallTurn(name: string, args: Record<string, unknown>): LlmEvent[] {
  return [
    { type: "tool_call_delta", index: 0, id: "call_1", name },
    { type: "tool_call_delta", index: 0, argumentsDelta: JSON.stringify(args) },
    { type: "done", stopReason: "tool_use" },
  ];
}

const noteTool: Tool = {
  name: "write_note",
  description: "Writes a note",
  schema: z.object({ text: z.string() }),
  sandbox: { write: true, arbitraryProcess: false },
  async execute(_context, args) {
    const { text } = args as { text: string };
    return { content: [{ type: "text", text: `wrote ${text}` }], isError: false };
  },
};

interface Harness {
  server: SessionServer;
  store: MemorySessionStore;
  events: AgentEvent[];
  send(method: string, params: unknown): Promise<JsonRpcMessage>;
  close(): Promise<void>;
}

interface HarnessOptions {
  turns?: LlmEvent[][];
  sandbox?: {
    defaultMode?: "read-only" | "workspace-write" | "danger-full-access";
    maxMode?: "read-only" | "workspace-write" | "danger-full-access";
    maxNetwork?: "none" | "proxy" | "full";
    approvalMode?: "untrusted" | "on-failure" | "on-request" | "never";
  };
  tools?: Tool[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pika-server-"));
  const ids = createIdGenerator();
  const store = new MemorySessionStore({ ids });
  const provider = new FauxProvider(options.turns ?? [textTurn]);
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const toolExecutor = options.tools === undefined ? undefined : new ToolBatchExecutor(registry);

  const server = createSessionServer({
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
  });

  const [serverSide, clientSide] = createInProcessTransportPair();
  server.attach(serverSide);

  const events: AgentEvent[] = [];
  clientSide.onMessage((message) => {
    if ("method" in message && message.method === "event") {
      const event = (message.params as { event: AgentEvent }).event;
      events.push(event);
    }
  });

  let nextId = 1;
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  clientSide.onMessage((message) => {
    if ("id" in message && typeof message.id === "number") {
      pending.get(message.id)?.(message);
    }
  });

  const send = (method: string, params: unknown): Promise<JsonRpcMessage> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      clientSide.send({ jsonrpc: "2.0", id, method, params });
    });
  };

  const close = async (): Promise<void> => {
    clientSide.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  };
  cleanups.push(close);

  return { server, store, events, send, close };
}

async function startSession(
  harness: Harness,
  sandbox?: { mode?: string; network?: string },
): Promise<{ sessionId: string; mode: string; network: string }> {
  const response = await harness.send("session.start", {
    cwd: ".",
    ...(sandbox === undefined ? {} : { sandbox }),
  });
  if (!("result" in response)) throw new Error(JSON.stringify(response));
  const result = response.result as {
    session: { id: string };
    sandbox: { mode: string; network: string };
  };
  await harness.send("subscribe", { sessionId: result.session.id });
  return {
    sessionId: result.session.id,
    mode: result.sandbox.mode,
    network: result.sandbox.network,
  };
}

async function waitFor(
  harness: Harness,
  predicate: (events: AgentEvent[]) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(harness.events)) {
    if (Date.now() > deadline) throw new Error("event condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("session server", () => {
  it("rejects unknown methods, invalid params, and unknown sessions", async () => {
    const harness = await createHarness();

    const unknown = await harness.send("session.explode", {});
    expect(unknown).toMatchObject({ id: 1, error: { code: -32601 } });

    const invalid = await harness.send("turn.start", { sessionId: "session_9" });
    expect(invalid).toMatchObject({ error: { code: -32602 } });

    const missingParams = await harness.send("session.resume", {});
    expect(missingParams).toMatchObject({ error: { code: -32602 } });

    const settled = await harness.send("session.resume", { sessionId: "session_9" });
    expect(settled).toMatchObject({ error: { code: 1002 } });

    const missingSession = await harness.send("subscribe", { sessionId: "session_9" });
    expect(missingSession).toMatchObject({ error: { code: 1001 } });
  });

  it("clamps requested sandbox settings to the server ceilings", async () => {
    const harness = await createHarness({
      sandbox: { maxMode: "workspace-write", maxNetwork: "none" },
    });

    const started = await startSession(harness, {
      mode: "danger-full-access",
      network: "full",
    });
    expect(started.mode).toBe("workspace-write");
    expect(started.network).toBe("none");

    const stored = await harness.store.entries(started.sessionId);
    const policy = stored.find((entry) => entry.event.type === "sandbox_policy");
    expect(policy?.event).toMatchObject({
      type: "sandbox_policy",
      mode: "workspace-write",
      network: "none",
      reason: "session started",
    });

    const narrowed = await harness.send("sandbox.mode", {
      sessionId: started.sessionId,
      mode: "read-only",
    });
    expect(narrowed).toMatchObject({
      result: { backend: "none", mode: "read-only", network: "none" },
    });
    const afterChange = await harness.store.entries(started.sessionId);
    expect(
      afterChange.filter((entry) => entry.event.type === "sandbox_policy").at(-1)?.event,
    ).toMatchObject({ mode: "read-only", reason: "client selected read-only/none" });
  });

  it("routes approval requests and executes the widened call", async () => {
    const harness = await createHarness({
      turns: [toolCallTurn("write_note", { text: "hi" }), textTurn],
      tools: [noteTool],
      sandbox: { defaultMode: "read-only", approvalMode: "on-request" },
    });
    const started = await startSession(harness);

    await harness.send("turn.start", { sessionId: started.sessionId, text: "write a note" });
    await waitFor(harness, (events) => events.some((event) => event.type === "approval_requested"));

    const approval = harness.events.find((event) => event.type === "approval_requested");
    if (approval?.type !== "approval_requested") throw new Error("missing approval");
    const response = await harness.send("approval.respond", {
      sessionId: started.sessionId,
      approvalId: approval.approval.id,
      decision: "approve_for_session",
    });
    expect(response).toMatchObject({ result: { accepted: true } });

    await waitFor(harness, (events) => events.some((event) => event.type === "settled"));

    const toolEnd = harness.events.find((event) => event.type === "tool_execution_end");
    expect(toolEnd?.type === "tool_execution_end" ? toolEnd.result : undefined).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "wrote hi" }],
    });
    const decisions = harness.events.filter((event) => event.type === "sandbox_decision");
    expect(
      decisions.map((event) => (event.type === "sandbox_decision" ? event.decision.outcome : "")),
    ).toEqual(["deny", "allow"]);
    expect(harness.events.at(-1)?.type).toBe("settled");
  });

  it("reports an unknown approval id", async () => {
    const harness = await createHarness();
    const started = await startSession(harness);
    const response = await harness.send("approval.respond", {
      sessionId: started.sessionId,
      approvalId: "approval_404",
      decision: "approve",
    });
    expect(response).toMatchObject({ error: { code: 1003 } });
  });

  it("denies a client-issued tool call through the same sandbox path", async () => {
    const harness = await createHarness({
      turns: [toolCallTurn("write_note", { text: "sneaky" }), textTurn],
      tools: [noteTool],
      sandbox: { defaultMode: "read-only", approvalMode: "never" },
    });
    const started = await startSession(harness);

    await harness.send("turn.start", { sessionId: started.sessionId, text: "write anyway" });
    await waitFor(harness, (events) => events.some((event) => event.type === "settled"));

    const denied = harness.events.find(
      (event) => event.type === "sandbox_decision" && event.decision.outcome === "deny",
    );
    expect(denied).toMatchObject({
      type: "sandbox_decision",
      decision: { backend: "none", mode: "read-only", outcome: "deny" },
    });
    const toolEnd = harness.events.find((event) => event.type === "tool_execution_end");
    expect(toolEnd?.type === "tool_execution_end" ? toolEnd.result : undefined).toMatchObject({
      isError: true,
      content: [{ type: "error", code: "sandbox_denied" }],
    });
    expect(harness.events.some((event) => event.type === "approval_requested")).toBe(false);
    expect(harness.events.at(-1)?.type).toBe("settled");
  });
});
