import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxPolicy } from "@pika-harness/schema";
import { createPathPolicy } from "../../src/sandbox/path-policy.js";
import { resolveSandboxPolicy } from "../../src/sandbox/policy.js";
import type { ExecRequest, ExecResult, Executor, SandboxCapabilities } from "../../src/sandbox.js";
import { createBashTool } from "../../src/tool/shell/bash.js";
import { createGlobTool } from "../../src/tool/shell/glob.js";
import { createGrepTool } from "../../src/tool/shell/grep.js";
import type { Tool, ToolContext, ToolOutput } from "../../src/tools.js";

class FakeExecutor implements Executor {
  readonly backend = "none" as const;
  readonly requests: Array<{ request: ExecRequest; policy: SandboxPolicy }> = [];
  result: ExecResult = {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
  };

  async exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult> {
    this.requests.push({ request, policy });
    request.onOutput?.("streamed\n");
    return this.result;
  }

  async probe(): Promise<SandboxCapabilities> {
    return {
      backend: "none",
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    };
  }
}

let base: string;
let workspace: string;
let policy: SandboxPolicy;
let executor: FakeExecutor;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "pika-shell-")));
  workspace = path.join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  policy = resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot: workspace });
  executor = new FakeExecutor();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function pathPolicy() {
  return createPathPolicy({ workspaceRoot: workspace, policy });
}

async function run(
  tool: Tool,
  args: unknown,
  context?: Partial<ToolContext>,
): Promise<{ result: ToolOutput; updates: string[] }> {
  const updates: string[] = [];
  const result = await tool.execute(
    {
      sessionId: "session",
      turnId: "turn",
      toolCallId: "call",
      signal: new AbortController().signal,
      onUpdate: (chunk) => updates.push(chunk),
      ...context,
    },
    args,
  );
  return { result, updates };
}

function text(result: ToolOutput): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function errorCode(result: ToolOutput): string | undefined {
  const part = result.content.find((item) => item.type === "error");
  return part?.type === "error" ? part.code : undefined;
}

function single<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected one item");
  return item;
}

describe("bash", () => {
  it("runs through the executor with startup files disabled", async () => {
    const tool = createBashTool({ executor, policy, cwd: workspace });
    const { result } = await run(tool, { command: "echo hi" });

    expect(result.isError).toBe(false);
    expect(executor.requests).toHaveLength(1);
    const first = single(executor.requests);
    expect(first.request.program).toBe("/bin/bash");
    expect(first.request.args).toEqual(["--noprofile", "--norc", "-c", "echo hi"]);
    expect(first.request.cwd).toBe(workspace);
    expect(first.policy).toEqual(policy);
  });

  it("forwards incremental output to the context", async () => {
    const tool = createBashTool({ executor, policy, cwd: workspace });
    const { updates } = await run(tool, { command: "echo hi" });
    expect(updates).toEqual(["streamed\n"]);
  });

  it("forwards the abort signal", async () => {
    const controller = new AbortController();
    const tool = createBashTool({ executor, policy, cwd: workspace });
    await run(tool, { command: "sleep 1" }, { signal: controller.signal });
    expect(executor.requests[0]?.request.signal).toBe(controller.signal);
  });

  it("reports a nonzero exit code as an error", async () => {
    executor.result = {
      exitCode: 2,
      signal: null,
      stdout: "",
      stderr: "bad thing\n",
      timedOut: false,
      truncated: false,
    };
    const tool = createBashTool({ executor, policy, cwd: workspace });
    const { result } = await run(tool, { command: "false" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("exited with code 2");
    expect(text(result)).toContain("bad thing");
    expect(result.details?.exitCode).toBe(2);
  });

  it("reports a timeout as an error", async () => {
    executor.result = {
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      timedOut: true,
      truncated: false,
    };
    const tool = createBashTool({ executor, policy, cwd: workspace });
    const { result } = await run(tool, { command: "sleep 60" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`timed out after ${policy.timeoutMs}ms`);
  });

  it("clamps a caller timeout to the effective policy", async () => {
    const tool = createBashTool({ executor, policy, cwd: workspace });
    await run(tool, { command: "true", timeoutMs: 60_000 });
    expect(executor.requests[0]?.policy.timeoutMs).toBe(60_000);
  });

  it("reports executor failures as execution errors", async () => {
    executor.exec = async () => {
      throw new Error("spawn failed");
    };
    const tool = createBashTool({ executor, policy, cwd: workspace });
    const { result } = await run(tool, { command: "nope" });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("execution_error");
    expect(result.content).toContainEqual({
      type: "error",
      message: "spawn failed",
      code: "execution_error",
    });
  });
});

describe("grep", () => {
  it("searches the resolved path through the executor", async () => {
    executor.result = {
      exitCode: 0,
      signal: null,
      stdout: "src/a.ts:1:match\n",
      stderr: "",
      timedOut: false,
      truncated: false,
    };
    const tool = createGrepTool({ executor, pathPolicy: pathPolicy(), policy, cwd: workspace });
    const { result } = await run(tool, { pattern: "match", glob: "*.ts", ignoreCase: true });

    expect(result.isError).toBe(false);
    expect(text(result)).toBe("src/a.ts:1:match");
    const { request } = single(executor.requests);
    expect(request.program).toBe("grep");
    expect(request.args).toEqual([
      "-r",
      "-n",
      "--no-messages",
      "-i",
      "--include=*.ts",
      "-e",
      "match",
      "--",
      workspace,
    ]);
  });

  it("treats exit code 1 as no matches", async () => {
    executor.result = {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
    };
    const tool = createGrepTool({ executor, pathPolicy: pathPolicy(), policy, cwd: workspace });
    const { result } = await run(tool, { pattern: "missing" });

    expect(result.isError).toBe(false);
    expect(text(result)).toBe("no matches");
  });

  it("rejects a path outside the workspace before executing", async () => {
    const tool = createGrepTool({ executor, pathPolicy: pathPolicy(), policy, cwd: workspace });
    const { result } = await run(tool, { pattern: "x", path: path.join(base, "outside") });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("outside-workspace");
    expect(executor.requests).toHaveLength(0);
  });
});

describe("glob", () => {
  it("finds files by name and sorts the output", async () => {
    executor.result = {
      exitCode: 0,
      signal: null,
      stdout: `${path.join(workspace, "b.ts")}\n${path.join(workspace, "a.ts")}\n`,
      stderr: "",
      timedOut: false,
      truncated: false,
    };
    const tool = createGlobTool({ executor, pathPolicy: pathPolicy(), policy, cwd: workspace });
    const { result } = await run(tool, { pattern: "*.ts" });

    const lines = text(result).split("\n");
    expect(lines[0]).toContain("a.ts");
    expect(lines[1]).toContain("b.ts");
    expect(executor.requests[0]?.request.args).toEqual([workspace, "-type", "f", "-name", "*.ts"]);
  });

  it("uses a path match when the pattern contains a slash", async () => {
    const tool = createGlobTool({ executor, pathPolicy: pathPolicy(), policy, cwd: workspace });
    await run(tool, { pattern: "src/**/*.ts" });
    expect(executor.requests[0]?.request.args).toEqual([
      workspace,
      "-type",
      "f",
      "-path",
      "*/src/**/*.ts",
    ]);
  });

  it("reports no matches when find returns nothing", async () => {
    const tool = createGlobTool({ executor, pathPolicy: pathPolicy(), policy, cwd: workspace });
    const { result } = await run(tool, { pattern: "*.md" });
    expect(result.isError).toBe(false);
    expect(text(result)).toBe("no files matched");
  });
});
