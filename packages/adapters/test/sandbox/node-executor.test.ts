import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSandboxPolicy } from "@pika-harness/core";
import { buildProcessEnvironment, NodeProcessExecutor } from "../../src/sandbox/node-executor.js";

const BASH = "/bin/bash";
const ENV = "/usr/bin/env";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "pika-executor-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function policyFor(overrides: Partial<Parameters<typeof resolveSandboxPolicy>[0]> = {}) {
  return resolveSandboxPolicy({
    mode: "workspace-write",
    workspaceRoot: workspace,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function shell(script: string) {
  return { program: BASH, args: ["--noprofile", "--norc", "-c", script], cwd: workspace };
}

describe("buildProcessEnvironment", () => {
  it("forwards only allowlisted variables", () => {
    const policy = policyFor();
    const env = buildProcessEnvironment(policy, {
      PATH: "/usr/bin",
      HOME: "/home/pika",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      OPENAI_API_KEY: "sk-secret",
      PIKA_UNLISTED: "leak",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/pika",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
    });
  });

  it("drops credential-shaped names even when the allowlist includes them", () => {
    const policy = policyFor({
      envAllowlist: ["PATH", "OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"],
    });
    const env = buildProcessEnvironment(policy, {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("honors executor-level denials", () => {
    const policy = policyFor();
    const env = buildProcessEnvironment(policy, { PATH: "/usr/bin", HOME: "/home/pika" }, ["HOME"]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("NodeProcessExecutor", () => {
  it("reports no isolation capabilities", async () => {
    await expect(new NodeProcessExecutor().probe()).resolves.toEqual({
      backend: "none",
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    });
  });

  it("scrubs provider credentials and unlisted variables", async () => {
    const executor = new NodeProcessExecutor({
      sourceEnv: {
        PATH: process.env.PATH,
        HOME: workspace,
        OPENAI_API_KEY: "sk-secret",
        PIKA_UNLISTED: "leak",
      },
    });

    const result = await executor.exec({ program: ENV, args: [], cwd: workspace }, policyFor());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`HOME=${workspace}`);
    expect(result.stdout).not.toContain("OPENAI_API_KEY");
    expect(result.stdout).not.toContain("sk-secret");
    expect(result.stdout).not.toContain("PIKA_UNLISTED");
  });

  it("does not source startup files", async () => {
    await writeFile(
      path.join(workspace, ".bashrc"),
      "export PIKA_STARTUP_MARKER=leaked\nalias pika-marker='echo leaked'\n",
    );
    const executor = new NodeProcessExecutor({
      sourceEnv: { PATH: process.env.PATH, HOME: workspace },
    });

    const result = await executor.exec(
      shell(
        'printf "[%s]|[%s]" "$PIKA_STARTUP_MARKER" "$(type -t pika-marker 2>/dev/null || echo none)"',
      ),
      policyFor(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]|[none]");
  });

  it("streams incremental output before the command exits", async () => {
    const chunks: string[] = [];
    const result = await new NodeProcessExecutor().exec(
      { ...shell("echo first; sleep 0.05; echo second"), onOutput: (chunk) => chunks.push(chunk) },
      policyFor(),
    );

    expect(result.stdout).toBe("first\nsecond\n");
    expect(chunks.join("")).toContain("first");
    expect(chunks.join("")).toContain("second");
  });

  it("returns the exit code", async () => {
    const result = await new NodeProcessExecutor().exec(shell("exit 7"), policyFor());
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("writes stdin and closes it", async () => {
    const result = await new NodeProcessExecutor().exec(
      { program: "/bin/cat", args: [], cwd: workspace, stdin: "hello\n" },
      policyFor(),
    );
    expect(result.stdout).toBe("hello\n");
  });

  it("caps output and reports truncation", async () => {
    const result = await new NodeProcessExecutor().exec(
      shell("head -c 5000 /dev/zero | tr '\\0' a"),
      policyFor({ maxOutputBytes: 1024 }),
    );

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).not.toContain("\uFFFD");
  });

  it("times out and leaves no orphan processes", async () => {
    const result = await new NodeProcessExecutor({ killGraceMs: 200 }).exec(
      shell("sleep 30 & echo $!; wait"),
      policyFor({ timeoutMs: 150 }),
    );

    expect(result.timedOut).toBe(true);
    const pid = Number(result.stdout.trim().split("\n")[0]);
    expect(Number.isInteger(pid)).toBe(true);
    await expectProcessGone(pid);
  });

  it("sweeps background processes after a normal exit", async () => {
    const result = await new NodeProcessExecutor().exec(
      shell("sleep 30 >/dev/null 2>&1 & echo $!"),
      policyFor(),
    );

    expect(result.exitCode).toBe(0);
    const pid = Number(result.stdout.trim());
    expect(Number.isInteger(pid)).toBe(true);
    await expectProcessGone(pid);
  });

  it("terminates the process group when aborted", async () => {
    const controller = new AbortController();
    const promise = new NodeProcessExecutor({ killGraceMs: 200 }).exec(
      { ...shell("sleep 30"), signal: controller.signal },
      policyFor(),
    );
    setTimeout(() => controller.abort(), 50);

    const result = await promise;
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
  });

  it("rejects an execution whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      new NodeProcessExecutor().exec(
        { ...shell("echo never"), signal: controller.signal },
        policyFor(),
      ),
    ).rejects.toThrow("cancelled");
  });

  it("rejects an empty program name", async () => {
    await expect(
      new NodeProcessExecutor().exec({ program: "", args: [], cwd: workspace }, policyFor()),
    ).rejects.toThrow(/empty program/);
  });

  it("rejects a missing executable", async () => {
    await expect(
      new NodeProcessExecutor().exec(
        { program: path.join(workspace, "missing-binary"), args: [], cwd: workspace },
        policyFor(),
      ),
    ).rejects.toThrow();
  });
});

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} is still alive after the executor returned`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
