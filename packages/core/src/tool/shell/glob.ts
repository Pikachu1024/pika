import type { SandboxPolicy } from "@pika-harness/schema";
import { z } from "zod";
import type { ExecResult, Executor, PathPolicy } from "../../sandbox.js";
import type { Tool, ToolContext, ToolOutput } from "../../tools.js";
import { errorOutput, toToolError } from "../file/common.js";
import { errorMessage, execOutput, recordExecDenial } from "./exec-output.js";

export const GlobArgsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
});

export type GlobArgs = z.infer<typeof GlobArgsSchema>;

export interface GlobToolOptions {
  executor: Executor;
  pathPolicy: PathPolicy;
  policy: SandboxPolicy;
  cwd: string;
}

/** Creates a file finder that runs through the sandbox executor and sorts results. */
export function createGlobTool(options: GlobToolOptions): Tool {
  return {
    name: "glob",
    description:
      "Find files by name or relative path glob. Use a pattern containing / to match a path fragment.",
    schema: GlobArgsSchema,
    async execute(context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as GlobArgs;
      let root: string;
      try {
        root = await options.pathPolicy.resolve(args.path ?? ".", "read", context.sandboxPolicy);
      } catch (error) {
        return toToolError(error);
      }

      const usesPath = args.pattern.includes("/");
      const matchArgs = usesPath ? ["-path", `*/${args.pattern}`] : ["-name", args.pattern];

      const policy = context.sandboxPolicy ?? options.policy;
      try {
        const result = await options.executor.exec(
          {
            program: "find",
            args: [root, "-type", "f", ...matchArgs],
            cwd: options.cwd,
            signal: context.signal,
            onOutput: context.onUpdate,
          },
          policy,
        );
        await recordExecDenial(context, options.executor.backend, policy, result);
        return execOutput(sortLines(result), {
          policy,
          emptyMessage: "no files matched",
        });
      } catch (error) {
        return errorOutput(errorMessage(error), "execution_error");
      }
    },
  };
}

function sortLines(result: ExecResult): ExecResult {
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  if (lines.length === 0) return result;
  return { ...result, stdout: `${lines.sort().join("\n")}\n` };
}
