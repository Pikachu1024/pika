import type { SandboxPolicy } from "@pika-harness/schema";
import { z } from "zod";
import type { Executor, PathPolicy } from "../../sandbox.js";
import type { Tool, ToolContext, ToolOutput } from "../../tools.js";
import { errorOutput, toToolError } from "../file/common.js";
import { errorMessage, execOutput } from "./exec-output.js";

export const GrepArgsSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  ignoreCase: z.boolean().optional(),
});

export type GrepArgs = z.infer<typeof GrepArgsSchema>;

export interface GrepToolOptions {
  executor: Executor;
  pathPolicy: PathPolicy;
  policy: SandboxPolicy;
  cwd: string;
}

/** Creates a recursive text search that runs through the sandbox executor. */
export function createGrepTool(options: GrepToolOptions): Tool {
  return {
    name: "grep",
    description:
      "Search file contents recursively with a regular expression. Returns file:line matches.",
    schema: GrepArgsSchema,
    async execute(context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as GrepArgs;
      let target: string;
      try {
        target = await options.pathPolicy.resolve(args.path ?? ".", "read");
      } catch (error) {
        return toToolError(error);
      }

      const argv = ["-r", "-n", "--no-messages"];
      if (args.ignoreCase === true) argv.push("-i");
      if (args.glob !== undefined) argv.push(`--include=${args.glob}`);
      argv.push("-e", args.pattern, "--", target);

      try {
        const result = await options.executor.exec(
          {
            program: "grep",
            args: argv,
            cwd: options.cwd,
            signal: context.signal,
            onOutput: context.onUpdate,
          },
          options.policy,
        );
        // grep uses exit code 1 for "no matches", which is not a failure.
        return execOutput(result, {
          policy: options.policy,
          successExitCodes: [0, 1],
          emptyMessage: "no matches",
        });
      } catch (error) {
        return errorOutput(errorMessage(error), "execution_error");
      }
    },
  };
}
