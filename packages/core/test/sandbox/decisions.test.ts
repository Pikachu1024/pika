import { describe, expect, it } from "bun:test";
import type { SandboxPolicy, ToolCall } from "@pika-harness/schema";
import {
  canWidenPolicy,
  classifyToolCall,
  widenSandboxPolicy,
} from "../../src/sandbox/decisions.js";
import { resolveSandboxPolicy } from "../../src/sandbox/policy.js";
import type { Tool } from "../../src/tools.js";

const call: ToolCall = { id: "call_1", name: "bash", arguments: "{}" };

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "bash",
    description: "test",
    schema: {} as Tool["schema"],
    sandbox: { write: false, arbitraryProcess: true },
    async execute() {
      return { content: [], isError: false };
    },
    ...overrides,
  };
}

function policy(mode: SandboxPolicy["mode"], workspaceRoot = "/workspace"): SandboxPolicy {
  return resolveSandboxPolicy({ mode, workspaceRoot });
}

describe("classifyToolCall", () => {
  it("denies arbitrary processes in read-only mode", () => {
    const result = classifyToolCall({
      call,
      tool: tool(),
      policy: policy("read-only"),
      backend: "seatbelt",
      approvalMode: "on-request",
    });

    expect(result.decision).toMatchObject({ outcome: "deny", mode: "read-only" });
    expect(result.escalation).toBe("process");
  });

  it("denies writes in read-only mode", () => {
    const result = classifyToolCall({
      call,
      tool: tool({ sandbox: { write: true, arbitraryProcess: false } }),
      policy: policy("read-only"),
      backend: "none",
      approvalMode: "on-request",
    });

    expect(result.decision.outcome).toBe("deny");
    expect(result.escalation).toBe("filesystem");
  });

  it("allows reads in read-only mode", () => {
    const result = classifyToolCall({
      call,
      tool: tool({ sandbox: { write: false, arbitraryProcess: false } }),
      policy: policy("read-only"),
      backend: "none",
      approvalMode: "on-request",
    });

    expect(result.decision.outcome).toBe("allow");
  });

  it("requires approval for writes and shells in untrusted mode", () => {
    const result = classifyToolCall({
      call,
      tool: tool(),
      policy: policy("workspace-write"),
      backend: "seatbelt",
      approvalMode: "untrusted",
    });

    expect(result.decision.outcome).toBe("deny");
    expect(result.decision.reason).toContain("untrusted");
    expect(result.escalation).toBeUndefined();
  });

  it("allows everything under danger-full-access", () => {
    const result = classifyToolCall({
      call,
      tool: tool(),
      policy: policy("danger-full-access"),
      backend: "none",
      approvalMode: "untrusted",
    });

    expect(result.decision.outcome).toBe("allow");
  });
});

describe("widenSandboxPolicy", () => {
  it("widens read-only to workspace-write and grants the workspace", () => {
    const widened = widenSandboxPolicy(policy("read-only"), "process");
    expect(widened.mode).toBe("workspace-write");
    expect(widened.writableRoots).toEqual(["/workspace"]);
  });

  it("widens network one step at a time", () => {
    const proxy = widenSandboxPolicy(policy("workspace-write"), "network");
    expect(proxy.network).toBe("proxy");
    expect(widenSandboxPolicy(proxy, "network").network).toBe("full");
  });

  it("reports whether a widening remains", () => {
    expect(canWidenPolicy(policy("read-only"), "filesystem")).toBe(true);
    expect(canWidenPolicy(policy("danger-full-access"), "filesystem")).toBe(false);
    expect(canWidenPolicy(policy("workspace-write"), "network")).toBe(true);
    expect(canWidenPolicy({ ...policy("workspace-write"), network: "full" }, "network")).toBe(
      false,
    );
  });
});
