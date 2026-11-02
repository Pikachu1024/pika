import type {
  AgentEvent,
  SessionEntry,
  SessionMeta,
  SessionSummary,
  ToolResult,
} from "@pika-harness/schema";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, AgentState, RuntimeOptions } from "../../src/agent.js";
import type { Clock } from "../../src/clock.js";
import { createIdGenerator } from "../../src/clock.js";
import type { EventSink } from "../../src/events.js";
import { createEventCollector } from "../../src/events.js";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import type { LlmEvent, LlmRequest, ModelInfo, Provider } from "../../src/provider.js";
import { createRuntime } from "../../src/runtime/runtime.js";
import type { SessionStore } from "../../src/session-store.js";
import type { ToolExecutor } from "../../src/tools.js";

const fixedDate = new Date("2026-01-01T00:00:00.000Z");
const fixedTimestamp = fixedDate.toISOString();
const clock: Clock = { now: () => new Date(fixedDate) };

type EventOfType<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

function eventsOfType<T extends AgentEvent["type"]>(
  events: AgentEvent[],
  type: T,
): Array<EventOfType<T>> {
  return events.filter((event): event is EventOfType<T> => event.type === type);
}

function typesWithoutContext(events: AgentEvent[]): AgentEvent["type"][] {
  return events.filter((event) => event.type !== "context_projected").map((event) => event.type);
}

function commonOptions(provider: Provider) {
  return {
    sessionId: "session_test",
    model: "faux-model",
    provider,
    clock,
    ids: createIdGenerator(),
  };
}

function createHarness(provider: Provider, overrides: Partial<RuntimeOptions> = {}) {
  const sink = createEventCollector();
  const runtime = createRuntime({ ...commonOptions(provider), eventSink: sink, ...overrides });
  return { runtime, sink };
}

interface RecordingHarness {
  runtime: AgentRuntime;
  events: AgentEvent[];
  states: AgentState[];
}

function createRecordingHarness(
  provider: Provider,
  overrides: Partial<RuntimeOptions> = {},
): RecordingHarness {
  const events: AgentEvent[] = [];
  const states: AgentState[] = [];
  let runtime!: AgentRuntime;
  const eventSink: EventSink = {
    emit(event) {
      events.push(event);
      states.push(runtime.state);
    },
  };
  runtime = createRuntime({ ...commonOptions(provider), eventSink, ...overrides });
  return { runtime, events, states };
}

function textExecutor(text = "ok", chunk = "partial"): ToolExecutor {
  return {
    async execute(calls, context) {
      const results: ToolResult[] = [];
      for (const call of calls) {
        context.onStart(call);
        context.onUpdate(call, chunk);
        const result: ToolResult = {
          toolCallId: call.id,
          content: [{ type: "text", text }],
          isError: false,
        };
        context.onEnd(call, result);
        results.push(result);
      }
      return results;
    },
  };
}

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
    return [];
  }

  async *#run(index: number, signal: AbortSignal): AsyncIterable<LlmEvent> {
    if (index === 1) {
      yield { type: "text_delta", text: "hello" };
      this.firstStepStarted.resolve();
      await this.releaseFirstStep.promise;
      if (signal.aborted) {
        return;
      }
      yield { type: "done", stopReason: "end" };
      return;
    }
    yield { type: "text_delta", text: "steered" };
    yield { type: "done", stopReason: "end" };
  }
}

const toolTurn: LlmEvent[] = [
  { type: "tool_call_delta", index: 0, id: "call_1", name: "read_file" },
  { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"a.txt"}' },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
  { type: "done", stopReason: "tool_use" },
];

const finalTurn: LlmEvent[] = [
  { type: "text_delta", text: "All done." },
  { type: "usage", usage: { inputTokens: 20, outputTokens: 6 } },
  { type: "done", stopReason: "end" },
];

describe("runtime turn loop", () => {
  it("emits the documented lifecycle order for a tool turn", async () => {
    const provider = new FauxProvider([toolTurn, finalTurn]);
    const { runtime, sink } = createHarness(provider, { toolExecutor: textExecutor("contents") });

    await runtime.prompt("read a.txt");
    await runtime.settled();

    expect(typesWithoutContext(sink.events)).toEqual([
      "agent_start",
      "turn_start",
      "user_message",
      "message_start",
      "message_delta",
      "message_delta",
      "message_end",
      "tool_call_start",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "message_start",
      "message_delta",
      "message_end",
      "turn_end",
      "agent_end",
      "settled",
    ]);

    for (const event of sink.events) {
      expect(event.sessionId).toBe("session_test");
      expect(event.timestamp).toBe(fixedTimestamp);
    }
    const turnScoped = sink.events.filter((event) => "turnId" in event);
    for (const event of turnScoped) {
      expect(event.turnId).toBe("turn_1");
    }

    const [turnStart] = eventsOfType(sink.events, "turn_start");
    expect(turnStart?.turnNumber).toBe(1);
    expect(turnStart?.input).toEqual({ role: "user", text: "read a.txt" });

    const [userMessage] = eventsOfType(sink.events, "user_message");
    expect(userMessage?.delivery).toBe("prompt");

    const messageEnds = eventsOfType(sink.events, "message_end");
    expect(messageEnds.map((event) => event.stopReason)).toEqual(["tool_use", "end"]);
    expect(messageEnds[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(messageEnds[1]?.usage).toEqual({ inputTokens: 20, outputTokens: 6 });

    const [toolCallStart] = eventsOfType(sink.events, "tool_call_start");
    expect(toolCallStart?.call).toEqual({
      id: "call_1",
      name: "read_file",
      arguments: '{"path":"a.txt"}',
    });
    expect(sink.events.filter((event) => event.type === "message_delta")).toHaveLength(3);

    const [toolEnd] = eventsOfType(sink.events, "tool_execution_end");
    expect(toolEnd?.result).toEqual({
      toolCallId: "call_1",
      content: [{ type: "text", text: "contents" }],
      isError: false,
    });

    const [turnEnd] = eventsOfType(sink.events, "turn_end");
    expect(turnEnd?.stopReason).toBe("end");
    expect(turnEnd?.usage).toEqual({ inputTokens: 30, outputTokens: 10 });
    expect(sink.events.at(-1)?.type).toBe("settled");
    expect(runtime.state).toBe("idle");

    expect(provider.requests).toHaveLength(2);
    const secondRequest = provider.requests[1];
    expect(secondRequest?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(secondRequest?.messages[1]).toEqual({
      role: "assistant",
      content: [],
      toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }],
    });
  });

  it("sets state before emitting state-scoped events", async () => {
    const provider = new FauxProvider([toolTurn, finalTurn]);
    const { runtime, events, states } = createRecordingHarness(provider, {
      toolExecutor: textExecutor(),
    });

    await runtime.prompt("read a.txt");
    await runtime.settled();

    const stateAt = (type: AgentEvent["type"]): AgentState | undefined => {
      const index = events.findIndex((event) => event.type === type);
      return index < 0 ? undefined : states[index];
    };

    expect(stateAt("message_start")).toBe("streaming");
    expect(stateAt("tool_execution_start")).toBe("tool-calling");
    expect(stateAt("turn_end")).toBe("idle");
    expect(runtime.state).toBe("idle");
  });

  it("applies steering after the current model step and runs another model call", async () => {
    const provider = new GatedProvider();
    const { runtime, sink } = createHarness(provider);

    await runtime.prompt("start");
    await provider.firstStepStarted.promise;
    await runtime.steer("adjust");
    provider.releaseFirstStep.resolve();
    await runtime.settled();

    expect(typesWithoutContext(sink.events)).toEqual([
      "agent_start",
      "turn_start",
      "user_message",
      "message_start",
      "message_delta",
      "message_end",
      "user_message",
      "message_start",
      "message_delta",
      "message_end",
      "turn_end",
      "agent_end",
      "settled",
    ]);
    expect(eventsOfType(sink.events, "user_message").map((event) => event.delivery)).toEqual([
      "prompt",
      "steer",
    ]);
    expect(eventsOfType(sink.events, "turn_start")).toHaveLength(1);
    expect(eventsOfType(sink.events, "turn_end")).toHaveLength(1);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(provider.requests[1]?.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "adjust" }],
    });
  });

  it("serializes concurrent prompt and steer into one consistent order", async () => {
    const provider = new GatedProvider();
    const { runtime, sink } = createHarness(provider);

    const prompted = runtime.prompt("first");
    const steered = runtime.steer("second");
    await Promise.all([prompted, steered]);
    provider.releaseFirstStep.resolve();
    await runtime.settled();

    expect(eventsOfType(sink.events, "turn_start")).toHaveLength(1);
    expect(eventsOfType(sink.events, "user_message").map((event) => event.delivery)).toEqual([
      "prompt",
      "steer",
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(typesWithoutContext(sink.events)).toEqual([
      "agent_start",
      "turn_start",
      "user_message",
      "message_start",
      "message_delta",
      "message_end",
      "user_message",
      "message_start",
      "message_delta",
      "message_end",
      "turn_end",
      "agent_end",
      "settled",
    ]);
  });

  it("queues a follow-up as a new turn before settling", async () => {
    const provider = new FauxProvider([
      [
        { type: "text_delta", text: "one" },
        { type: "done", stopReason: "end" },
      ],
      [
        { type: "text_delta", text: "two" },
        { type: "done", stopReason: "end" },
      ],
    ]);
    const { runtime, sink } = createHarness(provider);

    void runtime.prompt("first");
    void runtime.followUp("second");
    await runtime.settled();

    expect(typesWithoutContext(sink.events)).toEqual([
      "agent_start",
      "turn_start",
      "user_message",
      "message_start",
      "message_delta",
      "message_end",
      "turn_end",
      "turn_start",
      "user_message",
      "message_start",
      "message_delta",
      "message_end",
      "turn_end",
      "agent_end",
      "settled",
    ]);
    expect(eventsOfType(sink.events, "turn_start").map((event) => event.turnNumber)).toEqual([
      1, 2,
    ]);
    expect(eventsOfType(sink.events, "user_message").map((event) => event.delivery)).toEqual([
      "prompt",
      "follow_up",
    ]);
    expect(eventsOfType(sink.events, "agent_start")).toHaveLength(1);
    expect(eventsOfType(sink.events, "agent_end")).toHaveLength(1);
    const turnIds = eventsOfType(sink.events, "turn_start").map((event) => event.turnId);
    expect(new Set(turnIds).size).toBe(2);
  });

  it("interrupts a running tool, records an aborted result, and stays usable", async () => {
    const toolStarted = deferred();
    const executor: ToolExecutor = {
      async execute(calls, context) {
        for (const call of calls) {
          context.onStart(call);
        }
        toolStarted.resolve();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            resolve();
            return;
          }
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("tool aborted");
      },
    };
    const provider = new FauxProvider([
      toolTurn,
      [
        { type: "text_delta", text: "recovered" },
        { type: "done", stopReason: "end" },
      ],
    ]);
    const { runtime, events, states } = createRecordingHarness(provider, {
      toolExecutor: executor,
    });

    await runtime.prompt("run it");
    await toolStarted.promise;
    await runtime.interrupt("user cancel");
    await runtime.settled();

    expect(typesWithoutContext(events)).toEqual([
      "agent_start",
      "turn_start",
      "user_message",
      "message_start",
      "message_delta",
      "message_delta",
      "message_end",
      "tool_call_start",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "agent_end",
      "settled",
    ]);

    const [toolEnd] = eventsOfType(events, "tool_execution_end");
    expect(toolEnd?.result.isError).toBe(true);
    expect(toolEnd?.result.content[0]).toMatchObject({ type: "error", code: "aborted" });

    const [turnEnd] = eventsOfType(events, "turn_end");
    expect(turnEnd?.stopReason).toBe("aborted");
    const turnEndIndex = events.findIndex((event) => event.type === "turn_end");
    expect(states[turnEndIndex]).toBe("aborted");
    expect(runtime.state).toBe("idle");

    await runtime.prompt("try again");
    await runtime.settled();

    const laterEvents = events.slice(turnEndIndex + 1);
    expect(eventsOfType(laterEvents, "turn_start").map((event) => event.turnNumber)).toEqual([2]);
    expect(eventsOfType(laterEvents, "message_end").map((event) => event.stopReason)).toEqual([
      "end",
    ]);
    expect(eventsOfType(laterEvents, "turn_end").map((event) => event.stopReason)).toEqual(["end"]);
    expect(laterEvents.at(-1)?.type).toBe("settled");
    expect(runtime.state).toBe("idle");
  });

  it("recovers from a provider error so a later prompt succeeds", async () => {
    const provider = new FauxProvider([
      [
        { type: "text_delta", text: "partial" },
        { type: "error", error: { code: "provider_down", message: "boom", retryable: false } },
      ],
      [
        { type: "text_delta", text: "recovered" },
        { type: "done", stopReason: "end" },
      ],
    ]);
    const { runtime, sink } = createHarness(provider);

    await runtime.prompt("first");
    await runtime.settled();

    expect(typesWithoutContext(sink.events)).toEqual([
      "agent_start",
      "turn_start",
      "user_message",
      "message_start",
      "message_delta",
      "message_end",
      "error",
      "turn_end",
      "agent_end",
      "settled",
    ]);
    const [errorEvent] = eventsOfType(sink.events, "error");
    expect(errorEvent?.error.code).toBe("provider_down");
    expect(eventsOfType(sink.events, "message_end")[0]?.stopReason).toBe("error");
    expect(eventsOfType(sink.events, "turn_end")[0]?.stopReason).toBe("error");
    expect(runtime.state).toBe("idle");

    await runtime.prompt("second");
    await runtime.settled();

    const finalEnds = eventsOfType(sink.events, "turn_end");
    expect(finalEnds.map((event) => event.stopReason)).toEqual(["error", "end"]);
    expect(runtime.state).toBe("idle");
  });

  it("synthesizes error results when no tool executor is configured", async () => {
    const provider = new FauxProvider([toolTurn, finalTurn]);
    const { runtime, sink } = createHarness(provider);

    await runtime.prompt("read a.txt");
    await runtime.settled();

    const [toolEnd] = eventsOfType(sink.events, "tool_execution_end");
    expect(toolEnd?.result.isError).toBe(true);
    expect(toolEnd?.result.content[0]).toMatchObject({ type: "error", code: "no_executor" });
    expect(eventsOfType(sink.events, "turn_end")[0]?.stopReason).toBe("end");
  });

  it("stops a turn that exceeds the model call limit", async () => {
    const provider = new FauxProvider([toolTurn, toolTurn, toolTurn]);
    const { runtime, sink } = createHarness(provider, {
      toolExecutor: textExecutor(),
      maxModelCallsPerTurn: 2,
    });

    await runtime.prompt("loop");
    await runtime.settled();

    expect(provider.requests).toHaveLength(2);
    expect(eventsOfType(sink.events, "error")[0]?.error.code).toBe("max_model_calls");
    expect(eventsOfType(sink.events, "turn_end")[0]?.stopReason).toBe("error");
    expect(sink.events.at(-1)?.type).toBe("settled");
    expect(runtime.state).toBe("idle");
  });

  it("appends every event to the session store in emission order", async () => {
    const appended: Array<{ event: AgentEvent; parentId: string | null | undefined }> = [];
    let entries = 0;
    const store: SessionStore = {
      async create(): Promise<void> {
        throw new Error("not used");
      },
      async append(
        _sessionId: string,
        event: AgentEvent,
        parentId?: string | null,
      ): Promise<SessionEntry> {
        appended.push({ event, parentId });
        entries += 1;
        return { id: `entry_${entries}`, parentId: parentId ?? null, event };
      },
      async entries(): Promise<SessionEntry[]> {
        throw new Error("not used");
      },
      async list(): Promise<SessionSummary[]> {
        throw new Error("not used");
      },
      async fork(_sessionId: string, _entryId: string): Promise<SessionMeta> {
        throw new Error("not used");
      },
      async close(): Promise<void> {
        throw new Error("not used");
      },
    };
    const provider = new FauxProvider([
      [
        { type: "text_delta", text: "hello" },
        { type: "done", stopReason: "end" },
      ],
    ]);
    const { runtime, sink } = createHarness(provider, { sessionStore: store });

    await runtime.prompt("hi");
    await runtime.settled();

    expect(appended.map((entry) => entry.event)).toEqual(sink.events);
    expect(appended.every((entry) => entry.parentId === undefined)).toBe(true);
  });
});
