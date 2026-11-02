import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SandboxPolicySchema } from "@pika-harness/schema";
import {
  clampSandboxPolicy,
  resolveSandboxPolicy,
  SandboxPolicyError,
} from "../../src/sandbox/policy.js";

let base = "";
let workspaceRoot = "";

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "pika-policy-"));
  workspaceRoot = path.join(base, "workspace");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("resolveSandboxPolicy", () => {
  it("gives read-only policies no writable roots", () => {
    const policy = resolveSandboxPolicy({ mode: "read-only", workspaceRoot });
    expect(policy.mode).toBe("read-only");
    expect(policy.writableRoots).toEqual([]);
  });

  it("rejects write roots requested for read-only", () => {
    expect(() =>
      resolveSandboxPolicy({ mode: "read-only", workspaceRoot, writableRoots: ["src"] }),
    ).toThrow(SandboxPolicyError);
  });

  it("grants the workspace plus nested extra roots in workspace-write", () => {
    const policy = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot,
      writableRoots: ["packages/core", path.join(workspaceRoot, "apps")],
    });
    expect(policy.writableRoots).toEqual([
      workspaceRoot,
      path.join(workspaceRoot, "packages/core"),
      path.join(workspaceRoot, "apps"),
    ]);
  });

  it("rejects workspace-write roots outside the workspace", () => {
    expect(() =>
      resolveSandboxPolicy({
        mode: "workspace-write",
        workspaceRoot,
        writableRoots: [path.join(base, "outside")],
      }),
    ).toThrow(/inside the workspace/);
    expect(() =>
      resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot, writableRoots: [".."] }),
    ).toThrow(SandboxPolicyError);
  });

  it("uses the filesystem root for danger-full-access", () => {
    const policy = resolveSandboxPolicy({ mode: "danger-full-access", workspaceRoot });
    expect(policy.writableRoots).toEqual([path.parse(workspaceRoot).root]);
    expect(policy.writableRoots).toEqual(["/"]);
  });

  it("applies safe defaults", () => {
    const policy = resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot });
    expect(policy.network).toBe("none");
    expect(policy.envAllowlist).toEqual(["PATH", "HOME", "LANG", "TERM"]);
    expect(policy.timeoutMs).toBe(120_000);
    expect(policy.maxOutputBytes).toBe(1_048_576);
    expect(policy.deniedReads).toEqual([]);
  });

  it("normalizes every path with path.resolve", () => {
    const policy = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot: path.join(workspaceRoot, "nested", ".."),
      writableRoots: ["./src"],
      deniedReads: ["secrets", path.join(workspaceRoot, "keys/../id_rsa")],
    });
    expect(policy.writableRoots).toEqual([workspaceRoot, path.join(workspaceRoot, "src")]);
    expect(policy.deniedReads).toEqual([
      path.join(workspaceRoot, "secrets"),
      path.join(workspaceRoot, "id_rsa"),
    ]);
    expect(SandboxPolicySchema.safeParse(policy).success).toBe(true);
  });
});

describe("clampSandboxPolicy", () => {
  const readOnlyParent = resolveSandboxPolicy({ mode: "read-only", workspaceRoot });

  it("clamps a workspace-write child of a read-only parent", () => {
    const child = resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot });
    const { policy, violations } = clampSandboxPolicy(readOnlyParent, child);
    expect(policy.mode).toBe("read-only");
    expect(policy.writableRoots).toEqual([]);
    expect(violations.some((violation) => violation.includes("mode clamped"))).toBe(true);
  });

  it("clamps network, env allowlist, timeout, and output limits", () => {
    const parent = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot,
      network: "none",
      envAllowlist: ["PATH", "HOME"],
      timeoutMs: 1000,
      maxOutputBytes: 2048,
    });
    const child = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot,
      network: "full",
      envAllowlist: ["PATH", "HOME", "AWS_SECRET_ACCESS_KEY"],
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });
    const { policy, violations } = clampSandboxPolicy(parent, child);
    expect(policy.network).toBe("none");
    expect(policy.envAllowlist).toEqual(["PATH", "HOME"]);
    expect(policy.timeoutMs).toBe(1000);
    expect(policy.maxOutputBytes).toBe(2048);
    expect(violations).toHaveLength(4);
  });

  it("keeps a narrower child policy and records no violations", () => {
    const parent = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot,
      network: "proxy",
      timeoutMs: 10_000,
    });
    const child = resolveSandboxPolicy({
      mode: "read-only",
      workspaceRoot,
      network: "none",
      timeoutMs: 5000,
    });
    const { policy, violations } = clampSandboxPolicy(parent, child);
    expect(policy.mode).toBe("read-only");
    expect(policy.network).toBe("none");
    expect(policy.timeoutMs).toBe(5000);
    expect(violations).toEqual([]);
  });

  it("drops writable roots that leave the parent policy", () => {
    const parent = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot: path.join(base, "narrow"),
      writableRoots: ["sub"],
    });
    const child = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot: path.join(base, "other"),
    });
    const { policy, violations } = clampSandboxPolicy(parent, child);
    expect(policy.writableRoots).toEqual([]);
    expect(violations.some((violation) => violation.includes("writable roots"))).toBe(true);
  });

  it("keeps nested writable roots inside the parent roots", () => {
    const parent = resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot });
    const child = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot,
      writableRoots: ["src"],
    });
    const { policy, violations } = clampSandboxPolicy(parent, child);
    expect(policy.writableRoots).toEqual([workspaceRoot, path.join(workspaceRoot, "src")]);
    expect(violations).toEqual([]);
  });

  it("re-applies denied reads the child tried to drop", () => {
    const denied = path.join(workspaceRoot, "secrets");
    const parent = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot,
      deniedReads: [denied],
    });
    const child = resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot });
    const { policy, violations } = clampSandboxPolicy(parent, child);
    expect(policy.deniedReads).toEqual([denied]);
    expect(violations.some((violation) => violation.includes("denied reads"))).toBe(true);
  });
});
