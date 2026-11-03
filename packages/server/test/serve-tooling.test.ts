import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeProcessExecutor } from "@pika-harness/adapters";
import type { Executor, LlmEvent, SandboxCapabilities, ToolOutput } from "@pika-harness/core";
import {
  createIdGenerator,
  FauxProvider,
  MemorySessionStore,
  resolveSandboxPolicy,
} from "@pika-harness/core";
import type {
  AgentEvent,
  JsonRpcMessage,
  LlmEndpoint,
  SandboxPolicy,
  ToolResult,
} from "@pika-harness/schema";
import type { ServerSandboxOptions, SessionTooling } from "../src/index.js";
import {
  createInProcessTransportPair,
  createServeTooling,
  createSessionServer,
} from "../src/index.js";

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

function toolCallsTurn(calls: Array<{ name: string; args: Record<string, unknown> }>): LlmEvent[] {
  const deltas: LlmEvent[] = [];
  calls.forEach((call, index) => {
    deltas.push({
      type: "tool_call_delta",
      index,
      id: `call_${index + 1}`,
      name: call.name,
    });
    deltas.push({
      type: "tool_call_delta",
      index,
      argumentsDelta: JSON.stringify(call.args),
    });
  });
  deltas.push({ type: "done", stopReason: "tool_use" });
  return deltas;
}

class NoopExecutor implements Executor {
  readonly backend = "none" as const;

  async exec(): Promise<never> {
    throw new Error("shell execution is not used in this test");
  }

  async probe(): Promise<SandboxCapabilities> {
    return {
      backend: "none",
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    };
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function policyFor(workspace: string, overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    ...resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot: workspace }),
    ...overrides,
  };
}

function toolingFor(
  sessionsDir: string,
  workspace: string,
  options: { sessionId?: string; executor?: Executor } = {},
): { policy: SandboxPolicy; tooling: SessionTooling } {
  const policy = policyFor(workspace);
  const factory = createServeTooling({
    sessionsDir,
    executor: options.executor ?? new NoopExecutor(),
  });
  return {
    policy,
    tooling: factory(
      { sessionId: options.sessionId ?? "session_test", cwd: workspace, model: "faux-model" },
      policy,
    ),
  };
}

async function execute(
  tooling: SessionTooling,
  policy: SandboxPolicy,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const results = await tooling.executor.execute(
    [{ id: "call_1", name, arguments: JSON.stringify(args) }],
    {
      sessionId: "session_test",
      turnId: "turn_1",
      signal: new AbortController().signal,
      onStart: () => undefined,
      onUpdate: () => undefined,
      onEnd: () => undefined,
      sandbox: { backend: "none", policy, approvalMode: "never" },
    },
  );
  const result = results[0];
  if (result === undefined) throw new Error("expected one tool result");
  return result;
}

function text(result: ToolOutput | ToolResult | undefined): string {
  if (result === undefined) return "";
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function errorCode(result: ToolOutput | ToolResult | undefined): string | undefined {
  const part = result?.content.find((item) => item.type === "error");
  return part?.type === "error" ? part.code : undefined;
}

interface HarnessOptions {
  defaultCwd: string;
  sessionsDir: string;
  turns: LlmEvent[][];
  sandbox?: Partial<ServerSandboxOptions>;
  executor?: Executor;
  store?: MemorySessionStore;
}

interface Harness {
  store: MemorySessionStore;
  provider: FauxProvider;
  events: AgentEvent[];
  send(method: string, params: unknown): Promise<JsonRpcMessage>;
  startSession(cwd?: string, llm?: LlmEndpoint): Promise<{ sessionId: string; backend: string }>;
  forkSession(sessionId: string, entryId: string, cwd: string): Promise<string>;
  close(): Promise<void>;
}

async function createHarness(options: HarnessOptions): Promise<Harness> {
  const ids = createIdGenerator();
  const store = options.store ?? new MemorySessionStore({ ids });
  const provider = new FauxProvider(options.turns);
  const server = createSessionServer({
    store,
    provider,
    defaultCwd: options.defaultCwd,
    defaultModel: "faux-model",
    clock,
    ids,
    tooling: createServeTooling({
      sessionsDir: options.sessionsDir,
      executor: options.executor ?? new NoopExecutor(),
    }),
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
      events.push((message.params as { event: AgentEvent }).event);
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
  };
  cleanups.push(close);

  return {
    store,
    provider,
    events,
    send,
    async startSession(cwd = ".", llm) {
      const response = await send("session.start", {
        cwd,
        ...(llm === undefined ? {} : { llm }),
      });
      if (!("result" in response)) throw new Error(JSON.stringify(response));
      const result = response.result as {
        session: { id: string };
        sandbox: { backend: string };
      };
      await send("subscribe", { sessionId: result.session.id });
      return { sessionId: result.session.id, backend: result.sandbox.backend };
    },
    async forkSession(sessionId, entryId, cwd) {
      const response = await send("session.fork", { sessionId, entryId, cwd });
      if (!("result" in response)) throw new Error(JSON.stringify(response));
      return (response.result as { session: { id: string } }).session.id;
    },
    close,
  };
}

async function runTurn(
  harness: Harness,
  sessionId: string,
  prompt: string,
  settled: number,
): Promise<void> {
  await harness.send("turn.start", { sessionId, text: prompt });
  await waitFor(harness, settled);
}

async function waitFor(harness: Harness, settled: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const reached = (): boolean =>
    harness.events.filter((event) => event.type === "settled").length >= settled;
  while (!reached()) {
    if (Date.now() > deadline) throw new Error("event condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function resultsOf(harness: Harness): ToolResult[] {
  return harness.events.flatMap((event) =>
    event.type === "tool_execution_end" ? [event.result] : [],
  );
}

describe("serve tooling", () => {
  it("declares the built-in tools and reads a workspace file", async () => {
    const workspace = await tempDir("pika-tooling-ws-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    await writeFile(path.join(workspace, "note.txt"), "hello tooling\n", "utf8");
    const { policy, tooling } = toolingFor(sessionsDir, workspace);

    expect(tooling.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "bash",
    ]);

    const result = await execute(tooling, policy, "read_file", { path: "note.txt" });
    expect(result.isError).toBe(false);
    expect(text(result)).toBe("hello tooling\n");
  });

  it("declares no tools when the session endpoint disables tool calling", async () => {
    const workspace = await tempDir("pika-tooling-ws-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    const harness = await createHarness({
      defaultCwd: workspace,
      sessionsDir,
      turns: [textTurn],
    });
    const started = await harness.startSession(".", {
      baseUrl: "http://127.0.0.1:59000/v1",
      model: "faux-model",
      tools: false,
    });

    await runTurn(harness, started.sessionId, "hello", 1);

    expect(harness.provider.requests[0]?.tools).toEqual([]);
    expect(
      harness.events.some(
        (event) => event.type === "tool_execution_start" || event.type === "tool_execution_end",
      ),
    ).toBe(false);
  });

  it("forks inherit the endpoint tool capability and honor an override", async () => {
    const workspace = await tempDir("pika-tooling-ws-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    const harness = await createHarness({
      defaultCwd: workspace,
      sessionsDir,
      turns: [textTurn, textTurn, textTurn],
    });
    const endpoint: LlmEndpoint = {
      baseUrl: "http://127.0.0.1:59000/v1",
      model: "faux-model",
      tools: false,
    };
    const started = await harness.startSession(".", endpoint);
    await runTurn(harness, started.sessionId, "first", 1);

    const head = (await harness.store.entries(started.sessionId)).at(-1)?.id;
    if (head === undefined) throw new Error("missing source head");
    const inherited = await harness.forkSession(started.sessionId, head, ".");
    await harness.send("subscribe", { sessionId: inherited });
    await runTurn(harness, inherited, "inherited", 2);
    expect(harness.provider.requests[1]?.tools).toEqual([]);

    const forkHead = (await harness.store.entries(inherited)).at(-1)?.id;
    if (forkHead === undefined) throw new Error("missing fork head");
    const response = await harness.send("session.fork", {
      sessionId: inherited,
      entryId: forkHead,
      llm: { ...endpoint, tools: true },
    });
    if (!("result" in response)) throw new Error(JSON.stringify(response));
    const overridden = (response.result as { session: { id: string } }).session.id;
    await harness.send("subscribe", { sessionId: overridden });
    await runTurn(harness, overridden, "overridden", 3);
    expect(harness.provider.requests[2]?.tools.length).toBeGreaterThan(0);
  });

  it("resume uses the client-supplied endpoint tool capability", async () => {
    const workspace = await tempDir("pika-tooling-ws-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    const ids = createIdGenerator();
    const store = new MemorySessionStore({ ids });
    const endpoint: LlmEndpoint = {
      baseUrl: "http://127.0.0.1:59000/v1",
      model: "faux-model",
      tools: false,
    };
    const first = await createHarness({
      defaultCwd: workspace,
      sessionsDir,
      store,
      turns: [textTurn],
    });
    const started = await first.startSession(".", endpoint);
    await runTurn(first, started.sessionId, "first", 1);
    expect(first.provider.requests[0]?.tools).toEqual([]);

    const second = await createHarness({
      defaultCwd: workspace,
      sessionsDir,
      store,
      turns: [textTurn],
    });
    await second.send("session.resume", {
      sessionId: started.sessionId,
      llm: { ...endpoint, tools: true },
    });
    await second.send("subscribe", { sessionId: started.sessionId });
    await runTurn(second, started.sessionId, "resumed", 1);
    expect(second.provider.requests[0]?.tools.length).toBeGreaterThan(0);
  });

  it("persists oversized output under the session outputs directory", async () => {
    const workspace = await tempDir("pika-tooling-ws-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    await writeFile(path.join(workspace, "big.txt"), "x".repeat(2_000), "utf8");
    const harness = await createHarness({
      defaultCwd: workspace,
      sessionsDir,
      sandbox: { maxOutputBytes: 64 },
      turns: [toolCallTurn("read_file", { path: "big.txt" }), textTurn],
    });
    const started = await harness.startSession();

    await runTurn(harness, started.sessionId, "read the file", 1);

    const result = resultsOf(harness)[0];
    expect(result?.isError).toBe(false);
    expect(text(result)).toContain("truncated");
    expect(result?.fullOutputRef).toBeDefined();
    expect(path.dirname(result?.fullOutputRef ?? "")).toBe(
      path.join(path.resolve(sessionsDir), started.sessionId, "outputs"),
    );
  });

  it("binds tools to each session workspace, including forks, and denies escapes", async () => {
    const workspaceA = await tempDir("pika-tooling-a-");
    const workspaceB = await tempDir("pika-tooling-b-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    await writeFile(path.join(workspaceA, "shared.txt"), "from A\n", "utf8");
    await writeFile(path.join(workspaceB, "shared.txt"), "from B\n", "utf8");
    const harness = await createHarness({
      defaultCwd: workspaceA,
      sessionsDir,
      turns: [
        toolCallTurn("read_file", { path: "shared.txt" }),
        textTurn,
        toolCallTurn("read_file", { path: "shared.txt" }),
        textTurn,
        toolCallTurn("write_file", { path: "../escape.txt", content: "nope" }),
        textTurn,
      ],
    });
    const first = await harness.startSession();
    await runTurn(harness, first.sessionId, "read A", 1);

    const head = (await harness.store.entries(first.sessionId)).at(-1)?.id;
    if (head === undefined) throw new Error("missing source head");
    const forked = await harness.forkSession(first.sessionId, head, workspaceB);
    await harness.send("subscribe", { sessionId: forked });
    await runTurn(harness, forked, "read B", 2);
    await runTurn(harness, forked, "write outside", 3);

    const results = resultsOf(harness);
    expect(text(results[0])).toBe("from A\n");
    expect(text(results[1])).toBe("from B\n");
    expect(results[2]?.isError).toBe(true);
    expect(errorCode(results[2])).toBe("outside-workspace");
    await expect(stat(path.join(workspaceB, "..", "escape.txt"))).rejects.toThrow();
  });

  it("rejects an unsafe session id before creating an output directory", async () => {
    const workspace = await tempDir("pika-tooling-ws-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    const policy = policyFor(workspace);
    const factory = createServeTooling({
      sessionsDir,
      executor: new NoopExecutor(),
    });

    expect(() =>
      factory({ sessionId: "../escape", cwd: workspace, model: "faux-model" }, policy),
    ).toThrow(/Invalid session id/);
    expect(await readdir(sessionsDir)).toEqual([]);
  });

  it("runs read_file and write_file through the protocol with the none executor", async () => {
    const workspace = await tempDir("pika-tooling-ws-");
    const sessionsDir = await tempDir("pika-tooling-sessions-");
    await writeFile(path.join(workspace, "input.txt"), "input\n", "utf8");
    const harness = await createHarness({
      defaultCwd: workspace,
      sessionsDir,
      executor: new NodeProcessExecutor(),
      turns: [
        toolCallsTurn([
          { name: "read_file", args: { path: "input.txt" } },
          { name: "write_file", args: { path: "out.txt", content: "written\n" } },
        ]),
        textTurn,
      ],
    });
    const started = await harness.startSession();

    await runTurn(harness, started.sessionId, "read then write", 1);

    const starts = harness.events.flatMap((event) =>
      event.type === "tool_execution_start" ? [event.name] : [],
    );
    expect(starts.sort()).toEqual(["read_file", "write_file"]);
    const results = resultsOf(harness);
    const readResult = results.find((result) => result.toolCallId === "call_1");
    const writeResult = results.find((result) => result.toolCallId === "call_2");
    expect(readResult?.isError).toBe(false);
    expect(text(readResult)).toBe("input\n");
    expect(writeResult?.isError).toBe(false);
    expect(await readFile(path.join(workspace, "out.txt"), "utf8")).toBe("written\n");
  });
});
