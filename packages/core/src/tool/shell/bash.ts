import type { SandboxPolicy } from "@pika-harness/schema";
import { z } from "zod";
import { classifyDenialReason, widenSandboxPolicy } from "../../sandbox/decisions.js";
import type { ExecResult, Executor } from "../../sandbox.js";
import type { Tool, ToolContext, ToolOutput } from "../../tools.js";
import { errorOutput } from "../file/common.js";
import { errorMessage, execOutput } from "./exec-output.js";

const DEFAULT_SHELL = "/bin/bash";

export const BashArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

export type BashArgs = z.infer<typeof BashArgsSchema>;

export interface BashToolOptions {
  executor: Executor;
  policy: SandboxPolicy;
  cwd: string;
  shell?: string;
}

/** Creates a shell tool that runs every command through the sandbox executor. */
export function createBashTool(options: BashToolOptions): Tool {
  const shell = options.shell ?? DEFAULT_SHELL;

  async function run(
    command: string,
    timeoutMs: number,
    policy: SandboxPolicy,
    context: ToolContext,
  ): Promise<ExecResult> {
    return options.executor.exec(
      {
        program: shell,
        args: ["--noprofile", "--norc", "-c", command],
        cwd: options.cwd,
        signal: context.signal,
        onOutput: context.onUpdate,
      },
      { ...policy, timeoutMs },
    );
  }

  return {
    name: "bash",
    description:
      "Run a shell command in the workspace. Commands run without loading login or rc files.",
    schema: BashArgsSchema,
    sandbox: { write: false, arbitraryProcess: true },
    async execute(context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as BashArgs;
      const basePolicy = context.sandboxPolicy ?? options.policy;
      const timeoutMs = Math.min(args.timeoutMs ?? basePolicy.timeoutMs, basePolicy.timeoutMs);
      let policy = basePolicy;

      try {
        let result = await run(args.command, timeoutMs, policy, context);
        if (result.denied !== undefined) {
          await context.recordSandboxDecision?.({
            toolCallId: context.toolCallId,
            backend: options.executor.backend,
            mode: policy.mode,
            outcome: "deny",
            reason: result.denied.reason,
          });
          if (context.requestApproval !== undefined) {
            const decision = await context.requestApproval({
              kind: "sandbox-escalation",
              toolCallId: context.toolCallId,
              toolName: "bash",
              args: { command: args.command },
              reason: result.denied.reason,
            });
            if (decision !== "deny") {
              policy = widenSandboxPolicy(basePolicy, classifyDenialReason(result.denied.reason));
              await context.recordSandboxDecision?.({
                toolCallId: context.toolCallId,
                backend: options.executor.backend,
                mode: policy.mode,
                outcome: "allow",
                reason: `escalation approved for bash: ${result.denied.reason}`,
              });
              result = await run(args.command, timeoutMs, policy, context);
            }
          }
        }
        return execOutput(result, { policy });
      } catch (error) {
        return errorOutput(errorMessage(error), "execution_error");
      }
    },
  };
}
