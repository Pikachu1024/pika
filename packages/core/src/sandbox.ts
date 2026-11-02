import type { SandboxBackend, SandboxPolicy } from "@pika-harness/schema";

export interface ExecRequest {
  program: string;
  args: string[];
  cwd: string;
  stdin?: string;
  /** Cancels the execution and terminates its process group. */
  signal?: AbortSignal;
  /** Receives decoded stdout and stderr chunks while the process runs. */
  onOutput?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  fullOutputRef?: string;
  /** Set when the backend classified the failure as a sandbox denial. */
  denied?: { reason: string };
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
  /**
   * `policy` overrides the policy supplied at construction, so a session-scoped
   * escalation applies to in-process file tools without rebuilding them.
   */
  resolve(requestedPath: string, operation: PathOperation, policy?: SandboxPolicy): Promise<string>;
}

/** One outbound destination observed by a sandbox proxy. */
export interface NetworkProxyRecord {
  host: string;
  port: number;
  allowed: boolean;
  reason: string;
  timestamp: string;
}

/** Local allowlist proxy used by `network: "proxy"` policies. */
export interface NetworkProxy {
  readonly url: string;
  records(): NetworkProxyRecord[];
  close(): Promise<void>;
}
