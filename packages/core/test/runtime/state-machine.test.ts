import type { AgentEvent, SessionMeta, ToolResult } from "@pika-harness/schema";
import { describe, expect, it } from "vitest";
import type { AgentState, RuntimeOptions } from "../../src/agent.js";
import type { Clock } from "../../src/clock.js";
import { createIdGenerator } from "../../src/clock.js";
import type { EventSink } from "../../src/events.js";
import { createEventCollector } from "../../src/events.js";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import type { LlmEvent, Provider } from "../../src/provider.js";
import { createRuntime } from "../../src/runtime/runtime.js";
import { MemorySessionStore } from "../../src/session/memory-store.js";
import { replaySession } from "../../src/session/replay.js";
import type { ToolExecutor } from "../../src/tools.js";

const fixedDate = new Date("2026-01-01T00:00:00.000Z");
const clock: Clock = { now: () => new Date(fixedDate) };

const textTurn = (text: string): LlmEvent[] => [
  { type: "text_delta", text },
  { type: "done", stopReason: "end" },
];

const toolTurn: LlmEvent[] = [
  { type: "tool_call_delta", index: 0, id: "call_1", name: "read_file" },
  { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"a.txt"}' },
  { type: "done", stopReason: "tool_use" },
];

function harness(provider: Provider, overrides: Partial<RuntimeOptions> = {}) {
  const sink = createEventCollector();
  const stateAt: AgentState[] = [];
  let runtime!: ReturnType<typeof createRuntime>;
  const recordingSink: EventSink = {
    emit(event) {
      sink.events.push(event);
      stateAt.push(runtime.state);
    },
  };
  const runtimeOptions: RuntimeOptions = {
    sessionId: "session_state",
    model: "faux-model",
    provider,
    clock,
    ids: createIdGenerator(),
    eventSink: recordingSink,
    ...overrides,
  };
  runtime = createRuntime(runtimeOptions);
  return { runtime, sink, stateAt };
}

function textExecutor(): ToolExecutor {
  return {
    async execute(calls, context) {
      const results: ToolResult[] = [];
      for (const call of calls) {
        context.onStart(call);
        const result: ToolResult = {
          toolCallId: call.id,
          content: [{ type: "text", text: "contents" }],
          isError: false,
        };
        context.onEnd(call, result);
        results.push(result);
      }
      return results;
    },
  };
}

function meta(id: string): SessionMeta {
  return { id, cwd: "/work", model: "faux-model", createdAt: fixedDate.toISOString() };
}

describe("runtime state machine", () => {
  it("transitions idle, streaming, tool-calling, then idle", async () => {
    const { runtime, sink, stateAt } = harness(new FauxProvider([toolTurn, textTurn("done")]), {
      toolExecutor: textExecutor(),
    });

    expect(runtime.state).toBe("idle");
    await runtime.prompt("read");
    await runtime.settled();

    const stateFor = (type: AgentEvent["type"]): AgentState | undefined => {
      const index = sink.events.findIndex((event) => event.type === type);
      return index < 0 ? undefined : stateAt[index];
    };

    expect(stateFor("turn_start")).toBe("idle");
    expect(stateFor("context_projected")).toBe("streaming");
    expect(stateFor("tool_call_start")).toBe("streaming");
    expect(stateFor("tool_execution_start")).toBe("tool-calling");
    expect(stateFor("turn_end")).toBe("idle");
    expect(runtime.state).toBe("idle");
  });

  it("records context projections whose hashes replay from the log", async () => {
    const store = new MemorySessionStore({ ids: createIdGenerator() });
    await store.create(meta("session_state"));
    const { runtime } = harness(new FauxProvider([toolTurn, textTurn("done")]), {
      sessionStore: store,
      toolExecutor: textExecutor(),
    });

    await runtime.prompt("read a.txt");
    await runtime.settled();

    const entries = await store.entries("session_state");
    const projections = entries.filter((entry) => entry.event.type === "context_projected");
    expect(projections).toHaveLength(2);

    const replay = replaySession({ entries });
    expect(replay.promptChecks).toHaveLength(2);
    expect(replay.promptChecks.every((check) => check.matches)).toBe(true);

    const first = projections[0]?.event;
    expect(first).toMatchObject({ type: "context_projected", messageCount: 1 });
    const second = projections[1]?.event;
    expect(second).toMatchObject({ type: "context_projected", messageCount: 3 });
  });
});

describe("runtime compaction", () => {
  it("compacts above the threshold, preserves recent turns, and records token counts", async () => {
    const provider = new FauxProvider([textTurn("first answer"), textTurn("second answer")]);
    const { runtime, sink, stateAt } = harness(provider, {
      compaction: {
        contextWindow: 60,
        reserveTokens: 0,
        keepRecentTurns: 1,
        summarize: (messages) => `summary of ${messages.length} messages`,
      },
    });

    await runtime.prompt(`first question ${"a".repeat(100)}`);
    await runtime.settled();
    await runtime.prompt(`second question ${"b".repeat(100)}`);
    await runtime.settled();

    const starts = sink.events.filter((event) => event.type === "compaction_start");
    const ends = sink.events.filter((event) => event.type === "compaction_end");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ reason: "threshold" });
    expect(ends).toHaveLength(1);
    expect(ends[0]?.tokensAfter).toBeLessThan(ends[0]?.tokensBefore ?? 0);

    const startIndex = sink.events.indexOf(starts[0] as AgentEvent);
    expect(stateAt[startIndex]).toBe("compacting");
    expect(runtime.state).toBe("idle");

    const secondRequest = provider.requests[1];
    expect(secondRequest?.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(secondRequest?.messages[0])).toContain("[compacted context]");
    expect(JSON.stringify(secondRequest?.messages[0])).toContain("summary of 2 messages");
  });

  it("retries once after an overflow error without emitting an error event", async () => {
    const provider = new FauxProvider([
      textTurn("first answer"),
      [
        {
          type: "error",
          error: { code: "context_length_exceeded", message: "too many tokens", retryable: false },
        },
      ],
      textTurn("recovered"),
    ]);
    const { runtime, sink } = harness(provider, {
      compaction: {
        contextWindow: 1_000,
        reserveTokens: 0,
        keepRecentTurns: 1,
        summarize: () => "overflow summary",
      },
    });

    await runtime.prompt("first question");
    await runtime.settled();
    await runtime.prompt("second question");
    await runtime.settled();

    expect(sink.events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(sink.events.filter((event) => event.type === "compaction_start")).toMatchObject([
      { reason: "overflow" },
    ]);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(provider.requests[2]?.messages[0])).toContain("overflow summary");
    expect(runtime.state).toBe("idle");
  });
});
