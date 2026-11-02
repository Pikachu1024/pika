import { describe, expect, it } from "bun:test";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import type { LlmEvent, LlmRequest, ModelInfo, Provider } from "../../src/provider.js";

const request: LlmRequest = {
  model: "faux-model",
  system: "be helpful",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
};

async function collect(provider: Provider, signal?: AbortSignal): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  const abortSignal = signal ?? new AbortController().signal;
  for await (const event of provider.stream(request, abortSignal)) {
    events.push(event);
  }
  return events;
}

describe("FauxProvider", () => {
  it("yields scripted text events in order and records the request", async () => {
    const provider = new FauxProvider([
      [
        { type: "text_delta", text: "hello" },
        { type: "text_delta", text: " world" },
        { type: "done", stopReason: "end" },
      ],
    ]);

    const events = await collect(provider);

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
      { type: "done", stopReason: "end" },
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toEqual(request);
  });

  it("yields reasoning deltas", async () => {
    const provider = new FauxProvider([
      [
        { type: "reasoning_delta", text: "thinking" },
        { type: "text_delta", text: "answer" },
        { type: "done", stopReason: "end" },
      ],
    ]);

    const events = await collect(provider);

    expect(events.map((event) => event.type)).toEqual(["reasoning_delta", "text_delta", "done"]);
  });

  it("yields tool-call chunks, usage, and a stop reason", async () => {
    const provider = new FauxProvider([
      [
        { type: "tool_call_delta", index: 0, id: "call_a", name: "read_file" },
        { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"a.txt"}' },
        { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);

    const events = await collect(provider);

    expect(events).toEqual([
      { type: "tool_call_delta", index: 0, id: "call_a", name: "read_file" },
      { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"a.txt"}' },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  it("yields usage events before completion", async () => {
    const provider = new FauxProvider([
      [
        { type: "text_delta", text: "answer" },
        { type: "usage", usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 } },
        { type: "done", stopReason: "end" },
      ],
    ]);

    const events = await collect(provider);

    expect(events[1]).toEqual({
      type: "usage",
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
    });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });

  it("yields error events unchanged", async () => {
    const provider = new FauxProvider([
      [{ type: "error", error: { code: "provider_down", message: "boom", retryable: true } }],
    ]);

    const events = await collect(provider);

    expect(events).toEqual([
      { type: "error", error: { code: "provider_down", message: "boom", retryable: true } },
    ]);
  });

  it("emits nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FauxProvider([[{ type: "text_delta", text: "ignored" }]]);

    const events = await collect(provider, controller.signal);

    expect(events).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("stops emitting once the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const turn: AsyncIterable<LlmEvent> = (async function* generate() {
      yield { type: "text_delta", text: "first" };
      controller.abort();
      yield { type: "text_delta", text: "second" };
    })();
    const provider = new FauxProvider([turn]);

    const events = await collect(provider, controller.signal);

    expect(events).toEqual([{ type: "text_delta", text: "first" }]);
  });

  it("supports an async factory turn", async () => {
    const provider = new FauxProvider([
      async (received) => {
        async function* generate(): AsyncIterable<LlmEvent> {
          yield { type: "text_delta", text: received.model };
          yield { type: "done", stopReason: "end" };
        }
        return generate();
      },
    ]);

    const events = await collect(provider);

    expect(events).toEqual([
      { type: "text_delta", text: "faux-model" },
      { type: "done", stopReason: "end" },
    ]);
    expect(provider.requests).toHaveLength(1);
  });

  it("advances through scripted turns and yields nothing after they run out", async () => {
    const provider = new FauxProvider([
      [{ type: "text_delta", text: "one" }],
      [{ type: "text_delta", text: "two" }],
    ]);

    expect(await collect(provider)).toEqual([{ type: "text_delta", text: "one" }]);
    expect(await collect(provider)).toEqual([{ type: "text_delta", text: "two" }]);
    expect(await collect(provider)).toEqual([]);
  });

  it("exposes a default model and accepts configured models", () => {
    const defaults = new FauxProvider();

    expect(defaults.models()).toEqual([
      { id: "faux-model", provider: "faux", contextWindow: 128_000, maxOutputTokens: 8_192 },
    ]);

    const configured: ModelInfo[] = [
      { id: "custom", provider: "faux-custom", contextWindow: 4_096 },
    ];
    const provider = new FauxProvider([], { models: configured });

    expect(provider.models()).toEqual(configured);
  });
});
