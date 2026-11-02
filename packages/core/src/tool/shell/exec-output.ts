import type { SandboxBackend, SandboxPolicy } from "@pika-harness/schema";
import type { ExecResult } from "../../sandbox.js";
import type { ToolContext, ToolOutput } from "../../tools.js";

export interface ExecOutputOptions {
  policy: SandboxPolicy;
  /** Exit codes treated as success; defaults to only 0. */
  successExitCodes?: readonly number[];
  /** Shown when the command succeeded without producing output. */
  emptyMessage?: string;
}

/** Converts an executor result into a tool result with an exit classification. */
export function execOutput(result: ExecResult, options: ExecOutputOptions): ToolOutput {
  const success = (options.successExitCodes ?? [0]).includes(result.exitCode ?? -1);
  const notes: string[] = [];
  if (result.timedOut) {
    notes.push(`command timed out after ${options.policy.timeoutMs}ms`);
  } else if (!success) {
    notes.push(
      result.exitCode === null
        ? `command terminated by ${result.signal ?? "unknown signal"}`
        : `command exited with code ${result.exitCode}`,
    );
  }
  if (result.truncated) {
    notes.push("output truncated to the configured limit");
  }

  const sections: string[] = [];
  if (result.stdout.trimEnd() !== "") sections.push(result.stdout.trimEnd());
  if (result.stderr.trimEnd() !== "") sections.push(result.stderr.trimEnd());
  const text =
    [notes.join("; "), sections.join("\n")].filter((part) => part !== "").join("\n") ||
    options.emptyMessage ||
    "(no output)";

  return {
    content: [{ type: "text", text }],
    isError: !success || result.timedOut,
    details: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
    },
  };
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "unknown execution error" : message;
}

/** Records a backend-classified denial for the audit trail. */
export async function recordExecDenial(
  context: ToolContext,
  backend: SandboxBackend,
  policy: SandboxPolicy,
  result: ExecResult,
): Promise<void> {
  if (result.denied === undefined) {
    return;
  }
  await context.recordSandboxDecision?.({
    toolCallId: context.toolCallId,
    backend,
    mode: policy.mode,
    outcome: "deny",
    reason: result.denied.reason,
  });
}
