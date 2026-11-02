import path from "node:path";
import { PathPolicyError } from "../../sandbox/path-policy.js";
import type { ToolOutput } from "../../tools.js";

/** Returns a structured error result for a tool that could not produce output. */
export function errorOutput(message: string, code: string): ToolOutput {
  return { content: [{ type: "error", message, code }], isError: true };
}

/** Maps a path-policy or filesystem failure to a structured tool error. */
export function toToolError(error: unknown): ToolOutput {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PathPolicyError) {
    return errorOutput(message === "" ? error.code : message, error.code);
  }
  switch (nodeErrorCode(error)) {
    case "ENOENT":
      return errorOutput(message, "not_found");
    case "EACCES":
    case "EPERM":
      return errorOutput(message, "permission_denied");
    case "EISDIR":
      return errorOutput(message, "is_directory");
    case "ENOTDIR":
      return errorOutput(message, "not_a_directory");
    default:
      return errorOutput(message === "" ? "unknown file error" : message, "io_error");
  }
}

// Every mutating file tool shares a key per absolute target so two calls that
// spell the same file differently still serialize. Symlink aliases are resolved
// later by the path policy, so they remain a best-effort match.
export function writeConcurrencyKey(args: unknown): string | null {
  if (
    typeof args === "object" &&
    args !== null &&
    "path" in args &&
    typeof args.path === "string"
  ) {
    return `write:${path.resolve(args.path)}`;
  }
  return "write";
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === "string" ? code : undefined;
}
