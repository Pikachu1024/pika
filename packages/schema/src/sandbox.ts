import { z } from "zod";

export const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const NetworkPolicySchema = z.enum(["none", "proxy", "full"]);
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

export const SandboxBackendSchema = z.enum(["none", "seatbelt", "bwrap", "docker"]);
export type SandboxBackend = z.infer<typeof SandboxBackendSchema>;

const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TERM"];

export const SandboxPolicySchema = z.object({
  mode: SandboxModeSchema,
  /** Canonical workspace root; read-only policies still allow reads beneath it. */
  workspaceRoot: z.string().default(""),
  writableRoots: z.array(z.string().min(1)).default([]),
  deniedReads: z.array(z.string().min(1)).default([]),
  network: NetworkPolicySchema.default("none"),
  envAllowlist: z.array(z.string().min(1)).default(DEFAULT_ENV_ALLOWLIST),
  timeoutMs: z.number().int().positive().default(120_000),
  maxOutputBytes: z.number().int().positive().default(1_048_576),
});

export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export const SandboxDecisionSchema = z.object({
  toolCallId: z.string().min(1).optional(),
  backend: SandboxBackendSchema,
  mode: SandboxModeSchema,
  outcome: z.enum(["allow", "deny"]),
  reason: z.string().min(1),
});

export type SandboxDecision = z.infer<typeof SandboxDecisionSchema>;
