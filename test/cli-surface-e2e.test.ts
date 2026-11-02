import { afterEach, describe, expect, it } from "bun:test";
import { createWebSocketClientTransport, PikaClient } from "@pika-harness/client";
import type { LlmEvent } from "@pika-harness/core";
import { FauxProvider } from "@pika-harness/core";
import { startWebSocketServer } from "@pika-harness/server";
import { collectUntilSettled, createTestServer } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

describe("cli command surface over websocket", () => {
  it("forks with a new model, compacts manually, and asks a side question", async () => {
    const env = await createTestServer({
      provider: new FauxProvider([longTurn, longTurn, summaryTurn, sideTurn]),
      compaction: (_context, provider) => ({
        contextWindow: 1_000_000,
        reserveTokens: 0,
        keepRecentTurns: 1,
        summarize: async (messages) => {
          let text = "";
          for await (const event of provider.stream(
            { model: "faux-model", system: "", messages, tools: [] },
            new AbortController().signal,
          )) {
            if (event.type === "text_delta") text += event.text;
            else if (event.type === "error") throw new Error(event.error.message);
            else if (event.type === "done") break;
          }
          return text;
        },
      }),
    });
    const handle = await startWebSocketServer({
      port: 0,
      onConnection: (transport) => {
        env.server.attach(transport);
      },
    });
    const client = new PikaClient({
      transport: createWebSocketClientTransport(handle.url),
      clientName: "cli-surface-e2e",
    });
    cleanups.push(async () => {
      client.close();
      await handle.close();
      await env.cleanup();
    });
    await client.initialize();

    const started = await client.startSession({ cwd: ".", model: "faux-model" });
    const subscription = await client.subscribe(started.session.id);

    await client.prompt(started.session.id, "first");
    await collectUntilSettled(subscription);
    await client.prompt(started.session.id, "second");
    await collectUntilSettled(subscription);

    const compacted = await client.compactSession(started.session.id);
    expect(compacted.compacted).toBe(true);
    expect(compacted.tokensBefore).toBeGreaterThan(compacted.tokensAfter);

    const side = await client.askSideQuestion(started.session.id, "why?");
    expect(side.text).toBe("side answer");

    const source = (await client.listSessions()).find(
      (session) => session.id === started.session.id,
    );
    if (source?.lastEntryId === undefined || source.lastEntryId === null) {
      throw new Error("missing source entry");
    }
    const forked = await client.forkSession(started.session.id, source.lastEntryId, {
      model: "next-model",
      llm: { baseUrl: "http://127.0.0.1:59000/v1", model: "next-model" },
    });
    expect(forked.session.model).toBe("next-model");

    const sessions = await client.listSessions();
    expect(sessions.find((session) => session.id === forked.session.id)?.model).toBe("next-model");
    expect(sessions.find((session) => session.id === started.session.id)).toMatchObject({
      model: "faux-model",
      lastEntryId: source.lastEntryId,
    });
  });
});
