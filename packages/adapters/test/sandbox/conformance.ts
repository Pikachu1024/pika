import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Executor } from "@pika-harness/core";
import { resolveSandboxPolicy } from "@pika-harness/core";
import type { SandboxPolicy } from "@pika-harness/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface ConformanceSupport {
  outsideWrite?: boolean;
  deniedReads?: boolean;
  symlink?: boolean;
  network?: boolean;
  orphanCleanup?: boolean;
}

export interface ConformanceOptions {
  name: string;
  /** Returns undefined when the backend is not installed on this host. */
  createExecutor: () => Executor | undefined;
  support?: ConformanceSupport;
}

const leakMarker = "pika-leak-marker";
const allowedMarker = "pika-allowed-marker";

function shell(script: string, cwd: string) {
  return { program: "/bin/bash", args: ["--noprofile", "--norc", "-c", script], cwd };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

/** Registers the shared sandbox conformance cases for one executor backend. */
export function defineExecutorConformance(options: ConformanceOptions): void {
  const executor = options.createExecutor();
  const support = {
    outsideWrite: options.support?.outsideWrite ?? true,
    deniedReads: options.support?.deniedReads ?? true,
    symlink: options.support?.symlink ?? true,
    network: options.support?.network ?? true,
    orphanCleanup: options.support?.orphanCleanup ?? true,
  };
  const test = executor === undefined ? it.skip : it;
  const previouslyLeaked = process.env.PIKA_LEAK_MARKER;
  const previouslyAllowed = process.env.PIKA_ALLOWED_MARKER;

  describe(`sandbox conformance: ${options.name}`, () => {
    let base = "";
    let workspace = "";
    let outside = "";
    let secret = "";

    beforeAll(async () => {
      if (executor === undefined) return;
      process.env.PIKA_LEAK_MARKER = leakMarker;
      process.env.PIKA_ALLOWED_MARKER = allowedMarker;
      base = await mkdtemp(path.join(os.tmpdir(), "pika-conformance-"));
      workspace = path.join(base, "workspace");
      outside = path.join(base, "outside");
      secret = path.join(base, "secret");
      await mkdir(workspace, { recursive: true });
      await mkdir(outside, { recursive: true });
      await mkdir(secret, { recursive: true });
      await writeFile(path.join(secret, "token.txt"), "SECRET-VALUE", "utf8");
      await writeFile(path.join(outside, "secret.txt"), "OUTSIDE-VALUE", "utf8");
      await writeFile(path.join(workspace, "start.txt"), "start", "utf8");
      await symlink(path.join(secret, "token.txt"), path.join(workspace, "escape"));
    });

    afterAll(async () => {
      if (previouslyLeaked === undefined) delete process.env.PIKA_LEAK_MARKER;
      else process.env.PIKA_LEAK_MARKER = previouslyLeaked;
      if (previouslyAllowed === undefined) delete process.env.PIKA_ALLOWED_MARKER;
      else process.env.PIKA_ALLOWED_MARKER = previouslyAllowed;
      if (base !== "") await rm(base, { recursive: true, force: true });
    });

    function policy(overrides: Partial<Parameters<typeof resolveSandboxPolicy>[0]> = {}) {
      return resolveSandboxPolicy({
        mode: "workspace-write",
        workspaceRoot: workspace,
        deniedReads: [secret],
        envAllowlist: ["PATH", "HOME", "LANG", "TERM", "PIKA_ALLOWED_MARKER"],
        timeoutMs: 5_000,
        ...overrides,
      });
    }

    async function run(script: string, current: SandboxPolicy = policy()) {
      return (executor as Executor).exec(shell(script, workspace), current);
    }

    test("writes inside the workspace", async () => {
      const result = await run("printf inside > inside.txt && cat inside.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("inside");
      expect(result.denied).toBeUndefined();
    });

    const outsideWriteTest = support.outsideWrite ? test : it.skip;
    outsideWriteTest("rejects writes outside the workspace", async () => {
      const target = path.join(outside, "new.txt");
      const result = await run(`printf x > '${target}'`);
      expect(result.exitCode === 0 && existsSync(target)).toBe(false);
    });

    test("rejects reads of a denied path", async () => {
      const result = await run(`cat '${path.join(secret, "token.txt")}'`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("SECRET-VALUE");
    });

    const traversalTest = support.deniedReads ? test : it.skip;
    traversalTest("rejects traversal into a denied path", async () => {
      const result = await run(`cat '${path.join(secret, "token.txt")}'; cat ../secret/token.txt`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("SECRET-VALUE");
    });

    const symlinkTest = support.symlink ? test : it.skip;
    symlinkTest("rejects a symlink that escapes the workspace", async () => {
      const result = await run("cat escape");
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("SECRET-VALUE");
    });

    const networkTest = support.network ? test : it.skip;
    networkTest("denies network access", async () => {
      const result = await run("exec 3<>/dev/tcp/example.com/443 && echo connected");
      expect(result.exitCode).not.toBe(0);
      expect(result.denied).toBeDefined();
    });

    test("keeps restrictions effective in a child process", async () => {
      const result = await run(`/bin/bash -c "cat '${path.join(secret, "token.txt")}'"`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("SECRET-VALUE");
    });

    test("drops credentials and non-allowlisted variables", async () => {
      const result = await run(
        'printf "leak=%s allowed=%s" "$PIKA_LEAK_MARKER" "$PIKA_ALLOWED_MARKER"',
      );
      expect(result.stdout).toBe("leak= allowed=pika-allowed-marker");
    });

    test("rejects writes in read-only mode", async () => {
      const target = path.join(workspace, "readonly.txt");
      const result = await run("printf x > readonly.txt", policy({ mode: "read-only" }));
      expect(result.exitCode === 0 && existsSync(target)).toBe(false);
    });

    const orphanTest = support.orphanCleanup ? test : it.skip;
    orphanTest(
      "kills the process group on timeout",
      async () => {
        const result = await run("sleep 30 & echo $!; wait", policy({ timeoutMs: 800 }));
        expect(result.timedOut).toBe(true);
        const pid = Number.parseInt(result.stdout.trim(), 10);
        expect(Number.isInteger(pid)).toBe(true);
        expect(await waitGone(pid)).toBe(true);
      },
      10_000,
    );
  });
}
