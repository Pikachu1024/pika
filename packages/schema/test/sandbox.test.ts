import { describe, expect, it } from "bun:test";
import { SandboxDecisionSchema, SandboxPolicySchema } from "../src/sandbox.js";

describe("SandboxPolicySchema", () => {
  it("applies safe defaults", () => {
    const result = SandboxPolicySchema.parse({ mode: "read-only" });
    expect(result.network).toBe("none");
    expect(result.timeoutMs).toBe(120_000);
    expect(result.maxOutputBytes).toBe(1_048_576);
    expect(result.envAllowlist).toContain("PATH");
  });

  it("accepts workspace-write policy", () => {
    const result = SandboxPolicySchema.safeParse({
      mode: "workspace-write",
      writableRoots: ["/workspace/project"],
      deniedReads: ["/home/user/.ssh"],
      network: "proxy",
      envAllowlist: ["PATH", "HOME"],
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(SandboxPolicySchema.safeParse({ mode: "read-write" }).success).toBe(false);
  });

  it("rejects an unknown network policy", () => {
    expect(
      SandboxPolicySchema.safeParse({ mode: "workspace-write", network: "allowlist" }).success,
    ).toBe(false);
  });

  it("rejects a non-positive timeout", () => {
    expect(SandboxPolicySchema.safeParse({ mode: "read-only", timeoutMs: 0 }).success).toBe(false);
  });
});

describe("SandboxDecisionSchema", () => {
  it("accepts an allow decision", () => {
    const result = SandboxDecisionSchema.safeParse({
      toolCallId: "call_1",
      backend: "seatbelt",
      mode: "workspace-write",
      outcome: "allow",
      reason: "path inside workspace",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown backend", () => {
    const result = SandboxDecisionSchema.safeParse({
      backend: "firecracker",
      mode: "read-only",
      outcome: "deny",
      reason: "not supported",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown outcome", () => {
    const result = SandboxDecisionSchema.safeParse({
      backend: "none",
      mode: "read-only",
      outcome: "maybe",
      reason: "unknown",
    });
    expect(result.success).toBe(false);
  });
});
