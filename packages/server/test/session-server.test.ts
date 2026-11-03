import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LlmEvent, Provider, Tool } from "@pika-harness/core";
import {
  createIdGenerator,
  FauxProvider,
  MemorySessionStore,
  ToolBatchExecutor,
  ToolRegistry,
} from "@pika-harness/core";
import type { AgentEvent, JsonRpcMessage, ProtocolTransport } from "@pika-harness/schema";
import { z } from "zod";
import type {
  CompactionFactory,
  SessionContext,
  SessionServer,
  SessionTooling,
  SessionToolingFactory,
} from "../src/index.js";
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

const longTurn: LlmEvent[] = [
  { type: "text_delta", text: "x".repeat(400) },
  { type: "done", stopReason: "end" },
];

const summaryTurn: LlmEvent[] = [
  { type: "text_delta", text: "short summary" },
  { type: "done", stopReason: "end" },
];

const sideTurn: LlmEvent[] = [
  { type: "text_delta", text: "side answer" },
  { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
  { type: "done", stopReason: "end" },
];

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release() };
}

class GatedProvider implements Provider {
  readonly started = deferred();
  readonly release = deferred();

  models() {
    return [{ id: "faux-model", provider: "faux", contextWindow: 32_768 }];
  }

  stream(
    _request: Parameters<Provider["stream"]>[0],
    signal: AbortSignal,
  ): AsyncIterable<LlmEvent> {
    return this.#run(signal);
  }

  async *#run(signal: AbortSignal): AsyncIterable<LlmEvent> {
    yield { type: "text_delta", text: "working" };
    this.started.resolve();
    await this.release.promise;
    if (signal.aborted) return;
    yield { type: "done", stopReason: "end" };
  }
}

interface Harness {
  server: SessionServer;
  store: MemorySessionStore;
  cwd: string;
  serverTransport: ProtocolTransport;
  clientTransport: ProtocolTransport;
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
  tooling?: SessionTooling | SessionToolingFactory;
  provider?: Provider | ((context: SessionContext) => Provider);
  compaction?: CompactionFactory;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pika-server-"));
  const ids = createIdGenerator();
  const store = new MemorySessionStore({ ids });
  const provider =
    options.provider === undefined
      ? new FauxProvider(options.turns ?? [textTurn])
      : options.provider;
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const tooling =
    options.tooling ??
    (options.tools === undefined
      ? undefined
      : {
          tools: registry.toProviderTools(),
          executor: new ToolBatchExecutor(registry),
        });

  const server = createSessionServer({
    store,
    provider,
    defaultCwd: cwd,
    defaultModel: "faux-model",
    clock,
    ids,
    ...(tooling === undefined ? {} : { tooling }),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
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

  return {
    server,
    store,
    cwd,
    serverTransport: serverSide,
    clientTransport: clientSide,
    events,
    send,
    close,
  };
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
    expect(settled).toMatchObject({ error: { code: 1001 } });

    const missingSession = await harness.send("subscribe", { sessionId: "session_9" });
    expect(missingSession).toMatchObject({ error: { code: 1001 } });
  });

  it("answers non-object JSON frames with an invalid-request error", async () => {
    const harness = await createHarness();
    const replies: JsonRpcMessage[] = [];
    harness.clientTransport.onMessage((message) => replies.push(message));

    for (const frame of [null, "hello", 42]) {
      await expect(
        harness.server.handle(harness.serverTransport, frame as unknown as JsonRpcMessage),
      ).resolves.toBeUndefined();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(replies).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    ]);
  });

  it("distinguishes an unsettled session from a missing session", async () => {
    const harness = await createHarness();
    await harness.store.create({
      id: "session_unsettled",
      cwd: "/tmp",
      model: "faux-model",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await harness.send("session.resume", { sessionId: "session_unsettled" });
    expect(response).toMatchObject({ error: { code: 1002 } });
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

  it("passes the client LLM endpoint to the provider factory without persisting its key", async () => {
    const contexts: SessionContext[] = [];
    const harness = await createHarness({
      provider: (context) => {
        contexts.push(context);
        return new FauxProvider([textTurn]);
      },
    });

    const llm = {
      baseUrl: "http://127.0.0.1:59000/v1",
      model: "local-model",
      apiKey: "secret-key",
    };
    const response = await harness.send("session.start", { cwd: ".", llm });
    expect(response).toMatchObject({ result: { session: { model: "local-model" } } });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ model: "local-model", llm });

    if (!("result" in response)) throw new Error(JSON.stringify(response));
    const sessionId = (response.result as { session: { id: string } }).session.id;
    const stored = await harness.store.entries(sessionId);
    expect(JSON.stringify(stored)).not.toContain("secret-key");
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

  it("resolves tooling once per session and uses its declarations and executor together", async () => {
    const provider = new FauxProvider([toolCallTurn("write_note", { text: "hi" }), textTurn]);
    const seen: Array<{ sessionId: string; workspaceRoot: string }> = [];
    const executed: string[] = [];
    const harness = await createHarness({
      provider,
      tooling: (context, policy) => {
        seen.push({ sessionId: context.sessionId, workspaceRoot: policy.workspaceRoot });
        return {
          tools: [{ name: "write_note", description: "Writes a note", parameters: {} }],
          executor: {
            async execute(calls) {
              executed.push(...calls.map((call) => call.name));
              return calls.map((call) => ({
                toolCallId: call.id,
                content: [{ type: "text" as const, text: "paired result" }],
                isError: false,
              }));
            },
          },
        };
      },
    });
    const started = await startSession(harness);

    await harness.send("turn.start", { sessionId: started.sessionId, text: "write a note" });
    await waitFor(harness, (events) => events.some((event) => event.type === "settled"));

    expect(seen).toEqual([
      { sessionId: started.sessionId, workspaceRoot: path.resolve(harness.cwd) },
    ]);
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(["write_note"]);
    expect(executed).toEqual(["write_note"]);
    const toolEnd = harness.events.find((event) => event.type === "tool_execution_end");
    expect(toolEnd?.type === "tool_execution_end" ? toolEnd.result : undefined).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "paired result" }],
    });
  });

  it("returns an explicit not-configured result when no tooling is provided", async () => {
    const harness = await createHarness({
      turns: [toolCallTurn("write_note", { text: "hi" }), textTurn],
    });
    const started = await startSession(harness);

    await harness.send("turn.start", { sessionId: started.sessionId, text: "write a note" });
    await waitFor(harness, (events) => events.some((event) => event.type === "settled"));

    const toolEnd = harness.events.find((event) => event.type === "tool_execution_end");
    expect(toolEnd?.type === "tool_execution_end" ? toolEnd.result : undefined).toMatchObject({
      isError: true,
      content: [{ type: "error", code: "no_executor" }],
    });
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

  it("compacts manually and answers side questions without recording entries", async () => {
    const provider = new FauxProvider([longTurn, longTurn, summaryTurn, sideTurn]);
    const compaction: CompactionFactory = (_context, streamProvider) => ({
      contextWindow: 1_000_000,
      reserveTokens: 0,
      keepRecentTurns: 1,
      summarize: async (messages) => {
        let text = "";
        for await (const event of streamProvider.stream(
          { model: "faux-model", system: "", messages, tools: [] },
          new AbortController().signal,
        )) {
          if (event.type === "text_delta") text += event.text;
          else if (event.type === "error") throw new Error(event.error.message);
          else if (event.type === "done") break;
        }
        return text;
      },
    });
    const harness = await createHarness({ provider: () => provider, compaction });
    const started = await startSession(harness);

    await harness.send("turn.start", { sessionId: started.sessionId, text: "first" });
    await waitFor(harness, (events) => settledCount(events) === 1);
    await harness.send("turn.start", { sessionId: started.sessionId, text: "second" });
    await waitFor(harness, (events) => settledCount(events) === 2);

    const compacted = await harness.send("session.compact", { sessionId: started.sessionId });
    expect(compacted).toMatchObject({ result: { compacted: true } });
    const result = (compacted as { result: { tokensBefore: number; tokensAfter: number } }).result;
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
    const start = harness.events.find((event) => event.type === "compaction_start");
    expect(start?.type === "compaction_start" ? start.reason : undefined).toBe("manual");
    const end = harness.events.find((event) => event.type === "compaction_end");
    expect(end?.type === "compaction_end" ? end.tokensAfter : -1).toBe(result.tokensAfter);

    const entriesBefore = await harness.store.entries(started.sessionId);
    const btw = await harness.send("session.btw", {
      sessionId: started.sessionId,
      text: "why?",
    });
    expect(btw).toMatchObject({
      result: { text: "side answer", usage: { inputTokens: 3, outputTokens: 2 } },
    });
    const entriesAfter = await harness.store.entries(started.sessionId);
    expect(entriesAfter).toEqual(entriesBefore);
    expect(JSON.stringify(entriesAfter)).not.toContain("side answer");
  });

  it("rejects compact, side questions, and forks while the source is busy", async () => {
    const gated = new GatedProvider();
    const harness = await createHarness({ provider: () => gated });
    const started = await startSession(harness);

    await harness.send("turn.start", { sessionId: started.sessionId, text: "busy" });
    await gated.started.promise;

    const compact = await harness.send("session.compact", { sessionId: started.sessionId });
    expect(compact).toMatchObject({ error: { code: 1002 } });
    const btw = await harness.send("session.btw", {
      sessionId: started.sessionId,
      text: "hello?",
    });
    expect(btw).toMatchObject({ error: { code: 1002 } });
    const fork = await harness.send("session.fork", {
      sessionId: started.sessionId,
      entryId: "entry_1",
    });
    expect(fork).toMatchObject({ error: { code: 1002 } });

    gated.release.resolve();
    await waitFor(harness, (events) => events.some((event) => event.type === "settled"));
  });

  it("forks with model and cwd overrides and clamps the effective sandbox", async () => {
    const harness = await createHarness({
      sandbox: { maxMode: "read-only", maxNetwork: "none" },
    });
    const started = await startSession(harness);
    await harness.send("turn.start", { sessionId: started.sessionId, text: "hello" });
    await waitFor(harness, (events) => events.some((event) => event.type === "settled"));

    const sourceEntries = await harness.store.entries(started.sessionId);
    const head = sourceEntries.at(-1)?.id;
    if (head === undefined) throw new Error("missing source head");

    const forked = await harness.send("session.fork", {
      sessionId: started.sessionId,
      entryId: head,
      model: "next-model",
      cwd: "next-workspace",
    });
    expect(forked).toMatchObject({
      result: {
        session: {
          model: "next-model",
          cwd: path.resolve(harness.cwd, "next-workspace"),
          parentSessionId: started.sessionId,
          forkEntryId: head,
        },
      },
    });
    const forkedId = (forked as { result: { session: { id: string } } }).result.session.id;

    const widened = await harness.send("sandbox.mode", {
      sessionId: forkedId,
      mode: "workspace-write",
      network: "full",
    });
    expect(widened).toMatchObject({ result: { mode: "read-only", network: "none" } });

    const inherited = await harness.send("session.fork", {
      sessionId: started.sessionId,
      entryId: head,
    });
    expect(inherited).toMatchObject({
      result: { session: { model: "faux-model", cwd: harness.cwd } },
    });

    expect(await harness.store.entries(started.sessionId)).toEqual(sourceEntries);
  });
});

function settledCount(events: AgentEvent[]): number {
  return events.filter((event) => event.type === "settled").length;
}
