import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolBatchContext } from "@pika-harness/core";
import {
  createBashTool,
  createGlobTool,
  createGrepTool,
  createPathPolicy,
  resolveSandboxPolicy,
  ToolBatchExecutor,
  ToolRegistry,
} from "@pika-harness/core";
import type { ToolResult } from "@pika-harness/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeProcessExecutor } from "../../src/sandbox/node-executor.js";
import { FileToolOutputStore } from "../../src/storage/file-output-store.js";

let base: string;
let workspace: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "pika-shell-tools-")));
  workspace = path.join(base, "workspace");
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Harness {
  batch: ToolBatchExecutor;
  policy: ReturnType<typeof resolveSandboxPolicy>;
}

function createHarness(
  options: { maxOutputBytes?: number; outputStore?: FileToolOutputStore } = {},
): Harness {
  const policy = resolveSandboxPolicy({
    mode: "workspace-write",
    workspaceRoot: workspace,
    timeoutMs: 5_000,
  });
  const pathPolicy = createPathPolicy({ workspaceRoot: workspace, policy });
  const executor = new NodeProcessExecutor();
  const registry = new ToolRegistry();
  registry.register(createBashTool({ executor, policy, cwd: workspace }));
  registry.register(createGrepTool({ executor, pathPolicy, policy, cwd: workspace }));
  registry.register(createGlobTool({ executor, pathPolicy, policy, cwd: workspace }));
  return {
    batch: new ToolBatchExecutor(registry, options),
    policy,
  };
}

interface Trace {
  events: string[];
  results: ToolResult[];
}

async function execute(
  harness: Harness,
  name: string,
  args: unknown,
  options: { signal?: AbortSignal; onUpdate?: (chunk: string) => void } = {},
): Promise<Trace> {
  const events: string[] = [];
  const results: ToolResult[] = [];
  const context: ToolBatchContext = {
    sessionId: "session",
    turnId: "turn",
    signal: options.signal ?? new AbortController().signal,
    onStart: (call) => events.push(`start:${call.name}`),
    onUpdate: (_call, chunk) => {
      events.push("update");
      options.onUpdate?.(chunk);
    },
    onEnd: (_call, result) => {
      events.push("end");
      results.push(result);
    },
  };
  const [result] = await harness.batch.execute(
    [{ id: "call_1", name, arguments: JSON.stringify(args) }],
    context,
  );
  return { events, results: result === undefined ? results : [result] };
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function single<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected one item");
  return item;
}

describe("shell tools with a real process executor", () => {
  it("runs bash and returns stdout", async () => {
    const harness = createHarness();
    const { results } = await execute(harness, "bash", { command: "printf hello" });
    const result = single(results);
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("hello");
    expect(result.details?.exitCode).toBe(0);
  });

  it("reports an exit code", async () => {
    const harness = createHarness();
    const { results } = await execute(harness, "bash", { command: "echo broken >&2; exit 3" });
    const result = single(results);
    expect(result.isError).toBe(true);
    expect(result.details?.exitCode).toBe(3);
    expect(textOf(result)).toContain("broken");
  });

  it("emits start, update, and end in order for a long-running command", async () => {
    const harness = createHarness();
    const { events } = await execute(harness, "bash", {
      command: "echo first; sleep 0.05; echo second",
    });

    expect(events[0]).toBe("start:bash");
    expect(events.at(-1)).toBe("end");
    const firstUpdate = events.indexOf("update");
    expect(firstUpdate).toBeGreaterThan(0);
    expect(firstUpdate).toBeLessThan(events.length - 1);
  });

  it("persists oversized output and returns a reference", async () => {
    const store = new FileToolOutputStore(path.join(base, "outputs"));
    const harness = createHarness({ maxOutputBytes: 2048, outputStore: store });
    const { results } = await execute(harness, "bash", {
      command: "head -c 20000 /dev/zero | tr '\\0' b",
    });
    const result = single(results);

    const reference = result.fullOutputRef;
    if (reference === undefined) throw new Error("expected a persisted output reference");
    expect(textOf(result)).toContain("truncated");
    expect(textOf(result)).toContain(reference);
    const persisted = await readFile(reference, "utf8");
    expect(persisted.length).toBe(20_000);
  });

  it("times out a long-running command", async () => {
    const policy = resolveSandboxPolicy({
      mode: "workspace-write",
      workspaceRoot: workspace,
      timeoutMs: 150,
    });
    const pathPolicy = createPathPolicy({ workspaceRoot: workspace, policy });
    const executor = new NodeProcessExecutor({ killGraceMs: 200 });
    const registry = new ToolRegistry();
    registry.register(createBashTool({ executor, policy, cwd: workspace }));
    registry.register(createGrepTool({ executor, pathPolicy, policy, cwd: workspace }));
    const harness = { batch: new ToolBatchExecutor(registry), policy };

    const { results } = await execute(harness, "bash", { command: "sleep 30" });
    const result = single(results);
    expect(result.isError).toBe(true);
    expect(result.details?.timedOut).toBe(true);
    expect(textOf(result)).toContain("timed out");
  });

  it("searches file contents with grep", async () => {
    await writeFile(path.join(workspace, "a.ts"), "const needle = 1;\n");
    await writeFile(path.join(workspace, "b.md"), "needle\n");
    const harness = createHarness();
    const { results } = await execute(harness, "grep", { pattern: "needle", glob: "*.ts" });
    const result = single(results);

    expect(result.isError).toBe(false);
    const output = textOf(result);
    expect(output).toContain("a.ts:1:");
    expect(output).not.toContain("b.md");
  });

  it("finds files with glob", async () => {
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "src", "b.ts"), "");
    await writeFile(path.join(workspace, "src", "a.ts"), "");
    await writeFile(path.join(workspace, "README.md"), "");
    const harness = createHarness();
    const { results } = await execute(harness, "glob", { pattern: "*.ts" });
    const result = single(results);

    const lines = textOf(result)
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a.ts");
    expect(lines[1]).toContain("b.ts");
  });
});
