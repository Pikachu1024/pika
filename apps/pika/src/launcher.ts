import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { runClient } from "@pika-harness/cli";
import { withToken } from "@pika-harness/client";
import { serveMain } from "@pika-harness/server";
import { usage } from "./usage.js";

const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;
const STDERR_LIMIT = 8_192;
const READY_PATTERN = /pika-server listening on (ws:\/\/\S+)/;

/** Environment variables forwarded to the local server child process. */
const CHILD_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
]);

export interface ServerSpawnSpec {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ServerProcess {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface LauncherDeps {
  spawnServer(spec: ServerSpawnSpec): ServerProcess;
  runClient(argv: string[], options?: { onExit?: () => void }): Promise<void>;
  serveMain(argv: string[]): Promise<void>;
  randomToken(): string;
  env: Record<string, string | undefined>;
  cwd: string;
  startupTimeoutMs: number;
  shutdownGraceMs: number;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/** Builds the command that re-executes this binary in server mode. */
export function serverCommand(execPath: string, entryPath: string): string[] {
  const executable = path.basename(execPath);
  const standalone = executable !== "bun" && executable !== "bun.exe";
  return standalone ? [execPath, "serve"] : [execPath, entryPath, "serve"];
}

/** Runs the single entrypoint and sets the process exit code when nonzero. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const code = await runLauncher(argv);
  if (code !== 0) process.exitCode = code;
}

/** Dispatches client, serve, help, and remote modes; returns an exit code. */
export async function runLauncher(
  argv: string[],
  overrides: Partial<LauncherDeps> = {},
): Promise<number> {
  const deps: LauncherDeps = {
    spawnServer: overrides.spawnServer ?? spawnServer,
    runClient:
      overrides.runClient ??
      ((args, options) =>
        runClient(args, options?.onExit === undefined ? {} : { onExit: options.onExit })),
    serveMain: overrides.serveMain ?? ((args) => serveMain(args)),
    randomToken: overrides.randomToken ?? (() => randomBytes(32).toString("base64url")),
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
    startupTimeoutMs: overrides.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    shutdownGraceMs: overrides.shutdownGraceMs ?? SHUTDOWN_GRACE_MS,
    writeOut: overrides.writeOut ?? ((text) => process.stdout.write(text)),
    writeErr: overrides.writeErr ?? ((text) => process.stderr.write(text)),
  };

  if (argv[0] === "serve") {
    await deps.serveMain(argv.slice(1));
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.writeOut(usage);
    return 0;
  }

  const remote = detectRemote(argv, deps.env);
  if (remote === "invalid") {
    deps.writeErr("pika: --url requires a WebSocket URL\n");
    return 2;
  }
  if (remote === "remote") {
    return runClientOnly(argv, deps);
  }
  return runLocal(argv, deps);
}

async function runClientOnly(argv: string[], deps: LauncherDeps): Promise<number> {
  try {
    await deps.runClient(argv);
    return currentExitCode();
  } catch (error) {
    deps.writeErr(`pika: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function runLocal(argv: string[], deps: LauncherDeps): Promise<number> {
  const token = deps.randomToken();
  const started = deps.spawnServer({
    command: [
      ...serverCommand(process.execPath, Bun.main),
      "--port",
      "0",
      "--exit-on-parent-stdin-close",
    ],
    cwd: deps.cwd,
    env: childEnv(deps.env, token),
  });
  const stderrText = collectText(started.stderr);

  let url: string;
  try {
    url = await waitForReady(started, deps.startupTimeoutMs, stderrText);
  } catch (error) {
    await terminate(started, deps.shutdownGraceMs);
    deps.writeErr(`pika: ${errorMessage(error)}\n`);
    return 1;
  }
  return runWithServer(started, url, token, argv, deps);
}

async function runWithServer(
  server: ServerProcess,
  url: string,
  token: string,
  argv: string[],
  deps: LauncherDeps,
): Promise<number> {
  const clientArgv = ["--url", withToken(url, token), ...argv];
  const oneShot = hasPrompt(argv);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await terminate(server, deps.shutdownGraceMs);
  };
  const onSignal = (code: number): void => {
    void stop().then(() => process.exit(code));
  };
  const onInterrupt = (): void => onSignal(130);
  const onTerminate = (): void => onSignal(143);
  const onProcessExit = (): void => {
    try {
      server.kill("SIGTERM");
    } catch {
      // The child may already be gone during process exit.
    }
  };

  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("exit", onProcessExit);
  try {
    if (oneShot) {
      await deps.runClient(clientArgv);
      return currentExitCode();
    }
    await deps.runClient(clientArgv, { onExit: () => undefined });
    return 0;
  } catch (error) {
    deps.writeErr(`pika: ${errorMessage(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("exit", onProcessExit);
    await stop();
  }
}

function spawnServer(spec: ServerSpawnSpec): ServerProcess {
  const child = Bun.spawn({
    cmd: spec.command,
    cwd: spec.cwd,
    env: spec.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout as ReadableStream<Uint8Array>;
  const stderr = child.stderr as ReadableStream<Uint8Array>;
  return {
    exited: child.exited,
    stdout,
    stderr,
    kill: (signal) => child.kill(signal),
  };
}

function childEnv(env: Record<string, string | undefined>, token: string): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("PIKA_") || CHILD_ENV_KEYS.has(key)) allowed[key] = value;
  }
  allowed.PIKA_SERVER_TOKEN = token;
  return allowed;
}

async function waitForReady(
  server: ServerProcess,
  timeoutMs: number,
  stderrText: () => string,
): Promise<string> {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    server.kill("SIGTERM");
  }, timeoutMs);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const match = READY_PATTERN.exec(line);
        if (match?.[1] !== undefined) return match[1];
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > 65_536) {
        throw new Error("local server produced unexpected output before it was ready");
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be cancelled by process exit.
    }
  }

  const status = await Promise.race([server.exited, Bun.sleep(250).then(() => -1)]);
  const suffix = formatStderr(stderrText());
  if (timedOut) {
    throw new Error(`local server did not become ready within ${timeoutMs}ms${suffix}`);
  }
  throw new Error(`local server exited before it was ready (status ${status})${suffix}`);
}

async function terminate(server: ServerProcess, graceMs: number): Promise<void> {
  try {
    server.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(graceMs).then(() => false),
  ]);
  if (exited) return;
  try {
    server.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([server.exited, Bun.sleep(500)]);
}

function collectText(stream: ReadableStream<Uint8Array>, limit = STDERR_LIMIT): () => string {
  const decoder = new TextDecoder();
  let text = "";
  void (async () => {
    try {
      for await (const chunk of stream) {
        if (text.length < limit) text += decoder.decode(chunk, { stream: true });
      }
    } catch {
      // The stream closes with the child process.
    }
  })();
  return () => text.trim();
}

function formatStderr(text: string): string {
  return text.length === 0 ? "" : `: ${text}`;
}

function detectRemote(
  argv: string[],
  env: Record<string, string | undefined>,
): "local" | "remote" | "invalid" {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--url") continue;
    const value = argv[index + 1];
    return value === undefined || value.startsWith("--") ? "invalid" : "remote";
  }
  const fromEnv = env.PIKA_SERVER_URL;
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? "remote" : "local";
}

function hasPrompt(argv: string[]): boolean {
  const index = argv.indexOf("--prompt");
  return index !== -1 && argv[index + 1] !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentExitCode(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}
