import { describe, expect, it } from "bun:test";
import type { SessionMeta } from "@pika-harness/schema";
import { createIdGenerator } from "../../src/clock.js";
import { createEventCollector } from "../../src/events.js";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import { createRuntime } from "../../src/runtime/runtime.js";
import { MemorySessionStore } from "../../src/session/memory-store.js";
import { loadResumeState, replaySession } from "../../src/session/replay.js";

function meta(id: string): SessionMeta {
  return { id, cwd: "/work", model: "faux-model", createdAt: "2026-11-02T12:00:00.000Z" };
}

const turn = (text: string) => [
  { type: "text_delta" as const, text },
  { type: "done" as const, stopReason: "end" as const },
];

describe("loadResumeState", () => {
  it("rebuilds history and continues from a settled session", async () => {
    const store = new MemorySessionStore({ ids: createIdGenerator() });
    await store.create(meta("session_resume"));
    const first = new FauxProvider([turn("hello back")]);
    const firstRuntime = createRuntime({
      sessionId: "session_resume",
      model: "faux-model",
      provider: first,
      sessionStore: store,
      eventSink: createEventCollector(),
      ids: createIdGenerator(),
    });
    await firstRuntime.prompt("hello");
    await firstRuntime.settled();

    const resumed = await loadResumeState(store, "session_resume");
    expect(resumed.summary.status).toBe("settled");
    expect(resumed.history.map((message) => message.role)).toEqual(["user", "assistant"]);

    const second = new FauxProvider([turn("continued")]);
    const secondRuntime = createRuntime({
      sessionId: "session_resume",
      model: "faux-model",
      provider: second,
      sessionStore: store,
      eventSink: createEventCollector(),
      ids: createIdGenerator(),
      initialHistory: resumed.history.map((message) => ({ message })),
    });
    await secondRuntime.prompt("again");
    await secondRuntime.settled();

    expect(second.requests[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(second.requests[0]?.messages[2])).toContain("again");

    const replay = replaySession({ entries: await store.entries("session_resume") });
    expect(replay.promptChecks).toHaveLength(2);
    expect(replay.promptChecks.every((check) => check.matches)).toBe(true);
  });

  it("rejects a session that is not settled", async () => {
    const store = new MemorySessionStore({ ids: createIdGenerator() });
    await store.create(meta("session_open"));

    await expect(loadResumeState(store, "session_open")).rejects.toThrow(/settled/);
    await expect(loadResumeState(store, "session_missing")).rejects.toThrow(/not found/);
  });
});
