import { describe, expect, it } from "vitest";
import { ApprovalRequestSchema, ApprovalResolutionSchema } from "../src/approvals.js";

const timestamp = "2026-11-02T10:00:00.000Z";

const request = {
  id: "approval_1",
  kind: "tool",
  toolCallId: "call_1",
  toolName: "bash",
  args: { command: "rm -rf build" },
  reason: "destructive command",
  createdAt: timestamp,
};

const resolution = {
  approvalId: "approval_1",
  decision: "approve",
  resolvedAt: timestamp,
};

describe("ApprovalRequestSchema", () => {
  it("accepts a tool approval request", () => {
    expect(ApprovalRequestSchema.safeParse(request).success).toBe(true);
  });

  it("accepts a sandbox escalation request", () => {
    expect(ApprovalRequestSchema.safeParse({ ...request, kind: "sandbox-escalation" }).success).toBe(
      true,
    );
  });

  it("rejects a missing reason", () => {
    const { reason: _reason, ...withoutReason } = request;
    expect(ApprovalRequestSchema.safeParse(withoutReason).success).toBe(false);
  });

  it("rejects non-object args", () => {
    expect(ApprovalRequestSchema.safeParse({ ...request, args: "rm -rf build" }).success).toBe(false);
  });
});

describe("ApprovalResolutionSchema", () => {
  it("accepts a decision", () => {
    expect(ApprovalResolutionSchema.safeParse(resolution).success).toBe(true);
  });

  it("rejects an unknown decision", () => {
    expect(
      ApprovalResolutionSchema.safeParse({ ...resolution, decision: "maybe" }).success,
    ).toBe(false);
  });
});
