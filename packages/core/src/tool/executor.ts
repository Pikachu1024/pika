import type { ToolCall, ToolResult } from "@pika-harness/schema";
import type { Tool, ToolBatchContext, ToolExecutor, ToolOutput } from "../tools.js";
import type { ToolRegistry } from "./registry.js";

interface ValidCall {
  index: number;
  call: ToolCall;
  tool: Tool;
  args: unknown;
}

type PreflightResult =
  | { ok: true; entry: ValidCall }
  | { ok: false; index: number; result: ToolResult };

/** Validates a batch, then runs independent calls concurrently and conflicting calls in order. */
export class ToolBatchExecutor implements ToolExecutor {
  readonly #registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.#registry = registry;
  }

  async execute(calls: ToolCall[], context: ToolBatchContext): Promise<ToolResult[]> {
    if (context.signal.aborted) {
      return calls.map((call) => abortedResult(call, context.signal));
    }

    const results = new Array<ToolResult>(calls.length);
    const batches: ValidCall[][] = [];
    const keyed = new Map<string, ValidCall[]>();

    calls.forEach((call, index) => {
      const preflight = preflightCall(this.#registry, call, index);
      if (!preflight.ok) {
        results[preflight.index] = preflight.result;
        return;
      }

      const { entry } = preflight;
      let key: string | null;
      try {
        key = entry.tool.concurrencyKey?.(entry.args) ?? null;
      } catch (error) {
        results[index] = errorResult(
          call,
          `concurrency key failed for tool "${call.name}": ${errorMessage(error)}`,
          "execution_error",
        );
        return;
      }

      if (key === null) {
        batches.push([entry]);
        return;
      }

      const existing = keyed.get(key);
      if (existing !== undefined) {
        existing.push(entry);
        return;
      }
      const created = [entry];
      keyed.set(key, created);
      batches.push(created);
    });

    await Promise.all(batches.map((batch) => this.#runBatch(batch, context, results)));
    return results;
  }

  async #runBatch(
    batch: ValidCall[],
    context: ToolBatchContext,
    results: ToolResult[],
  ): Promise<void> {
    for (const entry of batch) {
      if (context.signal.aborted) {
        results[entry.index] = abortedResult(entry.call, context.signal);
        continue;
      }
      results[entry.index] = await this.#runCall(entry, context);
    }
  }

  async #runCall(entry: ValidCall, context: ToolBatchContext): Promise<ToolResult> {
    const { call, tool, args } = entry;
    context.onStart(call);

    let result: ToolResult;
    try {
      const output: ToolOutput = await tool.execute(
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: call.id,
          signal: context.signal,
        },
        args,
      );
      result = { ...output, toolCallId: call.id };
    } catch (error) {
      result = errorResult(
        call,
        errorMessage(error),
        context.signal.aborted ? "aborted" : "execution_error",
      );
    }

    context.onEnd(call, result);
    return result;
  }
}

function preflightCall(registry: ToolRegistry, call: ToolCall, index: number): PreflightResult {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch (error) {
    return {
      ok: false,
      index,
      result: errorResult(
        call,
        `invalid JSON arguments for tool "${call.name}": ${errorMessage(error)}`,
        "invalid_arguments",
      ),
    };
  }

  const tool = registry.get(call.name);
  if (tool === undefined) {
    return {
      ok: false,
      index,
      result: errorResult(call, `unknown tool: ${call.name}`, "unknown_tool"),
    };
  }

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.map((part) => String(part)).join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    return {
      ok: false,
      index,
      result: errorResult(
        call,
        `invalid arguments for tool "${call.name}": ${detail}`,
        "validation_error",
      ),
    };
  }

  return { ok: true, entry: { index, call, tool, args: parsed.data } };
}

function errorResult(call: ToolCall, message: string, code: string): ToolResult {
  return {
    toolCallId: call.id,
    content: [{ type: "error", message, code }],
    isError: true,
  };
}

function abortedResult(call: ToolCall, signal: AbortSignal): ToolResult {
  return errorResult(call, abortMessage(signal), "aborted");
}

function abortMessage(signal: AbortSignal): string {
  const { reason } = signal;
  return reason instanceof Error && reason.message !== ""
    ? `tool call aborted: ${reason.message}`
    : "tool call aborted";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "unknown error" : message;
}
