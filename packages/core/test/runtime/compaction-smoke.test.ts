import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@pika-harness/schema";
import { createIdGenerator, systemClock } from "../../src/clock.js";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import type { LlmEvent } from "../../src/provider.js";
import { createRuntime } from "../../src/runtime/runtime.js";

const TURNS = 40;
const CONTEXT_WINDOW = 300;
const RESERVE_TOKENS = 50;

function longTurn(): LlmEvent[] {
  return [
    { type: "text_delta", text: "y".repeat(400) },
    { type: "usage", usage: { inputTokens: 80, outputTokens: 100 } },
    { type: "done", stopReason: "end" },
  ];
}

describe("long-session compaction smoke", () => {
  it("stays responsive and records token reductions", async () => {
    const events: AgentEvent[] = [];
    const provider = new FauxProvider(Array.from({ length: TURNS }, longTurn));
    const runtime = createRuntime({
      sessionId: "session_compaction_smoke",
      model: "faux-model",
      provider,
      eventSink: {
        emit: (event) => {
          events.push(event);
        },
      },
      clock: systemClock,
      ids: createIdGenerator(),
      compaction: {
        contextWindow: CONTEXT_WINDOW,
        reserveTokens: RESERVE_TOKENS,
        keepRecentTurns: 2,
        summarize: (messages) => `summary of ${messages.length} messages`,
      },
    });

    const started = performance.now();
    for (let index = 0; index < TURNS; index += 1) {
      await runtime.prompt(`message ${index} ${"x".repeat(80)}`);
      await runtime.settled();
    }
    const elapsedMs = performance.now() - started;

    const compactions = events.filter((event) => event.type === "compaction_end");
    expect(runtime.state).toBe("idle");
    expect(events.filter((event) => event.type === "settled")).toHaveLength(TURNS);
    expect(compactions.length).toBeGreaterThan(0);
    expect(
      compactions.every(
        (event) => event.type === "compaction_end" && event.tokensAfter < event.tokensBefore,
      ),
    ).toBe(true);
    expect(provider.requests.length).toBe(TURNS);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
