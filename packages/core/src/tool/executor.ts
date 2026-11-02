import type { ContentPart, ToolCall, ToolResult } from "@pika-harness/schema";
import { canWidenPolicy, classifyToolCall, widenSandboxPolicy } from "../sandbox/decisions.js";
import type {
  Tool,
  ToolBatchContext,
  ToolExecutor,
  ToolOutput,
  ToolOutputStore,
} from "../tools.js";
import type { ToolRegistry } from "./registry.js";

interface ValidCall {
  index: number;
  call: ToolCall;
  tool: Tool;
  args: unknown;
}

export interface ToolBatchExecutorOptions {
  maxOutputBytes?: number;
  outputStore?: ToolOutputStore;
}

const defaultMaxOutputBytes = 1_048_576;

type PreflightResult =
  | { ok: true; entry: ValidCall }
  | { ok: false; index: number; result: ToolResult };

/** Validates a batch, then runs independent calls concurrently and conflicting calls in order. */
export class ToolBatchExecutor implements ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #maxOutputBytes: number;
  readonly #outputStore: ToolOutputStore | undefined;

  constructor(registry: ToolRegistry, options: ToolBatchExecutorOptions = {}) {
    this.#registry = registry;
    this.#maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    this.#outputStore = options.outputStore;
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
    const sandbox = context.sandbox;
    let effectivePolicy = sandbox?.policy;

    if (sandbox !== undefined) {
      const authorization = classifyToolCall({
        call,
        tool,
        policy: sandbox.policy,
        backend: sandbox.backend,
        approvalMode: sandbox.approvalMode ?? "on-request",
      });
      await context.recordSandboxDecision?.(authorization.decision);
      if (authorization.decision.outcome === "deny") {
        const approved =
          context.requestApproval === undefined
            ? undefined
            : await context.requestApproval({
                kind: "sandbox-escalation",
                toolCallId: call.id,
                toolName: call.name,
                args: asArgumentRecord(args),
                reason: authorization.decision.reason,
              });
        if (approved === undefined || approved === "deny") {
          context.onStart(call);
          const result = sandboxDeniedResult(call, authorization.decision.reason);
          context.onEnd(call, result);
          return result;
        }

        const kind = authorization.escalation;
        effectivePolicy =
          kind !== undefined && canWidenPolicy(sandbox.policy, kind)
            ? widenSandboxPolicy(sandbox.policy, kind)
            : sandbox.policy;
        if (approved === "approve_for_session" && effectivePolicy.mode !== sandbox.policy.mode) {
          sandbox.setPolicy?.(effectivePolicy);
        }
        await context.recordSandboxDecision?.({
          toolCallId: call.id,
          backend: sandbox.backend,
          mode: effectivePolicy.mode,
          outcome: "allow",
          reason: `escalation approved for ${call.name}: ${authorization.decision.reason}`,
        });
      }
    }

    context.onStart(call);

    let result: ToolResult;
    try {
      const output: ToolOutput = await tool.execute(
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: call.id,
          signal: context.signal,
          onUpdate: (chunk) => context.onUpdate(call, chunk),
          ...(effectivePolicy === undefined ? {} : { sandboxPolicy: effectivePolicy }),
          ...(context.recordSandboxDecision === undefined
            ? {}
            : { recordSandboxDecision: context.recordSandboxDecision }),
          ...(context.requestApproval === undefined
            ? {}
            : { requestApproval: context.requestApproval }),
        },
        args,
      );
      result = await this.#normalizeOutput({ ...output, toolCallId: call.id });
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

  async #normalizeOutput(output: ToolOutput & { toolCallId: string }): Promise<ToolResult> {
    const textParts = output.content.filter((part) => part.type === "text");
    if (textParts.length === 0) {
      return output;
    }
    const combined = textParts.map((part) => part.text).join("\n");
    const totalBytes = Buffer.byteLength(combined, "utf8");
    if (totalBytes <= this.#maxOutputBytes) {
      return output;
    }

    const { head, tail } = splitForTruncation(combined, this.#maxOutputBytes);
    const reference =
      this.#outputStore === undefined
        ? undefined
        : await this.#outputStore.write(output.toolCallId, combined).catch(() => undefined);
    const marker =
      reference === undefined
        ? `\n... [truncated ${totalBytes - this.#maxOutputBytes} bytes; full output not persisted] ...\n`
        : `\n... [truncated ${totalBytes - this.#maxOutputBytes} bytes; full output: ${reference}] ...\n`;
    let replaced = false;
    const content: ContentPart[] = [];
    for (const part of output.content) {
      if (part.type !== "text") {
        content.push(part);
        continue;
      }
      if (replaced) continue;
      replaced = true;
      content.push({ type: "text", text: `${head}${marker}${tail}` });
    }

    return {
      toolCallId: output.toolCallId,
      content,
      isError: output.isError,
      ...(output.details === undefined ? {} : { details: output.details }),
      ...(reference === undefined ? {} : { fullOutputRef: reference }),
    };
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

function sandboxDeniedResult(call: ToolCall, reason: string): ToolResult {
  return errorResult(call, `denied by sandbox policy: ${reason}`, "sandbox_denied");
}

function asArgumentRecord(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return { value: args };
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

function splitForTruncation(text: string, maxBytes: number): { head: string; tail: string } {
  const buffer = Buffer.from(text, "utf8");
  const headBytes = Math.max(1, Math.floor(maxBytes * 0.6));
  const tailBytes = Math.max(0, maxBytes - headBytes);
  let headEnd = Math.min(headBytes, buffer.length);
  while (headEnd > 0 && isContinuationByte(buffer[headEnd] ?? 0)) {
    headEnd -= 1;
  }
  let tailStart = Math.max(0, buffer.length - tailBytes);
  while (tailStart < buffer.length && isContinuationByte(buffer[tailStart] ?? 0)) {
    tailStart += 1;
  }
  return {
    head: buffer.subarray(0, headEnd).toString("utf8"),
    tail: buffer.subarray(tailStart).toString("utf8"),
  };
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}
