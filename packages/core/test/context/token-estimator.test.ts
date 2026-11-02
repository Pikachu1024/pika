import { describe, expect, it } from "vitest";
import { createTokenEstimator, estimateMessages } from "../../src/context/token-estimator.js";
import type { LlmMessage } from "../../src/provider.js";

describe("createTokenEstimator", () => {
  it("uses a four-characters-per-token heuristic by default", () => {
    const estimator = createTokenEstimator();

    expect(estimator.estimate("")).toBe(0);
    expect(estimator.estimate("abcd")).toBe(1);
    expect(estimator.estimate("abcde")).toBe(2);
  });

  it("accepts an injected estimate function", () => {
    const estimator = createTokenEstimator(() => 7);

    expect(estimator.estimate("anything")).toBe(7);
  });
});

describe("estimateMessages", () => {
  const messages: LlmMessage[] = [
    { role: "user", content: [{ type: "text", text: "abcd" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "abcd" }],
      toolCalls: [{ id: "call_1", name: "tool", arguments: "abcd" }],
    },
    { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "abcd" }] },
  ];

  it("sums content and tool call payloads with the default estimator", () => {
    expect(estimateMessages(messages)).toBe(5);
  });

  it("uses an injected estimator for every payload", () => {
    const estimator = createTokenEstimator(() => 7);

    expect(estimateMessages(messages, estimator)).toBe(35);
  });

  it("returns zero for no messages", () => {
    expect(estimateMessages([])).toBe(0);
  });
});
