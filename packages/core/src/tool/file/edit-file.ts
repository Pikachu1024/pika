import { open, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { PathPolicy } from "../../sandbox.js";
import type { Tool, ToolContext, ToolOutput } from "../../tools.js";
import { errorOutput, toToolError, writeConcurrencyKey } from "./common.js";

const DEFAULT_MAX_EDIT_BYTES = 5_242_880;

export const EditFileArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});

export type EditFileArgs = z.infer<typeof EditFileArgsSchema>;

export interface EditFileToolOptions {
  pathPolicy: PathPolicy;
  maxBytes?: number;
}

/** Creates a text replacement tool that refuses ambiguous matches by default. */
export function createEditFileTool(options: EditFileToolOptions): Tool {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_EDIT_BYTES;

  return {
    name: "edit_file",
    description:
      "Replace an exact text fragment in a workspace file. oldText must match exactly once unless replaceAll is true.",
    schema: EditFileArgsSchema,
    sandbox: { write: true, arbitraryProcess: false },
    concurrencyKey: writeConcurrencyKey,
    async execute(context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as EditFileArgs;
      try {
        const resolved = await options.pathPolicy.resolve(
          args.path,
          "write",
          context.sandboxPolicy,
        );
        const handle = await open(resolved, "r");
        let original: string;
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) {
            return errorOutput(`not a regular file: ${args.path}`, "not_a_file");
          }
          if (stat.size > maxBytes) {
            return errorOutput(
              `file is ${stat.size} bytes, which exceeds the ${maxBytes}-byte edit limit: ${args.path}`,
              "file_too_large",
            );
          }
          original = (await handle.readFile()).toString("utf8");
        } finally {
          await handle.close();
        }

        const matches = countOccurrences(original, args.oldText);
        if (matches === 0) {
          return errorOutput(`oldText was not found in ${args.path}`, "no_match");
        }
        if (matches > 1 && args.replaceAll !== true) {
          return errorOutput(
            `oldText matches ${matches} times in ${args.path}; set replaceAll to replace every match`,
            "ambiguous_match",
          );
        }

        const updated =
          args.replaceAll === true
            ? original.split(args.oldText).join(args.newText)
            : original.replace(args.oldText, args.newText);
        await writeFile(resolved, updated, "utf8");

        return {
          content: [
            {
              type: "text",
              text: `Replaced ${matches} occurrence${matches === 1 ? "" : "s"} in ${args.path}`,
            },
          ],
          isError: false,
          details: { path: args.path, replacements: matches },
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
