import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExecRequest, ExecResult, Executor, SandboxCapabilities } from "@pika-harness/core";
import type { SandboxBackend, SandboxPolicy } from "@pika-harness/schema";

const DEFAULT_KILL_GRACE_MS = 2_000;

// Even when a caller allowlists a name, anything shaped like a credential is
// dropped so a provider key cannot reach a tool subprocess by misconfiguration.
const SECRET_ENV_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?|AUTH)(?:_|$)/i;

export interface NodeProcessExecutorOptions {
  /** Environment consulted for allowlisted names; defaults to `process.env`. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Extra names that are never forwarded even when the policy allowlists them. */
  deniedEnvNames?: readonly string[];
  /** Delay between SIGTERM and SIGKILL when terminating a process group. */
  killGraceMs?: number;
}

/** Spawns processes with a constructed environment; it provides no OS-level isolation. */
export class NodeProcessExecutor implements Executor {
  readonly backend: SandboxBackend = "none";
  readonly #sourceEnv: NodeJS.ProcessEnv;
  readonly #deniedEnvNames: readonly string[];
  readonly #killGraceMs: number;

  constructor(options: NodeProcessExecutorOptions = {}) {
    this.#sourceEnv = options.sourceEnv ?? process.env;
    this.#deniedEnvNames = options.deniedEnvNames ?? [];
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  async probe(): Promise<SandboxCapabilities> {
    return {
      backend: "none",
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    };
  }

  async exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult> {
    if (request.program.length === 0) {
      throw new Error("cannot execute an empty program name");
    }
    if (request.signal?.aborted) {
      throw abortReason(request.signal);
    }

    const env = buildProcessEnvironment(policy, this.#sourceEnv, this.#deniedEnvNames);
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(request.program, request.args, {
        cwd: request.cwd,
        env,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const stdout = createCapture();
      const stderr = createCapture();
      let remainingBytes = policy.maxOutputBytes;
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (): void => {
        killProcessGroup(child.pid, "SIGTERM");
        killTimer = setTimeout(() => {
          killProcessGroup(child.pid, "SIGKILL");
        }, this.#killGraceMs);
        killTimer.unref();
      };

      const onAbort = (): void => {
        terminate();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, policy.timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        request.signal?.removeEventListener("abort", onAbort);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        remainingBytes = captureChunk(stdout, chunk, remainingBytes);
        request.onOutput?.(stdoutDecoder.write(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        remainingBytes = captureChunk(stderr, chunk, remainingBytes);
        request.onOutput?.(stderrDecoder.write(chunk));
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        request.onOutput?.(stdoutDecoder.end());
        request.onOutput?.(stderrDecoder.end());
        // Background jobs keep the process group alive after the direct child
        // exits, so every completed call sweeps the group it created.
        killProcessGroup(child.pid, "SIGTERM");
        resolve({
          exitCode,
          signal,
          stdout: stdout.chunks.join(""),
          stderr: stderr.chunks.join(""),
          timedOut,
          truncated: stdout.truncated || stderr.truncated,
        });
      });

      if (request.stdin === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(request.stdin);
      }
    });
  }
}

/** Builds a child environment from the allowlist, dropping credentials by name. */
export function buildProcessEnvironment(
  policy: SandboxPolicy,
  sourceEnv: NodeJS.ProcessEnv,
  deniedEnvNames: readonly string[] = [],
): Record<string, string> {
  const denied = new Set(deniedEnvNames);
  const env: Record<string, string> = {};
  for (const name of policy.envAllowlist) {
    if (denied.has(name) || SECRET_ENV_NAME.test(name)) continue;
    const value = sourceEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface Capture {
  chunks: string[];
  totalBytes: number;
  truncated: boolean;
}

function createCapture(): Capture {
  return { chunks: [], totalBytes: 0, truncated: false };
}

// The shared budget is consumed in order; a partial chunk is decoded only up to
// the last complete UTF-8 sequence so a cut never yields a replacement glyph.
function captureChunk(capture: Capture, chunk: Buffer, remainingBytes: number): number {
  capture.totalBytes += chunk.length;
  if (remainingBytes <= 0) {
    capture.truncated = true;
    return 0;
  }
  if (chunk.length <= remainingBytes) {
    capture.chunks.push(chunk.toString("utf8"));
    return remainingBytes - chunk.length;
  }
  capture.truncated = true;
  capture.chunks.push(decodePrefix(chunk, remainingBytes));
  return 0;
}

function decodePrefix(buffer: Buffer, bytes: number): string {
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && isContinuationByte(buffer[end - 1] ?? 0)) {
    end -= 1;
  }
  if (end > 0) {
    const lead = buffer[end - 1] ?? 0;
    const needed = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
    if (bytes - end < needed) {
      end -= 1;
    }
  }
  return buffer.subarray(0, end).toString("utf8");
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code: unknown = error.code;
  return typeof code === "string" ? code : undefined;
}

function abortReason(signal: AbortSignal): Error {
  const { reason } = signal;
  return reason instanceof Error ? reason : new Error("execution aborted");
}
