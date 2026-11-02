import { describe, expect, it } from "bun:test";
import { AgentEventSchema } from "../src/events.js";

const timestamp = "2026-11-02T10:00:00.000Z";
const sessionId = "session_1";
const turnId = "turn_1";
const messageId = "message_1";
const toolCallId = "call_1";

const validEvents = [
  { type: "agent_start", sessionId, timestamp },
  { type: "agent_end", sessionId, timestamp },
  {
    type: "turn_start",
    sessionId,
    turnId,
    turnNumber: 1,
    timestamp,
    input: { role: "user", text: "hello" },
  },
  { type: "turn_end", sessionId, turnId, timestamp, stopReason: "end" },
  {
    type: "user_message",
    sessionId,
    turnId,
    messageId,
    timestamp,
    delivery: "steer",
    message: { role: "user", text: "also check tests" },
  },
  { type: "message_start", sessionId, turnId, messageId, timestamp, role: "assistant" },
  {
    type: "message_delta",
    sessionId,
    turnId,
    messageId,
    timestamp,
    delta: { kind: "text", text: "hi" },
  },
  {
    type: "message_end",
    sessionId,
    turnId,
    messageId,
    timestamp,
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 8 },
  },
  {
    type: "tool_call_start",
    sessionId,
    turnId,
    messageId,
    timestamp,
    call: { id: toolCallId, name: "read_file", arguments: '{"path":"README.md"}' },
  },
  {
    type: "tool_execution_start",
    sessionId,
    turnId,
    toolCallId,
    name: "read_file",
    timestamp,
  },
  {
    type: "tool_execution_update",
    sessionId,
    turnId,
    toolCallId,
    timestamp,
    chunk: "partial",
  },
  {
    type: "tool_execution_end",
    sessionId,
    turnId,
    toolCallId,
    timestamp,
    result: {
      toolCallId,
      content: [{ type: "text", text: "file body" }],
      isError: false,
    },
  },
  {
    type: "approval_requested",
    sessionId,
    turnId,
    timestamp,
    approval: {
      id: "approval_1",
      kind: "tool",
      toolCallId,
      toolName: "bash",
      args: { command: "ls" },
      reason: "write outside workspace",
      createdAt: timestamp,
    },
  },
  {
    type: "approval_resolved",
    sessionId,
    turnId,
    timestamp,
    approvalId: "approval_1",
    resolution: {
      approvalId: "approval_1",
      decision: "approve_for_session",
      resolvedAt: timestamp,
    },
  },
  {
    type: "sandbox_decision",
    sessionId,
    turnId,
    timestamp,
    decision: {
      toolCallId,
      backend: "seatbelt",
      mode: "workspace-write",
      outcome: "deny",
      reason: "path outside workspace",
    },
  },
  {
    type: "compaction_start",
    sessionId,
    turnId,
    timestamp,
    reason: "threshold",
  },
  {
    type: "compaction_end",
    sessionId,
    turnId,
    timestamp,
    summary: "Earlier work is summarized.",
    replacedEntryIds: ["entry_1", "entry_2"],
    tokensBefore: 90000,
    tokensAfter: 12000,
    model: "gpt-5",
  },
  {
    type: "error",
    sessionId,
    turnId,
    timestamp,
    error: { code: "provider_error", message: "upstream failed", retryable: true },
  },
  { type: "settled", sessionId, timestamp },
] as const;

describe("AgentEventSchema", () => {
  it("accepts every event type", () => {
    for (const event of validEvents) {
      expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    }
  });

  it("rejects an event without a session id", () => {
    const result = AgentEventSchema.safeParse({ type: "settled", timestamp });
    expect(result.success).toBe(false);
  });

  it("rejects a turn event without a turn id", () => {
    const result = AgentEventSchema.safeParse({
      type: "message_start",
      sessionId,
      messageId,
      role: "assistant",
      timestamp,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid timestamp", () => {
    const result = AgentEventSchema.safeParse({
      type: "settled",
      sessionId,
      timestamp: "yesterday",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown delta kind", () => {
    const result = AgentEventSchema.safeParse({
      type: "message_delta",
      sessionId,
      turnId,
      messageId,
      timestamp,
      delta: { kind: "audio", text: "hello" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid stop reason", () => {
    const result = AgentEventSchema.safeParse({
      type: "turn_end",
      sessionId,
      turnId,
      timestamp,
      stopReason: "finished",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tool result without content", () => {
    const result = AgentEventSchema.safeParse({
      type: "tool_execution_end",
      sessionId,
      turnId,
      toolCallId,
      timestamp,
      result: { toolCallId, isError: false },
    });
    expect(result.success).toBe(false);
  });
});
