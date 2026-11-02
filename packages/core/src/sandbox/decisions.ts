import type {
  SandboxBackend,
  SandboxDecision,
  SandboxMode,
  SandboxPolicy,
  ToolCall,
} from "@pika-harness/schema";
import { SandboxPolicySchema } from "@pika-harness/schema";
import type { Tool } from "../tools.js";

export type ApprovalMode = "untrusted" | "on-failure" | "on-request" | "never";

export type SandboxEscalationKind = "filesystem" | "process" | "network";

export interface ToolAuthorization {
  decision: SandboxDecision;
  /** What the user would have to widen if the denial is escalated. */
  escalation?: SandboxEscalationKind;
}

const MODE_RANK: Record<SandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

const NEXT_MODE: Record<SandboxMode, SandboxMode> = {
  "read-only": "workspace-write",
  "workspace-write": "danger-full-access",
  "danger-full-access": "danger-full-access",
};

/** Classifies a tool call against the effective policy before it runs. */
export function classifyToolCall(options: {
  call: ToolCall;
  tool: Tool;
  policy: SandboxPolicy;
  backend: SandboxBackend;
  approvalMode: ApprovalMode;
}): ToolAuthorization {
  const { call, tool, policy, backend, approvalMode } = options;
  const profile = tool.sandbox ?? { write: false, arbitraryProcess: false };
  const decision = (outcome: "allow" | "deny", reason: string): SandboxDecision => ({
    toolCallId: call.id,
    backend,
    mode: policy.mode,
    outcome,
    reason,
  });

  if (policy.mode === "danger-full-access") {
    return { decision: decision("allow", "danger-full-access permits every tool") };
  }

  if (policy.mode === "read-only") {
    if (profile.write) {
      return {
        decision: decision("deny", `write access denied by read-only policy for ${tool.name}`),
        escalation: "filesystem",
      };
    }
    if (profile.arbitraryProcess) {
      return {
        decision: decision("deny", `process execution denied by read-only policy for ${tool.name}`),
        escalation: "process",
      };
    }
    return { decision: decision("allow", "read-only policy permits this tool") };
  }

  if (approvalMode === "untrusted" && (profile.write || profile.arbitraryProcess)) {
    return {
      decision: decision("deny", `untrusted mode requires approval before running ${tool.name}`),
    };
  }

  return { decision: decision("allow", "workspace-write policy permits this tool") };
}

/** Returns the smallest policy widening for an escalation, never narrowing other fields. */
export function widenSandboxPolicy(
  policy: SandboxPolicy,
  kind: SandboxEscalationKind,
): SandboxPolicy {
  if (kind === "network") {
    return SandboxPolicySchema.parse({
      ...policy,
      network: policy.network === "none" ? "proxy" : "full",
    });
  }
  const mode = NEXT_MODE[policy.mode];
  return SandboxPolicySchema.parse({
    ...policy,
    mode,
    writableRoots:
      policy.mode === "read-only" && policy.workspaceRoot !== ""
        ? [policy.workspaceRoot]
        : policy.writableRoots,
  });
}

/** Whether an escalation could widen anything for the given policy. */
export function canWidenPolicy(policy: SandboxPolicy, kind: SandboxEscalationKind): boolean {
  if (kind === "network") {
    return policy.network !== "full";
  }
  return MODE_RANK[policy.mode] < MODE_RANK["danger-full-access"];
}

const NETWORK_DENIAL =
  /network|socket|connect|dns|resolve host|name or service not known|operation not permitted.*(?:bind|connect)/i;

/** Maps a backend denial message onto the policy axis that has to widen. */
export function classifyDenialReason(reason: string): SandboxEscalationKind {
  if (NETWORK_DENIAL.test(reason)) {
    return "network";
  }
  return "filesystem";
}
