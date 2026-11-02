import { describe, expect, it, mock } from "bun:test";
import type { ToolCall, ToolResult } from "@pika-harness/schema";
import { z } from "zod";
import { ToolBatchExecutor } from "../../src/tool/executor.js";
import { ToolRegistry } from "../../src/tool/registry.js";
import type { Tool, ToolBatchContext, ToolOutput } from "../../src/tools.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function textOutput(text: string): ToolOutput {
  return { content: [{ type: "text", text }], isError: false };
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function makeContext(signal: AbortSignal = new AbortController().signal): {
  context: ToolBatchContext;
  started: string[];
  ended: ToolResult[];
} {
  const started: string[] = [];
  const ended: ToolResult[] = [];
  const context: ToolBatchContext = {
    sessionId: "session_1",
    turnId: "turn_1",
    signal,
    onStart(call) {
      started.push(call.id);
    },
    onUpdate() {},
    onEnd(_call, result) {
      ended.push(result);
    },
  };
  return { context, started, ended };
}

function makeRegistry(...tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

describe("ToolBatchExecutor", () => {
  it("returns a validation error without executing when a required argument is missing", async () => {
    const execute = mock(async () => textOutput("ok"));
    const tool: Tool = {
      name: "write_file",
      description: "writes a file",
      schema: z.object({ path: z.string(), content: z.string() }),
      execute,
    };
    const executor = new ToolBatchExecutor(makeRegistry(tool));
    const { context, started, ended } = makeContext();

    const results = await executor.execute(
      [toolCall("call_1", "write_file", { path: "notes.txt" })],
      context,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(started).toEqual([]);
    expect(ended).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: "call_1", isError: true });
    expect(results[0]?.content[0]).toMatchObject({ type: "error", code: "validation_error" });
  });

  it("returns an argument error for invalid JSON without executing", async () => {
    const execute = mock(async () => textOutput("ok"));
    const tool: Tool = {
      name: "read_file",
      description: "reads a file",
      schema: z.object({ path: z.string() }),
      execute,
    };
    const executor = new ToolBatchExecutor(makeRegistry(tool));
    const { context } = makeContext();

    const results = await executor.execute(
      [{ id: "call_1", name: "read_file", arguments: "{" }],
      context,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(results[0]?.content[0]).toMatchObject({ type: "error", code: "invalid_arguments" });
  });

  it("returns an unknown-tool error and continues the turn", async () => {
    const execute = mock(async () => textOutput("ok"));
    const tool: Tool = {
      name: "read_file",
      description: "reads a file",
      schema: z.object({ path: z.string() }),
      execute,
    };
    const executor = new ToolBatchExecutor(makeRegistry(tool));
    const { context, started } = makeContext();

    const results = await executor.execute(
      [
        toolCall("call_1", "delete_everything", { path: "notes.txt" }),
        toolCall("call_2", "read_file", { path: "notes.txt" }),
      ],
      context,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(started).toEqual(["call_2"]);
    expect(results[0]?.content[0]).toMatchObject({ type: "error", code: "unknown_tool" });
    expect(results[1]).toMatchObject({ toolCallId: "call_2", isError: false });
  });

  it("runs independent calls concurrently and serializes same-key calls", async () => {
    const events: string[] = [];
    const readGate = deferred<void>();
    const readTool: Tool = {
      name: "read_file",
      description: "reads a file",
      schema: z.object({ path: z.string() }),
      concurrencyKey: () => null,
      async execute(_context, args) {
        const { path } = args as { path: string };
        events.push(`read_start:${path}`);
        await readGate.promise;
        events.push(`read_end:${path}`);
        return textOutput(path);
      },
    };
    const writeGates: Deferred<void>[] = [];
    const writeTool: Tool = {
      name: "write_file",
      description: "writes a file",
      schema: z.object({ path: z.string() }),
      concurrencyKey: (args) => `file:${(args as { path: string }).path}`,
      async execute(_context, args) {
        const { path } = args as { path: string };
        events.push(`write_start:${path}`);
        const gate = deferred<void>();
        writeGates.push(gate);
        await gate.promise;
        events.push(`write_end:${path}`);
        return textOutput(path);
      },
    };
    const executor = new ToolBatchExecutor(makeRegistry(readTool, writeTool));
    const { context, started, ended } = makeContext();

    const batch = executor.execute(
      [
        toolCall("call_1", "read_file", { path: "a.txt" }),
        toolCall("call_2", "write_file", { path: "shared.txt" }),
        toolCall("call_3", "read_file", { path: "b.txt" }),
        toolCall("call_4", "write_file", { path: "shared.txt" }),
      ],
      context,
    );
    await flush();

    expect(events).toEqual(["read_start:a.txt", "write_start:shared.txt", "read_start:b.txt"]);
    expect(writeGates).toHaveLength(1);

    writeGates[0]?.resolve(undefined);
    await flush();

    expect(events).toEqual([
      "read_start:a.txt",
      "write_start:shared.txt",
      "read_start:b.txt",
      "write_end:shared.txt",
      "write_start:shared.txt",
    ]);
    expect(writeGates).toHaveLength(2);

    writeGates[1]?.resolve(undefined);
    readGate.resolve(undefined);
    const results = await batch;

    expect(results.map((result) => result.toolCallId)).toEqual([
      "call_1",
      "call_2",
      "call_3",
      "call_4",
    ]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(started).toEqual(["call_1", "call_2", "call_3", "call_4"]);
    expect(ended).toHaveLength(4);
  });

  it("returns results in the original call order regardless of completion order", async () => {
    const gates = new Map<string, Deferred<void>>();
    const tool: Tool = {
      name: "read_file",
      description: "reads a file",
      schema: z.object({ path: z.string() }),
      concurrencyKey: () => null,
      async execute(_context, args) {
        const { path } = args as { path: string };
        const gate = deferred<void>();
        gates.set(path, gate);
        await gate.promise;
        return textOutput(path);
      },
    };
    const executor = new ToolBatchExecutor(makeRegistry(tool));
    const { context } = makeContext();

    const batch = executor.execute(
      [
        toolCall("call_1", "read_file", { path: "a.txt" }),
        toolCall("call_2", "read_file", { path: "b.txt" }),
        toolCall("call_3", "read_file", { path: "c.txt" }),
      ],
      context,
    );
    await flush();
    expect([...gates.keys()]).toEqual(["a.txt", "b.txt", "c.txt"]);

    gates.get("c.txt")?.resolve(undefined);
    gates.get("b.txt")?.resolve(undefined);
    gates.get("a.txt")?.resolve(undefined);
    const results = await batch;

    expect(results.map((result) => result.toolCallId)).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("normalizes a thrown tool error into an error result", async () => {
    const tool: Tool = {
      name: "read_file",
      description: "reads a file",
      schema: z.object({ path: z.string() }),
      async execute() {
        throw new Error("boom");
      },
    };
    const executor = new ToolBatchExecutor(makeRegistry(tool));
    const { context, started, ended } = makeContext();

    const results = await executor.execute(
      [toolCall("call_1", "read_file", { path: "a.txt" })],
      context,
    );

    expect(started).toEqual(["call_1"]);
    expect(results[0]).toMatchObject({ toolCallId: "call_1", isError: true });
    expect(results[0]?.content[0]).toMatchObject({
      type: "error",
      code: "execution_error",
      message: "boom",
    });
    expect(ended).toEqual(results);
  });

  it("does not execute when the signal is already aborted", async () => {
    const execute = mock(async () => textOutput("ok"));
    const tool: Tool = {
      name: "read_file",
      description: "reads a file",
      schema: z.object({ path: z.string() }),
      execute,
    };
    const executor = new ToolBatchExecutor(makeRegistry(tool));
    const controller = new AbortController();
    controller.abort();
    const { context, started, ended } = makeContext(controller.signal);

    const results = await executor.execute(
      [toolCall("call_1", "read_file", { path: "a.txt" })],
      context,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(started).toEqual([]);
    expect(ended).toEqual([]);
    expect(results[0]?.content[0]).toMatchObject({ type: "error", code: "aborted" });
  });

  it("normalizes a rejection caused by an abort during execution", async () => {
    const tool: Tool = {
      name: "bash",
      description: "runs a command",
      schema: z.object({ command: z.string() }),
      execute(context) {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        });
      },
    };
    const executor = new ToolBatchExecutor(makeRegistry(tool));
    const controller = new AbortController();
    const { context } = makeContext(controller.signal);

    const batch = executor.execute([toolCall("call_1", "bash", { command: "sleep 10" })], context);
    await flush();
    controller.abort();
    const results = await batch;

    expect(results[0]).toMatchObject({ toolCallId: "call_1", isError: true });
    expect(results[0]?.content[0]).toMatchObject({ type: "error", code: "aborted" });
  });
});
