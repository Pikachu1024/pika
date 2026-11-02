import type { ContentPart, SessionEntry } from "@pika-harness/schema";
import { describe, expect, it } from "vitest";
import { createContextProjector } from "../../src/context/projection.js";

const timestamp = "2026-11-02T10:00:00.000Z";
const sessionId = "session_1";
const turnId = "turn_1";

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "user_message",
      sessionId,
      turnId,
      timestamp,
      messageId: `message_${id}`,
      delivery: "prompt",
      message: { role: "user", text },
    },
  };
}

function messageStart(id: string, parentId: string | null, messageId: string): SessionEntry {
  return {
    id,
    parentId,
    event: { type: "message_start", sessionId, turnId, timestamp, messageId, role: "assistant" },
  };
}

function textDelta(
  id: string,
  parentId: string | null,
  messageId: string,
  text: string,
): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "message_delta",
      sessionId,
      turnId,
      timestamp,
      messageId,
      delta: { kind: "text", text },
    },
  };
}

function reasoningDelta(
  id: string,
  parentId: string | null,
  messageId: string,
  text: string,
): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "message_delta",
      sessionId,
      turnId,
      timestamp,
      messageId,
      delta: { kind: "reasoning", text },
    },
  };
}

function messageEnd(id: string, parentId: string | null, messageId: string): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "message_end",
      sessionId,
      turnId,
      timestamp,
      messageId,
      stopReason: "end",
    },
  };
}

function toolCallStart(
  id: string,
  parentId: string | null,
  messageId: string,
  callId: string,
  name: string,
  args: string,
): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "tool_call_start",
      sessionId,
      turnId,
      timestamp,
      messageId,
      call: { id: callId, name, arguments: args },
    },
  };
}

function toolResult(
  id: string,
  parentId: string | null,
  callId: string,
  content: ContentPart[],
): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "tool_execution_end",
      sessionId,
      turnId,
      timestamp,
      toolCallId: callId,
      result: { toolCallId: callId, content, isError: false },
    },
  };
}

function compactionEnd(
  id: string,
  parentId: string | null,
  summary: string,
  replacedEntryIds: string[],
): SessionEntry {
  return {
    id,
    parentId,
    event: {
      type: "compaction_end",
      sessionId,
      turnId,
      timestamp,
      summary,
      replacedEntryIds,
      tokensBefore: 100,
      tokensAfter: 10,
      model: "test-model",
    },
  };
}

describe("createContextProjector", () => {
  it("maps messages, aggregates deltas, and pairs tool calls with results", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "hello"),
      messageStart("e2", "e1", "m2"),
      textDelta("e3", "e2", "m2", "I will read."),
      reasoningDelta("e4", "e3", "m2", "hidden reasoning"),
      messageEnd("e5", "e4", "m2"),
      toolCallStart("e6", "e5", "m2", "call_1", "read_file", '{"path":"a"}'),
      toolResult("e7", "e6", "call_1", [{ type: "text", text: "contents" }]),
      messageStart("e8", "e7", "m3"),
      textDelta("e9", "e8", "m3", "Done."),
      messageEnd("e10", "e9", "m3"),
    ];
    const projector = createContextProjector();

    const { messages } = projector.project({ entries, system: "sys", tools: [] });

    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will read." }],
        toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a"}' }],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        toolName: "read_file",
        content: [{ type: "text", text: "contents" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    expect(JSON.stringify(messages)).not.toContain("hidden reasoning");
  });

  it("projects the same log identically without mutating entries", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "first"),
      messageStart("e2", "e1", "m1"),
      textDelta("e3", "e2", "m1", "answer"),
      messageEnd("e4", "e3", "m1"),
    ];
    const snapshot = structuredClone(entries);
    const projector = createContextProjector();
    const input = { entries, system: "sys", tools: [] };

    const first = projector.project(input);
    const second = projector.project(input);

    expect(second.messages).toEqual(first.messages);
    expect(second.promptHash).toBe(first.promptHash);
    expect(first.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entries).toEqual(snapshot);
  });

  it("changes the prompt hash when the system prompt changes", () => {
    const entries: SessionEntry[] = [userEntry("e1", null, "hello")];
    const projector = createContextProjector();

    const first = projector.project({ entries, system: "system one", tools: [] });
    const second = projector.project({ entries, system: "system two", tools: [] });

    expect(second.promptHash).not.toBe(first.promptHash);
  });

  it("inserts a synthetic error result for an orphan tool call", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "hello"),
      messageStart("e2", "e1", "m2"),
      toolCallStart("e3", "e2", "m2", "call_9", "write_file", "{}"),
      messageEnd("e4", "e3", "m2"),
    ];
    const snapshot = structuredClone(entries);
    const projector = createContextProjector();

    const { messages } = projector.project({ entries, system: "sys", tools: [] });

    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "tool",
      toolCallId: "call_9",
      content: [{ type: "error", message: 'Missing tool result for tool call "write_file".' }],
    });
    expect(entries).toEqual(snapshot);
  });

  it("applies a compaction summary and keeps recent entries", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "old question"),
      messageStart("e2", "e1", "m2"),
      textDelta("e3", "e2", "m2", "old answer"),
      messageEnd("e4", "e3", "m2"),
      compactionEnd("e5", "e4", "Earlier we discussed X.", ["e1", "e2", "e3", "e4"]),
      userEntry("e6", "e5", "new question"),
      messageStart("e7", "e6", "m3"),
      textDelta("e8", "e7", "m3", "new answer"),
      messageEnd("e9", "e8", "m3"),
    ];
    const projector = createContextProjector();

    const { messages } = projector.project({ entries, system: "sys", tools: [] });

    expect(messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "[compacted context]\nEarlier we discussed X." }],
      },
      { role: "user", content: [{ type: "text", text: "new question" }] },
      { role: "assistant", content: [{ type: "text", text: "new answer" }] },
    ]);
    expect(JSON.stringify(messages)).not.toContain("old question");
    expect(JSON.stringify(messages)).not.toContain("old answer");
  });

  it("projects only the active branch ending at the last entry", () => {
    const entries: SessionEntry[] = [
      userEntry("e1", null, "root"),
      messageStart("e2", "e1", "m2"),
      textDelta("e3", "e2", "m2", "first answer"),
      messageEnd("e4", "e3", "m2"),
      userEntry("e5", "e4", "left branch"),
      userEntry("e6", "e4", "right branch"),
    ];
    const projector = createContextProjector();

    const { messages } = projector.project({ entries, system: "sys", tools: [] });

    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "root" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: [{ type: "text", text: "right branch" }] },
    ]);
    expect(JSON.stringify(messages)).not.toContain("left branch");
  });
});
