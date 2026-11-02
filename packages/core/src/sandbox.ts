import type { SandboxBackend, SandboxPolicy } from "@pika-harness/schema";

export interface ExecRequest {
  program: string;
  args: string[];
  cwd: string;
  stdin?: string;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  fullOutputRef?: string;
}

export interface SandboxCapabilities {
  backend: SandboxBackend;
  filesystemIsolation: boolean;
  networkIsolation: boolean;
  processIsolation: boolean;
}

/** All tool-initiated subprocess execution goes through this boundary. */
export interface Executor {
  readonly backend: SandboxBackend;
  exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult>;
  probe(): Promise<SandboxCapabilities>;
}

export type PathOperation = "read" | "write";

/** Resolves a requested path and rejects it when the operation is outside the policy. */
export interface PathPolicy {
  resolve(requestedPath: string, operation: PathOperation): Promise<string>;
}
