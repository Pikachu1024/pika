import { describe, expect, it } from "bun:test";
import path from "node:path";
import { PikaClient } from "@pika-harness/client";
import type { LlmEvent, LlmRequest, ModelInfo, Provider, Tool } from "@pika-harness/core";
import { FauxProvider } from "@pika-harness/core";
import type { AgentEvent } from "@pika-harness/schema";
import type { CompactionFactory } from "@pika-harness/server";
import { createInProcessTransportPair } from "@pika-harness/server";
import { z } from "zod";
import { collectUntilSettled, createTestServer, textTurn, toolCallTurn } from "./helpers.js";

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

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => {
      release?.();
    },
  };
}

class GatedProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  readonly firstStepStarted = deferred();
  readonly releaseFirstStep = deferred();
  #calls = 0;

  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    this.#calls += 1;
    return this.#run(this.#calls, signal);
  }

  models(): ModelInfo[] {
    return [{ id: "gated-model", provider: "gated", contextWindow: 10_000 }];
  }

  async *#run(index: number, signal: AbortSignal): AsyncIterable<LlmEvent> {
    if (index === 1) {
      yield { type: "text_delta", text: "working" };
      this.firstStepStarted.resolve();
      await this.releaseFirstStep.promise;
      if (signal.aborted) return;
      yield { type: "done", stopReason: "end" };
      return;
    }
    yield { type: "text_delta", text: "steered" };
    yield { type: "done", stopReason: "end" };
  }
}

async function connect(env: Awaited<ReturnType<typeof createTestServer>>) {
  const [serverSide, clientSide] = createInProcessTransportPair();
  env.server.attach(serverSide);
  const client = new PikaClient({ transport: clientSide, clientName: "sdk-test" });
  await client.initialize();
  return client;
}

function textDeltas(events: AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "message_delta" && event.delta.kind === "text" ? [event.delta.text] : [],
  );
}

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

describe("typed SDK", () => {
  it("completes a session with a tool call, approval, and final message", async () => {
    const env = await createTestServer({
      turns: [toolCallTurn("write_note", { text: "hi" }), textTurn],
      tools: [noteTool],
      sandbox: { defaultMode: "read-only", approvalMode: "on-request" },
    });
    const client = await connect(env);
    try {
      const started = await client.startSession({ cwd: "." });
      expect(started.sandbox.mode).toBe("read-only");
      const subscription = await client.subscribe(started.session.id);

      const approvalIds: string[] = [];
      subscription.onEvent((event) => {
        if (event.type !== "approval_requested") return;
        approvalIds.push(event.approval.id);
        void client.respondToApproval(started.session.id, event.approval.id, "approve_for_session");
      });

      await client.prompt(started.session.id, "write a note");
      const events = await collectUntilSettled(subscription);

      expect(approvalIds).toHaveLength(1);
      const toolEnd = events.find((event) => event.type === "tool_execution_end");
      expect(toolEnd?.type === "tool_execution_end" ? toolEnd.result : undefined).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "wrote hi" }],
      });
      expect(textDeltas(events)).toEqual(["Hello ", "world."]);
      expect(events.at(-1)?.type).toBe("settled");

      const sessions = await client.listSessions();
      expect(sessions.map((session) => session.id)).toContain(started.session.id);
    } finally {
      client.close();
      await env.cleanup();
    }
  });

  it("compacts, asks a side question, and forks with overrides", async () => {
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
    const env = await createTestServer({ provider, compaction });
    const client = await connect(env);
    try {
      const started = await client.startSession({ cwd: "." });
      const subscription = await client.subscribe(started.session.id);

      await client.prompt(started.session.id, "first");
      await collectUntilSettled(subscription);
      await client.prompt(started.session.id, "second");
      await collectUntilSettled(subscription);

      const compacted = await client.compactSession(started.session.id);
      expect(compacted.compacted).toBe(true);
      expect(compacted.tokensBefore).toBeGreaterThan(compacted.tokensAfter);

      const side = await client.askSideQuestion(started.session.id, "why?");
      expect(side).toEqual({ text: "side answer", usage: { inputTokens: 3, outputTokens: 2 } });

      const source = (await client.listSessions()).find(
        (session) => session.id === started.session.id,
      );
      if (source?.lastEntryId === undefined || source.lastEntryId === null) {
        throw new Error("missing source entry");
      }

      const forked = await client.forkSession(started.session.id, source.lastEntryId, {
        model: "fork-model",
        cwd: "sub",
        llm: { baseUrl: "http://127.0.0.1:59000/v1", model: "fork-model", apiKey: "secret" },
      });
      expect(forked.session).toMatchObject({
        model: "fork-model",
        cwd: path.join(env.cwd, "sub"),
      });

      const unchanged = (await client.listSessions()).find(
        (session) => session.id === started.session.id,
      );
      expect(unchanged).toMatchObject({ model: "faux-model", cwd: env.cwd });
    } finally {
      client.close();
      await env.cleanup();
    }
  });

  it("steers a running turn", async () => {
    const provider = new GatedProvider();
    const env = await createTestServer({ provider });
    const client = await connect(env);
    try {
      const started = await client.startSession({ cwd: "." });
      const subscription = await client.subscribe(started.session.id);
      const events: AgentEvent[] = [];
      subscription.onEvent((event) => events.push(event));

      await client.prompt(started.session.id, "start");
      await provider.firstStepStarted.promise;
      await client.steer(started.session.id, "adjust");
      provider.releaseFirstStep.resolve();
      await collectUntilSettled(subscription);

      const deliveries = events.flatMap((event) =>
        event.type === "user_message" ? [event.delivery] : [],
      );
      expect(deliveries).toEqual(["prompt", "steer"]);
      expect(provider.requests).toHaveLength(2);
      expect(textDeltas(events)).toEqual(["working", "steered"]);
    } finally {
      client.close();
      await env.cleanup();
    }
  });

  it("interrupts a running turn and keeps the session usable", async () => {
    const provider = new GatedProvider();
    const env = await createTestServer({ provider });
    const client = await connect(env);
    try {
      const started = await client.startSession({ cwd: "." });
      const subscription = await client.subscribe(started.session.id);
      const events: AgentEvent[] = [];
      subscription.onEvent((event) => events.push(event));

      await client.prompt(started.session.id, "start");
      await provider.firstStepStarted.promise;
      await client.interrupt(started.session.id, "user cancel");
      provider.releaseFirstStep.resolve();
      await collectUntilSettled(subscription);

      const aborted = events.filter((event) => event.type === "turn_end").at(-1);
      expect(aborted?.type === "turn_end" ? aborted.stopReason : undefined).toBe("aborted");

      await client.prompt(started.session.id, "again");
      const second = await collectUntilSettled(subscription);
      const stopped = second.filter((event) => event.type === "turn_end").at(-1);
      expect(stopped?.type === "turn_end" ? stopped.stopReason : undefined).toBe("end");
      expect(textDeltas(second)).toEqual(["steered"]);
    } finally {
      client.close();
      await env.cleanup();
    }
  });

  it("ends subscriptions when the transport closes", async () => {
    const env = await createTestServer();
    const [serverSide, clientSide] = createInProcessTransportPair();
    env.server.attach(serverSide);
    const client = new PikaClient({ transport: clientSide });
    try {
      await client.initialize();
      const started = await client.startSession({ cwd: "." });
      const subscription = await client.subscribe(started.session.id);
      const iterator = subscription[Symbol.asyncIterator]();
      const pending = iterator.next();

      clientSide.close();

      await expect(pending).resolves.toEqual({ value: undefined, done: true });
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
      await expect(client.prompt(started.session.id, "after close")).rejects.toThrow(
        "client is closed",
      );
    } finally {
      client.close();
      await env.cleanup();
    }
  });
});
