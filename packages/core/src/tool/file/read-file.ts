import { open } from "node:fs/promises";
import { z } from "zod";
import type { PathPolicy } from "../../sandbox.js";
import type { Tool, ToolContext, ToolOutput } from "../../tools.js";
import { errorOutput, toToolError } from "./common.js";

const DEFAULT_MAX_READ_BYTES = 1_048_576;

export const ReadFileArgsSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

export type ReadFileArgs = z.infer<typeof ReadFileArgsSchema>;

export interface ReadFileToolOptions {
  pathPolicy: PathPolicy;
  maxBytes?: number;
}

/** Creates a text file reader that is authorized by the sandbox path policy. */
export function createReadFileTool(options: ReadFileToolOptions): Tool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;

  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. Use offset and limit to select a line range.",
    schema: ReadFileArgsSchema,
    async execute(_context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as ReadFileArgs;
      try {
        const resolved = await options.pathPolicy.resolve(args.path, "read");
        const handle = await open(resolved, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) {
            return errorOutput(`not a regular file: ${args.path}`, "not_a_file");
          }
          const readBytes = Math.min(stat.size, maxBytes);
          const buffer = Buffer.alloc(readBytes);
          const { bytesRead } = await handle.read(buffer, 0, readBytes, 0);
          let text = buffer.subarray(0, bytesRead).toString("utf8");
          const truncated = stat.size > maxBytes;
          if (truncated) {
            // Ending on a line boundary keeps a large read from emitting a
            // partial line or a dangling multi-byte sequence.
            const lastNewline = text.lastIndexOf("\n");
            text = lastNewline === -1 ? text : text.slice(0, lastNewline + 1);
          }

          const lines = text.split("\n");
          const startLine = args.offset ?? 1;
          const endLine =
            args.limit === undefined
              ? lines.length
              : Math.min(lines.length, startLine - 1 + args.limit);
          const selected =
            args.offset === undefined && args.limit === undefined
              ? text
              : lines.slice(startLine - 1, endLine).join("\n");
          const rangeTruncated = args.limit !== undefined && lines.length > endLine;

          return {
            content: [{ type: "text", text: selected }],
            isError: false,
            details: {
              path: args.path,
              startLine,
              endLine,
              totalLines: lines.length,
              truncated: truncated || rangeTruncated,
            },
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        return toToolError(error);
      }
    },
  };
}
