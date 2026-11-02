import { beforeEach, describe, expect, it } from "bun:test";
import { withToken } from "@pika-harness/client";
import type { LauncherDeps, ServerProcess, ServerSpawnSpec } from "../src/launcher.js";
import { runLauncher } from "../src/launcher.js";

const encoder = new TextEncoder();

class FakeServer implements ServerProcess {
  readonly signals: string[] = [];
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly #controllers: {
    out?: ReadableStreamDefaultController<Uint8Array>;
    err?: ReadableStreamDefaultController<Uint8Array>;
  } = {};
  #resolveExit: (code: number) => void = () => undefined;
  #closed = false;

  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controllers.out = controller;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controllers.err = controller;
      },
    });
    let resolveExit: (code: number) => void = () => undefined;
    this.exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    this.#resolveExit = resolveExit;
  }

  write(text: string): void {
    this.#controllers.out?.enqueue(encoder.encode(text));
  }

  writeErr(text: string): void {
    this.#controllers.err?.enqueue(encoder.encode(text));
  }

  finish(code = 0): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controllers.out?.close();
    this.#controllers.err?.close();
    this.#resolveExit(code);
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
    this.finish(0);
  }
}

let output: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  output = [];
  errors = [];
  process.exitCode = 0;
});

function makeDeps(overrides: Partial<LauncherDeps> = {}): LauncherDeps {
  return {
    spawnServer:
      overrides.spawnServer ??
      (() => {
        throw new Error("unexpected spawn");
      }),
    runClient: overrides.runClient ?? (async () => undefined),
    serveMain: overrides.serveMain ?? (async () => undefined),
    randomToken: overrides.randomToken ?? (() => "test-token"),
    env: overrides.env ?? {},
    cwd: overrides.cwd ?? "/tmp/pika-launcher-test",
    startupTimeoutMs: overrides.startupTimeoutMs ?? 200,
    shutdownGraceMs: overrides.shutdownGraceMs ?? 50,
    writeOut: overrides.writeOut ?? ((text) => output.push(text)),
    writeErr: overrides.writeErr ?? ((text) => errors.push(text)),
  };
}

describe("launcher mode dispatch", () => {
  it("prints unified help without spawning or running the client", async () => {
    let spawned = 0;
    let ran = false;
    const code = await runLauncher(
      ["--help"],
      makeDeps({
        spawnServer: () => {
          spawned += 1;
          throw new Error("unexpected spawn");
        },
        runClient: async () => {
          ran = true;
        },
      }),
    );
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(ran).toBe(false);
    expect(output.join("")).toContain("pika serve");
    expect(output.join("")).toContain("--url <ws://host:port>");
  });

  it("delegates serve mode and its flags to the server entry", async () => {
    let received: string[] = [];
    let spawned = 0;
    const code = await runLauncher(
      ["serve", "--port", "0"],
      makeDeps({
        spawnServer: () => {
          spawned += 1;
          throw new Error("unexpected spawn");
        },
        serveMain: async (argv) => {
          received = argv;
        },
      }),
    );
    expect(code).toBe(0);
    expect(received).toEqual(["--port", "0"]);
    expect(spawned).toBe(0);
  });

  it("connects to --url without starting a local server", async () => {
    let spawned = 0;
    let clientArgv: string[] = [];
    const argv = ["--url", "ws://127.0.0.1:7331", "--prompt", "hi"];
    const code = await runLauncher(
      argv,
      makeDeps({
        spawnServer: () => {
          spawned += 1;
          throw new Error("unexpected spawn");
        },
        runClient: async (received) => {
          clientArgv = received;
        },
      }),
    );
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(clientArgv).toEqual(argv);
  });

  it("connects to PIKA_SERVER_URL without starting a local server", async () => {
    let spawned = 0;
    const code = await runLauncher(
      ["--prompt", "hi"],
      makeDeps({
        env: { PIKA_SERVER_URL: "ws://remote:7331" },
        spawnServer: () => {
          spawned += 1;
          throw new Error("unexpected spawn");
        },
      }),
    );
    expect(code).toBe(0);
    expect(spawned).toBe(0);
  });

  it("rejects --url without a value", async () => {
    const code = await runLauncher(["--url"], makeDeps());
    expect(code).toBe(2);
    expect(errors.join("")).toContain("--url requires a WebSocket URL");
  });
});

describe("launcher local lifecycle", () => {
  it("starts one server, injects the token, and stops it after a one-shot run", async () => {
    const server = new FakeServer();
    const spawns: ServerSpawnSpec[] = [];
    let clientArgv: string[] = [];
    let onExitDefined = true;
    const intListeners = process.listenerCount("SIGINT");

    const code = await runLauncher(
      ["--prompt", "hi"],
      makeDeps({
        cwd: "/work/project",
        env: {
          PATH: "/bin",
          PIKA_PROVIDER: "echo",
          UNRELATED_SECRET: "do-not-forward",
        },
        spawnServer: (spec) => {
          spawns.push(spec);
          server.write("pika-server listening on ws://127.0.0.1:4321\n");
          return server;
        },
        runClient: async (argv, options) => {
          clientArgv = argv;
          onExitDefined = options?.onExit !== undefined;
        },
      }),
    );

    expect(code).toBe(0);
    expect(spawns).toHaveLength(1);
    const spec = spawns[0];
    expect(spec).toBeDefined();
    expect(spec?.command.slice(-3)).toEqual(["--port", "0", "--exit-on-parent-stdin-close"]);
    expect(spec?.command).toContain("serve");
    expect(spec?.cwd).toBe("/work/project");
    expect(spec?.env.PIKA_SERVER_TOKEN).toBe("test-token");
    expect(spec?.env.PIKA_PROVIDER).toBe("echo");
    expect(spec?.env.UNRELATED_SECRET).toBeUndefined();
    expect(spec?.command.join(" ")).not.toContain("test-token");

    expect(clientArgv).toEqual([
      "--url",
      withToken("ws://127.0.0.1:4321", "test-token"),
      "--prompt",
      "hi",
    ]);
    expect(onExitDefined).toBe(false);
    expect(server.signals).toEqual(["SIGTERM"]);
    expect(process.listenerCount("SIGINT")).toBe(intListeners);
    expect(errors).toEqual([]);
    expect(output.join("")).not.toContain("test-token");
  });

  it("lets the interactive client exit normally and then stops the server", async () => {
    const server = new FakeServer();
    let onExit: (() => void) | undefined;
    const code = await runLauncher(
      [],
      makeDeps({
        spawnServer: () => {
          server.write("pika-server listening on ws://127.0.0.1:4321\n");
          return server;
        },
        runClient: async (_argv, options) => {
          onExit = options?.onExit;
          onExit?.();
        },
      }),
    );
    expect(code).toBe(0);
    expect(onExit).toBeTypeOf("function");
    expect(server.signals).toEqual(["SIGTERM"]);
  });

  it("fails when the server exits before it is ready", async () => {
    const server = new FakeServer();
    const code = await runLauncher(
      ["--prompt", "hi"],
      makeDeps({
        spawnServer: () => {
          server.writeErr("boom: cannot bind\n");
          server.finish(1);
          return server;
        },
      }),
    );
    expect(code).toBe(1);
    expect(errors.join("")).toContain("local server exited before it was ready");
  });

  it("fails on unexpected output before readiness", async () => {
    const server = new FakeServer();
    const code = await runLauncher(
      ["--prompt", "hi"],
      makeDeps({
        spawnServer: () => {
          server.write("x".repeat(70_000));
          return server;
        },
      }),
    );
    expect(code).toBe(1);
    expect(errors.join("")).toContain("unexpected output");
  });

  it("fails when readiness times out", async () => {
    const server = new FakeServer();
    const code = await runLauncher(
      ["--prompt", "hi"],
      makeDeps({
        startupTimeoutMs: 30,
        spawnServer: () => server,
      }),
    );
    expect(code).toBe(1);
    expect(errors.join("")).toContain("did not become ready within 30ms");
    expect(server.signals).toContain("SIGTERM");
  });
});
