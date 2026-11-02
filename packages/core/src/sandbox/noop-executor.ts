import type { SandboxPolicy } from "@pika-harness/schema";
import type { ExecRequest, ExecResult, Executor, SandboxCapabilities } from "../sandbox.js";

/** Raised when an executor cannot run a request. */
export class SandboxExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxExecutionError";
  }
}

/** Executor used when no sandbox backend is available; it never spawns a process. */
export class NoopExecutor implements Executor {
  readonly backend = "none";

  async probe(): Promise<SandboxCapabilities> {
    return {
      backend: "none",
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    };
  }

  async exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult> {
    throw new SandboxExecutionError(
      `no sandbox backend is available to run "${request.program}" under ${policy.mode} policy`,
    );
  }
}
