import { describe, expect, it } from "bun:test";
import { AgentCommandSchema, StopReasonSchema, UserMessageSchema } from "../src/turns.js";

describe("AgentCommandSchema", () => {
  it("accepts prompt, steer, follow-up, and interrupt commands", () => {
    const commands = [
      { type: "prompt", text: "hello" },
      { type: "steer", text: "focus on tests" },
      { type: "follow_up", text: "then commit" },
      { type: "interrupt", reason: "user cancelled" },
    ];

    for (const command of commands) {
      expect(AgentCommandSchema.safeParse(command).success, command.type).toBe(true);
    }
  });

  it("rejects an empty prompt", () => {
    expect(AgentCommandSchema.safeParse({ type: "prompt", text: "" }).success).toBe(false);
  });

  it("rejects an unknown command type", () => {
    expect(AgentCommandSchema.safeParse({ type: "pause", text: "wait" }).success).toBe(false);
  });
});

describe("UserMessageSchema", () => {
  it("accepts a user message", () => {
    expect(UserMessageSchema.safeParse({ role: "user", text: "hello" }).success).toBe(true);
  });

  it("rejects an assistant message", () => {
    expect(UserMessageSchema.safeParse({ role: "assistant", text: "hello" }).success).toBe(false);
  });
});

describe("StopReasonSchema", () => {
  it("rejects an unknown stop reason", () => {
    expect(StopReasonSchema.safeParse("finished").success).toBe(false);
  });
});
