import type { SandboxPolicy } from "@pika-harness/schema";
import { z } from "zod";
import type { Executor } from "../../sandbox.js";
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

  return {
    name: "bash",
    description:
      "Run a shell command in the workspace. Commands run without loading login or rc files.",
    schema: BashArgsSchema,
    async execute(context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as BashArgs;
      const timeoutMs = Math.min(
        args.timeoutMs ?? options.policy.timeoutMs,
        options.policy.timeoutMs,
      );
      const policy: SandboxPolicy = { ...options.policy, timeoutMs };
      try {
        const result = await options.executor.exec(
          {
            program: shell,
            args: ["--noprofile", "--norc", "-c", args.command],
            cwd: options.cwd,
            signal: context.signal,
            onOutput: context.onUpdate,
          },
          policy,
        );
        return execOutput(result, { policy });
      } catch (error) {
        return errorOutput(errorMessage(error), "execution_error");
      }
    },
  };
}
