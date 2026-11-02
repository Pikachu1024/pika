import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ExecRequest, ExecResult, SandboxCapabilities } from "@pika-harness/core";
import type { NetworkPolicy, SandboxMode, SandboxPolicy } from "@pika-harness/schema";
import { detectDenial } from "./denial.js";
import { NodeProcessExecutor, type NodeProcessExecutorOptions } from "./node-executor.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface SeatbeltProfileInput {
  mode: SandboxMode;
  writableRoots: readonly string[];
  deniedReads: readonly string[];
  network: NetworkPolicy;
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function subpaths(paths: readonly string[]): string {
  return paths.map((entry) => `(subpath ${quote(entry)})`).join(" ");
}

/** Renders a Seatbelt profile; roots must already be canonical. */
export function renderSeatbeltProfile(input: SeatbeltProfileInput): string {
  if (input.mode === "danger-full-access") {
    // Deny rules override the default allow so explicit sensitive paths stay
    // closed even when everything else is permitted.
    const lines = ["(version 1)", "(allow default)"];
    if (input.deniedReads.length > 0) {
      lines.push(`(deny file-read* ${subpaths(input.deniedReads)})`);
    }
    return `${lines.join("\n")}\n`;
  }

  const lines = ["(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)"];
  // v1 permits reads anywhere and relies on the deny list for sensitive paths.
  // In-process file tools are still strictly confined by PathPolicy.
  lines.push("(allow file-read*)");
  if (input.deniedReads.length > 0) {
    lines.push(`(deny file-read* ${subpaths(input.deniedReads)})`);
  }
  if (input.writableRoots.length > 0) {
    lines.push(
      `(allow file-write* ${subpaths(input.writableRoots)} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (subpath "/dev/fd"))`,
    );
  } else {
    lines.push(
      '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (subpath "/dev/fd"))',
    );
  }
  if (input.network === "none") {
    lines.push("(deny network*)");
  } else if (input.network === "proxy") {
    // Only the local proxy is reachable; the proxy enforces the destination allowlist.
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
  } else {
    lines.push("(allow network*)");
  }
  return `${lines.join("\n")}\n`;
}

async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

async function profileFor(policy: SandboxPolicy): Promise<string> {
  const [writableRoots, deniedReads] = await Promise.all([
    Promise.all(policy.writableRoots.map(canonical)),
    Promise.all(policy.deniedReads.map(canonical)),
  ]);
  return renderSeatbeltProfile({
    mode: policy.mode,
    writableRoots,
    deniedReads,
    network: policy.network,
  });
}

/** Runs commands under a generated macOS Seatbelt profile. */
export class SeatbeltExecutor extends NodeProcessExecutor {
  override readonly backend = "seatbelt" as const;

  constructor(options: NodeProcessExecutorOptions = {}) {
    super(options);
  }

  override async probe(): Promise<SandboxCapabilities> {
    return {
      backend: "seatbelt",
      filesystemIsolation: true,
      networkIsolation: true,
      processIsolation: true,
    };
  }

  override async exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult> {
    const profile = await profileFor(policy);
    const result = await super.exec(
      {
        ...request,
        program: SANDBOX_EXEC,
        args: ["-p", profile, request.program, ...request.args],
      },
      policy,
    );
    const denied = detectDenial(result, policy);
    return denied === undefined ? result : { ...result, denied };
  }
}

/** Returns true when the Seatbelt binary is available on this host. */
export async function seatbeltAvailable(): Promise<boolean> {
  try {
    await realpath(SANDBOX_EXEC);
    return true;
  } catch {
    return false;
  }
}
