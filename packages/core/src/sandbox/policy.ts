import path from "node:path";
import type { SandboxMode, SandboxPolicy } from "@pika-harness/schema";
import { SandboxPolicySchema } from "@pika-harness/schema";

type NetworkPolicy = SandboxPolicy["network"];

const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TERM"];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

const MODE_RANK: Record<SandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

const NETWORK_RANK: Record<NetworkPolicy, number> = { none: 0, proxy: 1, full: 2 };

export interface ResolveSandboxPolicyInput {
  mode: SandboxMode;
  workspaceRoot: string;
  writableRoots?: readonly string[];
  deniedReads?: readonly string[];
  network?: NetworkPolicy;
  envAllowlist?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ClampSandboxPolicyResult {
  policy: SandboxPolicy;
  violations: string[];
}

/** Raised when a requested sandbox policy cannot be resolved. */
export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

/** Resolves a validated sandbox policy, normalizing roots and enforcing mode rules. */
export function resolveSandboxPolicy(input: ResolveSandboxPolicyInput): SandboxPolicy {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const requestedWritableRoots = (input.writableRoots ?? []).map((root) =>
    path.resolve(workspaceRoot, root),
  );
  const policy: SandboxPolicy = {
    mode: input.mode,
    workspaceRoot,
    writableRoots: resolveWritableRoots(input.mode, workspaceRoot, requestedWritableRoots),
    deniedReads: dedupe((input.deniedReads ?? []).map((root) => path.resolve(workspaceRoot, root))),
    network: input.network ?? "none",
    envAllowlist: dedupe(input.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
  return SandboxPolicySchema.parse(policy);
}

/** Clamps a requested policy to its parent and reports every widening it removed. */
export function clampSandboxPolicy(
  parent: SandboxPolicy,
  requested: SandboxPolicy,
): ClampSandboxPolicyResult {
  const violations: string[] = [];
  const mode = clampMode(parent.mode, requested.mode, violations);
  const timeoutMs = Math.min(parent.timeoutMs, requested.timeoutMs);
  const maxOutputBytes = Math.min(parent.maxOutputBytes, requested.maxOutputBytes);
  if (timeoutMs !== requested.timeoutMs) {
    violations.push(`timeout clamped from ${requested.timeoutMs}ms to ${timeoutMs}ms`);
  }
  if (maxOutputBytes !== requested.maxOutputBytes) {
    violations.push(
      `max output clamped from ${requested.maxOutputBytes} bytes to ${maxOutputBytes} bytes`,
    );
  }
  const policy: SandboxPolicy = {
    mode,
    workspaceRoot: parent.workspaceRoot,
    writableRoots: clampWritableRoots(parent, requested.writableRoots, mode, violations),
    deniedReads: mergeDeniedReads(parent.deniedReads, requested.deniedReads, violations),
    network: clampNetwork(parent.network, requested.network, violations),
    envAllowlist: intersectEnvAllowlist(parent.envAllowlist, requested.envAllowlist, violations),
    timeoutMs,
    maxOutputBytes,
  };
  return { policy: SandboxPolicySchema.parse(policy), violations };
}

// Read-only requests that carry write roots are rejected rather than silently
// dropped so a misconfigured caller fails loudly instead of running with a mode
// it did not ask for.
function resolveWritableRoots(
  mode: SandboxMode,
  workspaceRoot: string,
  requested: readonly string[],
): string[] {
  if (mode === "read-only") {
    if (requested.length > 0) {
      throw new SandboxPolicyError(
        `read-only policies cannot declare writable roots: ${requested.join(", ")}`,
      );
    }
    return [];
  }
  if (mode === "danger-full-access") {
    // POSIX only: the writable root is the filesystem root, so extra roots add nothing.
    return [path.parse(workspaceRoot).root];
  }
  const outside = requested.filter((root) => !isInsidePath(root, workspaceRoot));
  if (outside.length > 0) {
    throw new SandboxPolicyError(
      `writable roots must resolve inside the workspace: ${outside.join(", ")}`,
    );
  }
  return dedupe([workspaceRoot, ...requested]);
}

function clampMode(parent: SandboxMode, requested: SandboxMode, violations: string[]): SandboxMode {
  if (MODE_RANK[requested] <= MODE_RANK[parent]) return requested;
  violations.push(`sandbox mode clamped from ${requested} to ${parent}`);
  return parent;
}

function clampNetwork(
  parent: NetworkPolicy,
  requested: NetworkPolicy,
  violations: string[],
): NetworkPolicy {
  if (NETWORK_RANK[requested] <= NETWORK_RANK[parent]) return requested;
  violations.push(`network policy clamped from ${requested} to ${parent}`);
  return parent;
}

function clampWritableRoots(
  parent: SandboxPolicy,
  requestedRoots: readonly string[],
  mode: SandboxMode,
  violations: string[],
): string[] {
  const requested = requestedRoots.map((root) => path.resolve(root));
  if (mode === "read-only") {
    if (requested.length > 0) {
      violations.push(
        `writable roots dropped because the effective mode is read-only: ${requested.join(", ")}`,
      );
    }
    return [];
  }
  const parentRoots = parent.writableRoots.map((root) => path.resolve(root));
  const kept = requested.filter((root) =>
    parentRoots.some((parentRoot) => isInsidePath(root, parentRoot)),
  );
  const dropped = requested.filter((root) => !kept.includes(root));
  if (dropped.length > 0) {
    violations.push(`writable roots outside the parent policy dropped: ${dropped.join(", ")}`);
  }
  return dedupe(kept);
}

// Denied reads only ever grow: a child cannot re-open a path its parent denied.
function mergeDeniedReads(
  parentReads: readonly string[],
  requestedReads: readonly string[],
  violations: string[],
): string[] {
  const parent = parentReads.map((root) => path.resolve(root));
  const requested = requestedReads.map((root) => path.resolve(root));
  const omitted = parent.filter((root) => !requested.includes(root));
  if (omitted.length > 0) {
    violations.push(`parent denied reads re-applied: ${omitted.join(", ")}`);
  }
  return dedupe([...parent, ...requested]);
}

function intersectEnvAllowlist(
  parentList: readonly string[],
  requestedList: readonly string[],
  violations: string[],
): string[] {
  const parentSet = new Set(parentList);
  const removed = requestedList.filter((name) => !parentSet.has(name));
  if (removed.length > 0) {
    violations.push(
      `env allowlist entries outside the parent policy removed: ${removed.join(", ")}`,
    );
  }
  return dedupe(requestedList.filter((name) => parentSet.has(name)));
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isInsidePath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}
