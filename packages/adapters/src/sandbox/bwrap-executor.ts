import { stat } from "node:fs/promises";
import type { ExecRequest, ExecResult, SandboxCapabilities } from "@pika-harness/core";
import type { SandboxPolicy } from "@pika-harness/schema";
import { detectDenial } from "./denial.js";
import { findExecutable } from "./executables.js";
import { NodeProcessExecutor, type NodeProcessExecutorOptions } from "./node-executor.js";

async function deniedMask(target: string): Promise<string[]> {
  try {
    const info = await stat(target);
    return info.isDirectory() ? ["--tmpfs", target] : ["--ro-bind", "/dev/null", target];
  } catch {
    return [];
  }
}

/** Builds bubblewrap arguments for the effective policy. */
export async function buildBwrapArgs(
  request: ExecRequest,
  policy: SandboxPolicy,
): Promise<string[]> {
  if (policy.mode === "danger-full-access") {
    const args = ["--dev-bind", "/", "/"];
    for (const denied of policy.deniedReads) {
      args.push(...(await deniedMask(denied)));
    }
    args.push("--chdir", request.cwd, "--", request.program, ...request.args);
    return args;
  }

  const args = ["--die-with-parent", "--unshare-pid", "--unshare-uts", "--unshare-ipc"];
  // Proxy routing into the namespace is not implemented yet, so both restricted
  // modes fail closed instead of exposing the host network.
  if (policy.network !== "full") {
    args.push("--unshare-net");
  }
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");

  if (policy.workspaceRoot !== "") {
    args.push("--ro-bind", policy.workspaceRoot, policy.workspaceRoot);
  }
  for (const root of policy.writableRoots) {
    args.push("--bind", root, root);
  }
  for (const denied of policy.deniedReads) {
    args.push(...(await deniedMask(denied)));
  }
  args.push("--chdir", request.cwd, "--", request.program, ...request.args);
  return args;
}

/** Runs commands in bubblewrap namespaces on Linux. */
export class BwrapExecutor extends NodeProcessExecutor {
  override readonly backend = "bwrap" as const;
  readonly #bwrap: string;

  constructor(bwrapPath: string, options: NodeProcessExecutorOptions = {}) {
    super(options);
    this.#bwrap = bwrapPath;
  }

  override async probe(): Promise<SandboxCapabilities> {
    return {
      backend: "bwrap",
      filesystemIsolation: true,
      networkIsolation: true,
      processIsolation: true,
    };
  }

  override async exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult> {
    const args = await buildBwrapArgs(request, policy);
    const result = await super.exec({ ...request, program: this.#bwrap, args }, policy);
    const denied = detectDenial(result, policy);
    return denied === undefined ? result : { ...result, denied };
  }
}

/** Creates a bubblewrap executor when the binary is installed. */
export function createBwrapExecutor(
  options: NodeProcessExecutorOptions = {},
): BwrapExecutor | undefined {
  const bwrap = findExecutable("bwrap");
  return bwrap === undefined ? undefined : new BwrapExecutor(bwrap, options);
}
