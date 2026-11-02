import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@pika-harness/schema";
import { createProjectionPipeline } from "../../src/context/pipeline.js";
import { estimateMessages } from "../../src/context/token-estimator.js";

function entry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "user_message",
      sessionId: "session_pipeline",
      turnId: "turn_1",
      timestamp: "2026-01-01T00:00:00.000Z",
      messageId: "msg_1",
      delivery: "prompt",
      message: { role: "user", text },
    },
  };
}

const entries: SessionEntry[] = [entry("e1", null, "hello"), entry("e2", "e1", "again")];

describe("createProjectionPipeline", () => {
  it("injects reminders into the last user message without mutating the log", () => {
    const pipeline = createProjectionPipeline();
    const snapshot = structuredClone(entries);

    const result = pipeline.project({
      entries,
      system: "sys",
      tools: [],
      reminders: ["keep it short"],
    });

    expect(entries).toEqual(snapshot);
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "again" },
        { type: "text", text: "<system-reminder>\nkeep it short\n</system-reminder>" },
      ],
    });
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies provider conversion after reminders and hashes the converted prompt", () => {
    const pipeline = createProjectionPipeline();
    const result = pipeline.project({
      entries,
      system: "sys",
      tools: [],
      reminders: ["reminder"],
      convert: (messages) => messages.slice(-1),
    });

    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result.messages)).toContain("reminder");
    expect(result.promptHash).not.toBe(
      pipeline.project({ entries, system: "sys", tools: [] }).promptHash,
    );
  });

  it("estimates tokens and records cache usage", () => {
    const pipeline = createProjectionPipeline();
    const result = pipeline.project({
      entries,
      system: "sys",
      tools: [],
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 3 },
    });

    expect(result.estimatedTokens).toBe(estimateMessages(result.messages));
    expect(result.cache).toEqual({ readTokens: 7, writeTokens: 3 });
    expect(pipeline.project({ entries, system: "sys", tools: [] }).cache).toEqual({
      readTokens: 0,
      writeTokens: 0,
    });
  });

  it("repairs orphan tool calls while leaving the stored log unchanged", () => {
    const orphan: SessionEntry[] = [
      {
        id: "e1",
        parentId: null,
        event: {
          type: "message_start",
          sessionId: "session_pipeline",
          turnId: "turn_1",
          timestamp: "2026-01-01T00:00:00.000Z",
          messageId: "msg_1",
          role: "assistant",
        },
      },
      {
        id: "e2",
        parentId: "e1",
        event: {
          type: "tool_call_start",
          sessionId: "session_pipeline",
          turnId: "turn_1",
          timestamp: "2026-01-01T00:00:00.000Z",
          messageId: "msg_1",
          call: { id: "call_1", name: "read_file", arguments: "{}" },
        },
      },
    ];
    const snapshot = structuredClone(orphan);
    const result = createProjectionPipeline().project({ entries: orphan, system: "", tools: [] });

    expect(result.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      content: [{ type: "error" }],
    });
    expect(orphan).toEqual(snapshot);
  });
});
