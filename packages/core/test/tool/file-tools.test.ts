import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxPolicy } from "@pika-harness/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPathPolicy } from "../../src/sandbox/path-policy.js";
import { resolveSandboxPolicy } from "../../src/sandbox/policy.js";
import { createEditFileTool } from "../../src/tool/file/edit-file.js";
import { createReadFileTool } from "../../src/tool/file/read-file.js";
import { createWriteFileTool } from "../../src/tool/file/write-file.js";
import type { Tool, ToolContext, ToolOutput } from "../../src/tools.js";

let base: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  // macOS temp dirs sit behind a /var symlink, so canonicalize the base before
  // deriving the workspace paths.
  base = await realpath(await mkdtemp(path.join(tmpdir(), "pika-files-")));
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function policy(overrides: { mode?: "read-only" | "workspace-write" } = {}): SandboxPolicy {
  return resolveSandboxPolicy({
    mode: overrides.mode ?? "workspace-write",
    workspaceRoot: workspace,
  });
}

function pathPolicyFor(p: SandboxPolicy) {
  return createPathPolicy({ workspaceRoot: workspace, policy: p });
}

function readTool(p: SandboxPolicy = policy()): Tool {
  return createReadFileTool({ pathPolicy: pathPolicyFor(p) });
}

function writeTool(p: SandboxPolicy = policy()): Tool {
  return createWriteFileTool({ pathPolicy: pathPolicyFor(p) });
}

function editTool(p: SandboxPolicy = policy()): Tool {
  return createEditFileTool({ pathPolicy: pathPolicyFor(p) });
}

async function run(tool: Tool, args: unknown): Promise<ToolOutput> {
  return tool.execute(context(), args);
}

function context(): ToolContext {
  return {
    sessionId: "session",
    turnId: "turn",
    toolCallId: "call",
    signal: new AbortController().signal,
    onUpdate() {},
  };
}

function errorCode(result: ToolOutput): string | undefined {
  const part = result.content.find((item) => item.type === "error");
  return part?.type === "error" ? part.code : undefined;
}

function text(result: ToolOutput): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("read_file", () => {
  it("reads a file inside the workspace", async () => {
    await writeFile(path.join(workspace, "notes.txt"), "alpha\nbeta\n");
    const result = await run(readTool(), { path: "notes.txt" });
    expect(result.isError).toBe(false);
    expect(text(result)).toBe("alpha\nbeta\n");
    expect(result.details?.totalLines).toBe(3);
  });

  it("selects a line range with offset and limit", async () => {
    await writeFile(path.join(workspace, "lines.txt"), "one\ntwo\nthree\nfour\n");
    const result = await run(readTool(), { path: "lines.txt", offset: 2, limit: 2 });
    expect(text(result)).toBe("two\nthree");
    expect(result.details?.truncated).toBe(true);
    expect(result.details?.startLine).toBe(2);
    expect(result.details?.endLine).toBe(3);
  });

  it("rejects paths outside the workspace", async () => {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    const result = await run(readTool(), { path: path.join(outside, "secret.txt") });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("outside-workspace");
    expect(text(result)).toBe("");
  });

  it("rejects a symlink that resolves outside the workspace", async () => {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));
    const result = await run(readTool(), { path: "link.txt" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("symlink-escape");
  });

  it("reports a nonexistent path", async () => {
    const result = await run(readTool(), { path: "missing.txt" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("not_found");
  });

  it("reports a directory as not a file", async () => {
    await mkdir(path.join(workspace, "dir"));
    const result = await run(readTool(), { path: "dir" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("not_a_file");
  });

  it("caps reads at the configured byte limit", async () => {
    await writeFile(path.join(workspace, "big.txt"), "a".repeat(4096));
    const result = await createReadFileTool({
      pathPolicy: pathPolicyFor(policy()),
      maxBytes: 1024,
    }).execute(context(), { path: "big.txt" });
    expect(text(result).length).toBe(1024);
    expect(result.details?.truncated).toBe(true);
  });
});

describe("write_file", () => {
  it("writes a file and creates parent directories", async () => {
    const result = await run(writeTool(), { path: "nested/note.txt", content: "hello" });
    expect(result.isError).toBe(false);
    await expect(readFile(path.join(workspace, "nested/note.txt"), "utf8")).resolves.toBe("hello");
    expect(result.details?.bytes).toBe(5);
  });

  it("rejects writes outside the workspace", async () => {
    const target = path.join(outside, "escape.txt");
    const result = await run(writeTool(), { path: target, content: "nope" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("outside-workspace");
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("rejects writes through an escaping symlink", async () => {
    await writeFile(path.join(outside, "target.txt"), "original");
    await symlink(path.join(outside, "target.txt"), path.join(workspace, "link.txt"));
    const result = await run(writeTool(), { path: "link.txt", content: "changed" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("symlink-escape");
    await expect(readFile(path.join(outside, "target.txt"), "utf8")).resolves.toBe("original");
  });

  it("rejects every write under a read-only policy", async () => {
    const result = await run(writeTool(policy({ mode: "read-only" })), {
      path: "note.txt",
      content: "nope",
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("read-only");
  });
});

describe("edit_file", () => {
  it("replaces a single exact match", async () => {
    await writeFile(path.join(workspace, "code.ts"), "const value = 1;\n");
    const result = await run(editTool(), {
      path: "code.ts",
      oldText: "value = 1",
      newText: "value = 2",
    });
    expect(result.isError).toBe(false);
    await expect(readFile(path.join(workspace, "code.ts"), "utf8")).resolves.toBe(
      "const value = 2;\n",
    );
    expect(result.details?.replacements).toBe(1);
  });

  it("reports a missing match", async () => {
    await writeFile(path.join(workspace, "code.ts"), "const value = 1;\n");
    const result = await run(editTool(), {
      path: "code.ts",
      oldText: "missing",
      newText: "x",
    });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("no_match");
  });

  it("refuses an ambiguous match without replaceAll", async () => {
    await writeFile(path.join(workspace, "code.ts"), "x\nx\n");
    const result = await run(editTool(), { path: "code.ts", oldText: "x", newText: "y" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("ambiguous_match");
    await expect(readFile(path.join(workspace, "code.ts"), "utf8")).resolves.toBe("x\nx\n");
  });

  it("replaces every match when replaceAll is set", async () => {
    await writeFile(path.join(workspace, "code.ts"), "x\nx\n");
    const result = await run(editTool(), {
      path: "code.ts",
      oldText: "x",
      newText: "y",
      replaceAll: true,
    });
    expect(result.isError).toBe(false);
    expect(result.details?.replacements).toBe(2);
    await expect(readFile(path.join(workspace, "code.ts"), "utf8")).resolves.toBe("y\ny\n");
  });

  it("rejects edits outside the workspace", async () => {
    const target = path.join(outside, "target.txt");
    await writeFile(target, "original");
    const result = await run(editTool(), { path: target, oldText: "original", newText: "changed" });
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("outside-workspace");
    await expect(readFile(target, "utf8")).resolves.toBe("original");
  });
});
