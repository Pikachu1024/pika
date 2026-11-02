import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SandboxPolicy } from "@pika-harness/schema";
import type { PathOperation, PathPolicy } from "../sandbox.js";

export type PathPolicyErrorCode =
  | "read-only"
  | "outside-workspace"
  | "denied-read"
  | "symlink-escape"
  | "invalid-path";

export interface CreatePathPolicyOptions {
  workspaceRoot: string;
  policy: SandboxPolicy;
}

interface CanonicalRoots {
  workspaceRoot: string;
  writableRoots: string[];
  deniedReads: string[];
}

/** Raised when an in-process file operation violates the sandbox path policy. */
export class PathPolicyError extends Error {
  readonly code: PathPolicyErrorCode;

  constructor(code: PathPolicyErrorCode, message: string) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
  }
}

/** Creates a path policy that authorizes in-process file reads and writes. */
export function createPathPolicy(options: CreatePathPolicyOptions): PathPolicy {
  const rootsCache = new Map<string, Promise<CanonicalRoots>>();
  const loadRoots = (policy: SandboxPolicy): Promise<CanonicalRoots> => {
    const key = JSON.stringify([
      policy.workspaceRoot,
      policy.mode,
      policy.writableRoots,
      policy.deniedReads,
    ]);
    let roots = rootsCache.get(key);
    if (roots === undefined) {
      // Roots are canonicalized per policy so every comparison is symlink-free
      // even though the resolver itself is asynchronous.
      roots = canonicalizeRoots(options.workspaceRoot, policy);
      rootsCache.set(key, roots);
    }
    return roots;
  };

  return {
    async resolve(
      requestedPath: string,
      operation: PathOperation,
      override?: SandboxPolicy,
    ): Promise<string> {
      if (requestedPath.length === 0) {
        throw new PathPolicyError("invalid-path", "path must not be empty");
      }
      if (requestedPath.includes("\0")) {
        throw new PathPolicyError("invalid-path", "path must not contain a null byte");
      }
      const policy = override ?? options.policy;
      const roots = await loadRoots(policy);
      const requested = path.resolve(roots.workspaceRoot, requestedPath);
      if (operation === "write" && policy.mode === "read-only") {
        throw new PathPolicyError("read-only", `write denied by read-only policy: ${requested}`);
      }
      // Symlinks are resolved before authorization so a link inside the
      // workspace cannot reach outside it. The canonical path is what callers
      // must use, which also closes the gap between check and use.
      const canonical = await canonicalizePath(requested);
      if (roots.deniedReads.some((denied) => isInsidePath(canonical, denied))) {
        throw new PathPolicyError("denied-read", `read denied by policy: ${requested}`);
      }
      if (policy.mode === "danger-full-access") return canonical;
      if (operation === "read") {
        if (!isInsidePath(canonical, roots.workspaceRoot)) {
          throw escapeError(
            "outside-workspace",
            "read outside the workspace",
            requested,
            canonical,
          );
        }
        return canonical;
      }
      if (!roots.writableRoots.some((root) => isInsidePath(canonical, root))) {
        throw escapeError(
          "outside-workspace",
          "write outside writable roots",
          requested,
          canonical,
        );
      }
      return canonical;
    },
  };
}

// A path that differs from its requested form was rewritten by a symlink, which
// is reported separately from plain confinement failures for the audit trail.
function escapeError(
  code: PathPolicyErrorCode,
  reason: string,
  requested: string,
  canonical: string,
): PathPolicyError {
  if (canonical === requested) {
    return new PathPolicyError(code, `${reason}: ${requested}`);
  }
  return new PathPolicyError("symlink-escape", `${reason}: ${requested} resolves to ${canonical}`);
}

async function canonicalizeRoots(
  fallbackWorkspaceRoot: string,
  policy: SandboxPolicy,
): Promise<CanonicalRoots> {
  const workspaceRoot = path.resolve(policy.workspaceRoot || fallbackWorkspaceRoot);
  const [workspace, writableRoots, deniedReads] = await Promise.all([
    canonicalizePath(workspaceRoot),
    Promise.all(
      policy.writableRoots.map((root) => canonicalizePath(path.resolve(workspaceRoot, root))),
    ),
    Promise.all(
      policy.deniedReads.map((root) => canonicalizePath(path.resolve(workspaceRoot, root))),
    ),
  ]);
  return {
    workspaceRoot: workspace,
    writableRoots: [...new Set(writableRoots)],
    deniedReads: [...new Set(deniedReads)],
  };
}

// Resolves the existing ancestor and re-appends the missing segments so planned
// writes and denied reads can be authorized before the leaf exists.
async function canonicalizePath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new PathPolicyError(
        "invalid-path",
        `cannot resolve ${target}: ${code ?? "unknown error"}`,
      );
    }
  }
  const parent = path.dirname(target);
  if (parent === target) {
    throw new PathPolicyError("invalid-path", `cannot resolve ${target}: no existing ancestor`);
  }
  return path.join(await canonicalizePath(parent), path.basename(target));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === "string" ? code : undefined;
}

function isInsidePath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}
