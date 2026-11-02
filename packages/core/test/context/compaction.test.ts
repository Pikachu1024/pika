import { describe, expect, it } from "bun:test";
import { createCompactionPolicy, planCompaction } from "../../src/context/compaction.js";
import type { LlmMessage } from "../../src/provider.js";

function user(text: string): LlmMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): LlmMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

const messages: LlmMessage[] = [
  user("one"),
  assistant("a1"),
  user("two"),
  assistant("a2"),
  user("three"),
  assistant("a3"),
];

describe("createCompactionPolicy", () => {
  const policy = createCompactionPolicy();

  it("compacts only above the window minus reserve boundary", () => {
    expect(policy.shouldCompact(60, 100, 40)).toBe(false);
    expect(policy.shouldCompact(61, 100, 40)).toBe(true);
    expect(policy.shouldCompact(100, 100, 0)).toBe(false);
    expect(policy.shouldCompact(101, 100, 0)).toBe(true);
    expect(policy.shouldCompact(0, 0, 0)).toBe(false);
  });
});

describe("planCompaction", () => {
  it("reports tokens and the boundary before the recent turns", () => {
    const plan = planCompaction(messages, {
      contextWindow: 5,
      reserveTokens: 0,
      keepRecentTurns: 2,
    });

    expect(plan).toEqual({ needed: true, cutIndex: 2, tokensBefore: 7 });
  });

  it("does not need compaction when the reserve keeps tokens under the boundary", () => {
    const plan = planCompaction(messages, {
      contextWindow: 10,
      reserveTokens: 3,
      keepRecentTurns: 2,
    });

    expect(plan.needed).toBe(false);
    expect(plan.tokensBefore).toBe(7);
    expect(plan.cutIndex).toBe(2);
  });

  it("sets the cut index at the start of the earliest kept turn", () => {
    expect(
      planCompaction(messages, { contextWindow: 0, reserveTokens: 0, keepRecentTurns: 1 }).cutIndex,
    ).toBe(4);
    expect(
      planCompaction(messages, { contextWindow: 0, reserveTokens: 0, keepRecentTurns: 3 }).cutIndex,
    ).toBe(0);
    expect(
      planCompaction(messages, { contextWindow: 0, reserveTokens: 0, keepRecentTurns: 9 }).cutIndex,
    ).toBe(0);
    expect(
      planCompaction(messages, { contextWindow: 0, reserveTokens: 0, keepRecentTurns: 0 }).cutIndex,
    ).toBe(6);
  });

  it("does not need compaction when there is no older turn to cut", () => {
    const plan = planCompaction(messages, {
      contextWindow: 0,
      reserveTokens: 0,
      keepRecentTurns: 3,
    });

    expect(plan.cutIndex).toBe(0);
    expect(plan.needed).toBe(false);
  });

  it("handles an empty log", () => {
    const plan = planCompaction([], { contextWindow: 100, reserveTokens: 10, keepRecentTurns: 2 });

    expect(plan).toEqual({ needed: false, cutIndex: 0, tokensBefore: 0 });
  });
});
