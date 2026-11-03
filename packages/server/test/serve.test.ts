import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWebSocketClientTransport, PikaClient } from "@pika-harness/client";
import { parseServeArgs, serveUsage, startServe } from "@pika-harness/server";
import { WebSocket } from "ws";

const entry = path.resolve(import.meta.dir, "../src/bin.ts");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("serve flags", () => {
  it("reads defaults from the environment", () => {
    const options = parseServeArgs([], {
      PIKA_PORT: "0",
      PIKA_HOST: "127.0.0.2",
      PIKA_SESSION_DIR: "/tmp/pika-sessions",
      PIKA_SERVER_TOKEN: "env-token",
    });
    expect(options.port).toBe(0);
    expect(options.host).toBe("127.0.0.2");
    expect(options.dir).toBe("/tmp/pika-sessions");
    expect(options.token).toBe("env-token");
    expect(options.help).toBe(false);
  });

  it("lets flags override the port, host, and directory", () => {
    const options = parseServeArgs(["--port", "7444", "--host", "0.0.0.0", "--dir", "/data"], {
      PIKA_PORT: "7331",
      PIKA_HOST: "127.0.0.1",
      PIKA_SESSION_DIR: "/default",
    });
    expect(options.port).toBe(7444);
    expect(options.host).toBe("0.0.0.0");
    expect(options.dir).toBe("/data");
  });

  it("reports help and the parent-close flag", () => {
    expect(parseServeArgs(["--help"]).help).toBe(true);
    expect(parseServeArgs(["--exit-on-parent-stdin-close"]).exitOnParentStdinClose).toBe(true);
  });

  it("selects the sandbox backend from the environment and flags", () => {
    expect(parseServeArgs([], {}).sandboxBackend).toBe("auto");
    expect(parseServeArgs([], { PIKA_SANDBOX_BACKEND: "bwrap" }).sandboxBackend).toBe("bwrap");
    expect(
      parseServeArgs(["--sandbox-backend", "none"], { PIKA_SANDBOX_BACKEND: "seatbelt" })
        .sandboxBackend,
    ).toBe("none");
  });

  it("rejects an unknown sandbox backend with the accepted list", () => {
    expect(() => parseServeArgs(["--sandbox-backend", "chroot"], {})).toThrow(
      /auto, none, seatbelt, bwrap, docker/,
    );
    expect(() => parseServeArgs([], { PIKA_SANDBOX_BACKEND: "chroot" })).toThrow(
      /auto, none, seatbelt, bwrap, docker/,
    );
  });

  it("documents every sandbox backend in the usage text", () => {
    for (const value of ["auto", "none", "seatbelt", "bwrap", "docker"]) {
      expect(serveUsage).toContain(value);
    }
    expect(parseServeArgs(["--help"]).help).toBe(true);
  });

  it("rejects unknown flags and invalid ports", () => {
    expect(() => parseServeArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseServeArgs(["--port", "70000"])).toThrow(/invalid port/);
  });
});

describe("serve persistence", () => {
  it("creates a new session id when the directory already contains sessions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pika-serve-id-"));
    const clients: PikaClient[] = [];
    cleanups.push(async () => {
      for (const client of clients.splice(0)) client.close();
      await rm(dir, { recursive: true, force: true });
    });

    const first = await startServe({
      port: 0,
      host: "127.0.0.1",
      dir,
      sandboxBackend: "none",
      help: false,
    });
    const firstClient = new PikaClient({ transport: createWebSocketClientTransport(first.url) });
    clients.push(firstClient);
    await firstClient.initialize();
    const firstSession = await firstClient.startSession({ cwd: dir });
    firstClient.close();
    await first.close();

    const second = await startServe({
      port: 0,
      host: "127.0.0.1",
      dir,
      sandboxBackend: "none",
      help: false,
    });
    cleanups.push(() => second.close());
    const secondClient = new PikaClient({ transport: createWebSocketClientTransport(second.url) });
    clients.push(secondClient);
    await secondClient.initialize();
    const secondSession = await secondClient.startSession({ cwd: dir });

    expect(secondSession.session.id).not.toBe(firstSession.session.id);
  }, 20_000);

  it("reports the selected backend to sessions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pika-serve-backend-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const running = await startServe({
      port: 0,
      host: "127.0.0.1",
      dir,
      sandboxBackend: "none",
      help: false,
    });
    cleanups.push(() => running.close());
    const sessionClient = new PikaClient({
      transport: createWebSocketClientTransport(running.url),
    });
    cleanups.push(() => sessionClient.close());
    await sessionClient.initialize();
    const started = await sessionClient.startSession({ cwd: dir });

    expect(started.sandbox.backend).toBe("none");
  }, 20_000);

  it("rejects an unavailable explicit backend before listening", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pika-serve-backend-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await expect(
      startServe({
        port: 0,
        host: "127.0.0.1",
        dir,
        sandboxBackend: "bwrap",
        sandboxDeps: { bwrapExecutor: () => undefined },
        help: false,
      }),
    ).rejects.toThrow(/bwrap.*unavailable/);
  });
});

describe("serve entry", () => {
  it("prints the ephemeral URL and exits when the parent closes stdin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pika-serve-"));
    const proc = Bun.spawn({
      cmd: [process.execPath, entry, "--port", "0", "--dir", dir, "--exit-on-parent-stdin-close"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        PIKA_PROVIDER: "echo",
        PIKA_SANDBOX_BACKEND: "none",
      },
    });
    cleanups.push(async () => {
      proc.kill();
      await proc.exited;
      await rm(dir, { recursive: true, force: true });
    });

    const line = await withTimeout(readFirstLine(proc.stdout), 10_000, "ready line");
    expect(line).toContain("pika-server listening on ws://127.0.0.1:");
    const url = line.slice(line.indexOf("ws://")).trim();

    expect(await canConnect(url)).toBe(true);

    proc.stdin.end();
    const code = await withTimeout(proc.exited, 5_000, "server exit");
    expect(code).toBe(0);
    expect(await canConnect(url, 500)).toBe(false);
  }, 20_000);
});

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) throw new Error(`stream ended before a line: ${buffer}`);
      buffer += decoder.decode(result.value, { stream: true });
      const newline = buffer.indexOf("\n");
      if (newline !== -1) return buffer.slice(0, newline);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be cancelled by process exit.
    }
  }
}

function canConnect(url: string, timeoutMs = 4_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(false);
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`timed out waiting for ${label}`);
    }),
  ]);
}
