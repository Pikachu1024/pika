import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxMode } from "@pika-harness/schema";
import { createPathPolicy } from "../../src/sandbox/path-policy.js";
import { resolveSandboxPolicy } from "../../src/sandbox/policy.js";

let base = "";
let workspaceRoot = "";
let outsideRoot = "";

beforeEach(async () => {
  // Canonical base so authoritative paths match what realpath reports; macOS
  // temp dirs sit behind a /var symlink.
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pika-path-policy-")));
  workspaceRoot = path.join(base, "workspace");
  outsideRoot = path.join(base, "outside");
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "index.ts"), "export {};\n");
  await writeFile(path.join(outsideRoot, "secret.txt"), "secret\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function policyFor(mode: SandboxMode, deniedReads: string[] = []) {
  return createPathPolicy({
    workspaceRoot,
    policy: resolveSandboxPolicy({ mode, workspaceRoot, deniedReads }),
  });
}

describe("createPathPolicy read-only", () => {
  it("denies writes", async () => {
    const policy = policyFor("read-only");
    await expect(policy.resolve("src/new.ts", "write")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "read-only",
    });
  });

  it("allows reads inside the workspace", async () => {
    const policy = policyFor("read-only");
    await expect(policy.resolve("src/index.ts", "read")).resolves.toBe(
      path.join(workspaceRoot, "src", "index.ts"),
    );
  });
});

describe("createPathPolicy workspace-write", () => {
  it("allows a write to a new file inside the workspace", async () => {
    const policy = policyFor("workspace-write");
    await expect(policy.resolve("src/generated.ts", "write")).resolves.toBe(
      path.join(workspaceRoot, "src", "generated.ts"),
    );
  });

  it("resolves relative paths against the workspace root", async () => {
    const policy = policyFor("workspace-write");
    await expect(policy.resolve("file.txt", "write")).resolves.toBe(
      path.join(workspaceRoot, "file.txt"),
    );
  });

  it("authorizes a write when the parent directory does not exist yet", async () => {
    const policy = policyFor("workspace-write");
    await expect(policy.resolve("src/deep/nested/new.ts", "write")).resolves.toBe(
      path.join(workspaceRoot, "src", "deep", "nested", "new.ts"),
    );
  });

  it("denies a write outside the workspace", async () => {
    const policy = policyFor("workspace-write");
    await expect(policy.resolve(path.join(outsideRoot, "x.txt"), "write")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "outside-workspace",
    });
  });

  it("denies reads outside the workspace", async () => {
    const policy = policyFor("workspace-write");
    const target = path.join(outsideRoot, "secret.txt");
    await expect(policy.resolve(target, "read")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "outside-workspace",
    });
  });

  it("denies .. traversal that escapes the workspace", async () => {
    const policy = policyFor("workspace-write");
    await expect(policy.resolve("../outside/x.txt", "write")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "outside-workspace",
    });
    await expect(policy.resolve("src/../../../outside/secret.txt", "read")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "outside-workspace",
    });
  });

  it("denies a symlink inside the workspace that points outside", async () => {
    await symlink(outsideRoot, path.join(workspaceRoot, "escape"));
    const policy = policyFor("workspace-write");
    await expect(policy.resolve("escape/x.txt", "write")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "symlink-escape",
    });
    await expect(policy.resolve("escape/secret.txt", "read")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "symlink-escape",
    });
  });

  it("allows a symlink that stays inside the workspace", async () => {
    await symlink("src", path.join(workspaceRoot, "alias"));
    const policy = policyFor("workspace-write");
    await expect(policy.resolve("alias/index.ts", "read")).resolves.toBe(
      path.join(workspaceRoot, "src", "index.ts"),
    );
    await expect(policy.resolve("alias/new.ts", "write")).resolves.toBe(
      path.join(workspaceRoot, "src", "new.ts"),
    );
  });

  it("denies reads at or below a denied path", async () => {
    const policy = policyFor("workspace-write", ["src"]);
    await expect(policy.resolve("src/index.ts", "read")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "denied-read",
    });
    await expect(policy.resolve("src/nested/new.ts", "write")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "denied-read",
    });
    await expect(policy.resolve("file.txt", "write")).resolves.toBe(
      path.join(workspaceRoot, "file.txt"),
    );
  });
});

describe("createPathPolicy danger-full-access", () => {
  it("allows a write outside the workspace", async () => {
    const policy = policyFor("danger-full-access");
    await expect(policy.resolve(path.join(outsideRoot, "x.txt"), "write")).resolves.toBe(
      path.join(outsideRoot, "x.txt"),
    );
  });

  it("still denies denied reads", async () => {
    const secret = path.join(outsideRoot, "secret.txt");
    const policy = policyFor("danger-full-access", [secret]);
    await expect(policy.resolve(secret, "read")).rejects.toMatchObject({
      name: "PathPolicyError",
      code: "denied-read",
    });
    await expect(policy.resolve(path.join(outsideRoot, "other.txt"), "read")).resolves.toBe(
      path.join(outsideRoot, "other.txt"),
    );
  });
});
