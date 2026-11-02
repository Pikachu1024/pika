import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PathPolicy } from "../../sandbox.js";
import type { Tool, ToolContext, ToolOutput } from "../../tools.js";
import { toToolError, writeConcurrencyKey } from "./common.js";

export const WriteFileArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteFileArgs = z.infer<typeof WriteFileArgsSchema>;

export interface WriteFileToolOptions {
  pathPolicy: PathPolicy;
}

/** Creates a whole-file writer that is authorized by the sandbox path policy. */
export function createWriteFileTool(options: WriteFileToolOptions): Tool {
  return {
    name: "write_file",
    description: "Create or replace a UTF-8 text file inside the workspace.",
    schema: WriteFileArgsSchema,
    sandbox: { write: true, arbitraryProcess: false },
    concurrencyKey: writeConcurrencyKey,
    async execute(context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as WriteFileArgs;
      try {
        const resolved = await options.pathPolicy.resolve(
          args.path,
          "write",
          context.sandboxPolicy,
        );
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, args.content, "utf8");
        const bytes = Buffer.byteLength(args.content, "utf8");
        return {
          content: [{ type: "text", text: `Wrote ${bytes} bytes to ${args.path}` }],
          isError: false,
          details: { path: args.path, bytes },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  };
}
