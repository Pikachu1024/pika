import { readFile } from "node:fs/promises";
import type { AgentEvent, ToolResult } from "@pika-harness/schema";
import { AgentEventSchema } from "@pika-harness/schema";
import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/clock.js";
import { createIdGenerator } from "../../src/clock.js";
import { createEventCollector } from "../../src/events.js";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import type { LlmEvent } from "../../src/provider.js";
import { createRuntime } from "../../src/runtime/runtime.js";
import type { ToolExecutor } from "../../src/tools.js";

const fixedDate = new Date("2026-01-01T00:00:00.000Z");
const clock: Clock = { now: () => new Date(fixedDate) };

async function loadFixture(name: string): Promise<AgentEvent[]> {
  const contents = await readFile(
    new URL(`../fixtures/events/${name}.json`, import.meta.url),
    "utf8",
  );
  const raw: unknown = JSON.parse(contents);
  return AgentEventSchema.array().parse(raw);
}

function createHarness(turns: LlmEvent[][], toolExecutor?: ToolExecutor) {
  const sink = createEventCollector();
  const runtime = createRuntime({
    sessionId: "session_test",
    model: "faux-model",
    provider: new FauxProvider(turns),
    clock,
    ids: createIdGenerator(),
    eventSink: sink,
    ...(toolExecutor === undefined ? {} : { toolExecutor }),
  });
  return { runtime, sink };
}

function textExecutor(text: string, chunk: string): ToolExecutor {
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

describe("event fixtures", () => {
  it("matches the recorded tool-turn sequence", async () => {
    const expected = await loadFixture("tool-turn");
    const { runtime, sink } = createHarness(
      [toolTurn, finalTurn],
      textExecutor("contents", "partial"),
    );

    await runtime.prompt("read a.txt");
    await runtime.settled();

    expect(sink.events).toEqual(expected);
  });

  it("matches the recorded provider-error sequence", async () => {
    const expected = await loadFixture("provider-error");
    const provider = new FauxProvider([
      [
        { type: "text_delta", text: "partial" },
        { type: "error", error: { code: "provider_down", message: "boom", retryable: false } },
      ],
      finalTurn,
    ]);
    const sink = createEventCollector();
    const runtime = createRuntime({
      sessionId: "session_test",
      model: "faux-model",
      provider,
      clock,
      ids: createIdGenerator(),
      eventSink: sink,
    });

    await runtime.prompt("first");
    await runtime.settled();

    expect(sink.events).toEqual(expected);
    expect(runtime.state).toBe("idle");

    await runtime.prompt("second");
    await runtime.settled();

    const recovered = sink.events.filter(
      (event) => event.type === "turn_start" || event.type === "turn_end",
    );
    expect(recovered.at(-2)).toMatchObject({ type: "turn_start", turnNumber: 2 });
    expect(recovered.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end" });
  });
});
