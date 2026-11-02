import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@pika-harness/schema";
import { NotSettledError } from "../../src/agent.js";
import { createIdGenerator } from "../../src/clock.js";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import type { LlmEvent, LlmRequest, ModelInfo, Provider } from "../../src/provider.js";
import { createRuntime } from "../../src/runtime/runtime.js";
import { MemorySessionStore } from "../../src/session/memory-store.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
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

function baseOptions(provider: Provider) {
  return {
    sessionId: "session_maintenance",
    model: "faux-model",
    provider,
    ids: createIdGenerator(),
  };
}

const textTurn = (text: string): LlmEvent[] => [
  { type: "text_delta", text },
  { type: "done", stopReason: "end" },
];

class GatedProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  readonly started = deferred();
  readonly release = deferred();

  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    return this.#run(signal);
  }

  models(): ModelInfo[] {
    return [];
  }

  async *#run(signal: AbortSignal): AsyncIterable<LlmEvent> {
    yield { type: "text_delta", text: "first" };
    this.started.resolve();
    await this.release.promise;
    if (signal.aborted) return;
    yield { type: "done", stopReason: "end" };
  }
}

class SideGateProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  readonly sideStarted = deferred();
  readonly releaseSide = deferred();
  #calls = 0;

  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    this.#calls += 1;
    return this.#run(this.#calls, signal);
  }

  models(): ModelInfo[] {
    return [];
  }

  async *#run(index: number, signal: AbortSignal): AsyncIterable<LlmEvent> {
    if (index === 2) {
      this.sideStarted.resolve();
      await this.releaseSide.promise;
      if (signal.aborted) return;
      yield { type: "text_delta", text: "side answer" };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      yield { type: "done", stopReason: "end" };
      return;
    }
    yield { type: "text_delta", text: `turn ${index}` };
    yield { type: "done", stopReason: "end" };
  }
}

describe("manual compaction", () => {
  it("forces compaction below the threshold and reports token counts", async () => {
    const events: AgentEvent[] = [];
    const provider = new FauxProvider([textTurn("a".repeat(400)), textTurn("b".repeat(400))]);
    const runtime = createRuntime({
      ...baseOptions(provider),
      eventSink: {
        emit: (event) => {
          events.push(event);
        },
      },
      compaction: {
        contextWindow: 1_000_000,
        reserveTokens: 0,
        keepRecentTurns: 1,
        summarize: () => "earlier summary",
      },
    });

    await runtime.prompt("first turn");
    await runtime.settled();
    await runtime.prompt("second turn");
    await runtime.settled();
    expect(events.some((event) => event.type === "compaction_end")).toBe(false);

    const result = await runtime.compact();

    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    const compaction = events.find((event) => event.type === "compaction_end");
    expect(compaction).toBeDefined();
    if (compaction?.type !== "compaction_end") throw new Error("missing compaction event");
    expect(compaction.tokensBefore).toBe(result.tokensBefore);
    expect(compaction.tokensAfter).toBe(result.tokensAfter);
    const started = events.find((event) => event.type === "compaction_start");
    expect(started?.type === "compaction_start" ? started.reason : undefined).toBe("manual");
    expect(events.some((event) => event.type === "turn_start" && event.turnNumber > 2)).toBe(false);

    await runtime.prompt("third turn");
    await runtime.settled();
    const request = provider.requests.at(-1);
    const first = request?.messages[0];
    expect(first?.role).toBe("user");
    expect(first?.content[0]?.type === "text" ? first.content[0].text : "").toContain(
      "[compacted context]",
    );
    const serialized = JSON.stringify(request?.messages);
    expect(serialized).not.toContain("first turn");
    expect(serialized).toContain("second turn");
    expect(serialized).toContain("third turn");
  });

  it("is a no-op when there is no compactable cut point", async () => {
    const events: AgentEvent[] = [];
    const runtime = createRuntime({
      ...baseOptions(new FauxProvider([])),
      eventSink: {
        emit: (event) => {
          events.push(event);
        },
      },
      compaction: {
        contextWindow: 100,
        reserveTokens: 0,
        keepRecentTurns: 1,
        summarize: () => "unused",
      },
    });

    const result = await runtime.compact();

    expect(result).toEqual({ compacted: false, tokensBefore: 0, tokensAfter: 0 });
    expect(events).toEqual([]);
    expect(runtime.isSettled()).toBe(true);
  });

  it("rejects compaction while a turn is running", async () => {
    const provider = new GatedProvider();
    const runtime = createRuntime({
      ...baseOptions(provider),
      eventSink: { emit: () => undefined },
    });

    await runtime.prompt("busy");
    await provider.started.promise;
    expect(runtime.isSettled()).toBe(false);
    await expect(runtime.compact()).rejects.toBeInstanceOf(NotSettledError);

    provider.release.resolve();
    await runtime.settled();
    expect(runtime.isSettled()).toBe(true);
  });
});

describe("side questions", () => {
  it("answers with no tools and leaves the log, usage, and history unchanged", async () => {
    const events: AgentEvent[] = [];
    const provider = new FauxProvider([
      [
        { type: "text_delta", text: "main answer" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
        { type: "done", stopReason: "end" },
      ],
      [
        { type: "text_delta", text: "side answer" },
        { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
        { type: "done", stopReason: "end" },
      ],
      textTurn("next answer"),
    ]);
    const store = new MemorySessionStore();
    await store.create({
      id: "session_maintenance",
      cwd: "/tmp/pika",
      model: "faux-model",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const runtime = createRuntime({
      ...baseOptions(provider),
      eventSink: {
        emit: (event) => {
          events.push(event);
        },
      },
      sessionStore: store,
    });

    await runtime.prompt("hello");
    await runtime.settled();
    const entriesBefore = await store.entries("session_maintenance");
    const usageBefore = (await store.list())[0]?.usage;
    const eventsBefore = events.length;

    const side = await runtime.askSideQuestion("what is this?");

    expect(side).toEqual({
      text: "side answer",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(events).toHaveLength(eventsBefore);
    expect(await store.entries("session_maintenance")).toEqual(entriesBefore);
    expect((await store.list())[0]?.usage).toEqual(usageBefore);

    const sideRequest = provider.requests[1];
    expect(sideRequest?.tools).toEqual([]);
    expect(sideRequest?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "what is this?" }],
    });

    await runtime.prompt("follow up");
    await runtime.settled();
    const followUpMessages = provider.requests[2]?.messages ?? [];
    expect(JSON.stringify(followUpMessages)).not.toContain("side answer");
    expect(followUpMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  it("queues a prompt that arrives during a side question", async () => {
    const provider = new SideGateProvider();
    const runtime = createRuntime({
      ...baseOptions(provider),
      eventSink: { emit: () => undefined },
    });

    await runtime.prompt("first");
    await runtime.settled();

    const side = runtime.askSideQuestion("why?");
    await provider.sideStarted.promise;
    expect(runtime.isSettled()).toBe(false);
    await expect(runtime.askSideQuestion("again")).rejects.toBeInstanceOf(NotSettledError);

    await runtime.prompt("second");
    expect(provider.requests).toHaveLength(2);

    provider.releaseSide.resolve();
    expect(await side).toEqual({
      text: "side answer",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    await runtime.settled();

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]?.tools).toEqual([]);
    const queued = provider.requests[2];
    expect(queued?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "second" }],
    });
    expect(JSON.stringify(queued?.messages)).not.toContain("side answer");
  });

  it("rejects a side question while a turn is running", async () => {
    const provider = new GatedProvider();
    const runtime = createRuntime({
      ...baseOptions(provider),
      eventSink: { emit: () => undefined },
    });

    await runtime.prompt("busy");
    await provider.started.promise;
    await expect(runtime.askSideQuestion("hello?")).rejects.toBeInstanceOf(NotSettledError);

    provider.release.resolve();
    await runtime.settled();
  });
});
