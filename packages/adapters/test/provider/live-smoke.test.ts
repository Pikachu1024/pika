import { describe, expect, it } from "bun:test";
import { getModel } from "@mariozechner/pi-ai";
import { PiAiProvider } from "../../src/provider/pi-ai-provider.js";

// Opt-in only: live providers cost money and are non-deterministic. The default
// `bun test` run skips this file.
const enabled =
  process.env.PIKA_LIVE_SMOKE === "1" && (process.env.OPENAI_API_KEY?.length ?? 0) > 0;

describe.skipIf(!enabled)("live provider smoke", () => {
  it("streams text and completes", async () => {
    const provider = new PiAiProvider({
      model: getModel("openai", "gpt-4o-mini"),
      apiKey: process.env.OPENAI_API_KEY ?? "",
    });
    const events = [];
    for await (const event of provider.stream(
      {
        model: "gpt-4o-mini",
        system: "Answer with one word.",
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with pong." }] }],
        tools: [],
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  }, 30_000);
});
