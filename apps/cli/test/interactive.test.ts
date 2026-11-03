import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Terminal } from "@mariozechner/pi-tui";
import { createWebSocketClientTransport, PikaClient } from "@pika-harness/client";
import type { LlmEvent } from "@pika-harness/core";
import { FauxProvider } from "@pika-harness/core";
import type { ModelPreset } from "@pika-harness/schema";
import { createInProcessTransportPair, startServe } from "@pika-harness/server";
import { createTestServer } from "../../../test/helpers.js";
import type { CatalogState } from "../src/catalog.js";
import { runInteractive } from "../src/cli.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeTerminal implements Terminal {
  readonly writes: string[] = [];
  readonly columns = 400;
  readonly rows = 50;
  readonly kittyProtocolActive = false;
  #onInput: ((data: string) => void) | undefined;

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.#onInput = onInput;
  }

  stop(): void {
    this.#onInput = undefined;
  }

  async drainInput(): Promise<void> {
    return Promise.resolve();
  }

  write(data: string): void {
    this.writes.push(data);
  }

  get output(): string {
    return this.writes.join("");
  }

  emit(data: string): void {
    this.#onInput?.(data);
  }

  async type(text: string): Promise<void> {
    this.emit(text);
    this.emit("\r");
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

const textTurn: LlmEvent[] = [
  { type: "text_delta", text: "hello from the model" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
  { type: "done", stopReason: "end" },
];

const sideTurn: LlmEvent[] = [
  { type: "text_delta", text: "side answer" },
  { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
  { type: "done", stopReason: "end" },
];

function preset(name: string): ModelPreset {
  return {
    name,
    model: `${name}-model`,
    baseUrl: `http://127.0.0.1/${name}/v1`,
  };
}

const catalog: CatalogState = {
  presets: [preset("alpha"), preset("beta")],
  sources: { alpha: "project", beta: "project" },
  warnings: [],
  defaultAlias: "alpha",
};

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("interactive cli", () => {
  it("points to /connect when no endpoint is configured", async () => {
    const env = await createTestServer({ provider: new FauxProvider([]) });
    const [serverSide, clientSide] = createInProcessTransportPair();
    env.server.attach(serverSide);
    const client = new PikaClient({ transport: clientSide, clientName: "interactive-test" });
    cleanups.push(async () => {
      client.close();
      await env.cleanup();
    });
    await client.initialize();
    const started = await client.startSession({ cwd: env.cwd });
    const terminal = new FakeTerminal();
    let exited = false;
    const running = runInteractive(
      {
        client,
        catalog: { presets: [], sources: {}, warnings: [] },
        cwd: env.cwd,
        session: started.session,
        sandbox: started.sandbox,
      },
      {
        terminal,
        onExit: () => {
          exited = true;
        },
      },
    );

    await waitFor(() => terminal.output.includes("Run /connect"));
    await terminal.type("/help");
    await waitFor(() => terminal.output.includes("/connect"));
    await terminal.type("/quit");
    await running;
    expect(exited).toBe(true);
  });

  it("collects /connect fields with a masked key and no plaintext in the transcript", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "pika-interactive-connect-"));
    cleanups.push(() => rm(configDir, { recursive: true, force: true }));
    const env = await createTestServer({ provider: new FauxProvider([]) });
    const [serverSide, clientSide] = createInProcessTransportPair();
    env.server.attach(serverSide);
    const client = new PikaClient({ transport: clientSide, clientName: "interactive-test" });
    cleanups.push(async () => {
      client.close();
      await env.cleanup();
    });
    await client.initialize();
    const started = await client.startSession({ cwd: env.cwd, model: "alpha-model" });

    const terminal = new FakeTerminal();
    const running = runInteractive(
      {
        client,
        catalog,
        cwd: env.cwd,
        session: started.session,
        sandbox: started.sandbox,
        alias: "alpha",
      },
      {
        terminal,
        env: { PIKA_CONFIG_DIR: configDir },
        onExit: () => undefined,
      },
    );

    await waitFor(() => terminal.output.includes("settled |"));
    await terminal.type("/connect");
    await waitFor(() => terminal.output.includes("Provider type"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Base URL"));
    await terminal.type("http://127.0.0.1:59000/v1");
    await waitFor(() => terminal.output.includes("Model id"));
    await terminal.type("jiuwei-tcm");
    await waitFor(() => terminal.output.includes("Alias"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("API key"));
    terminal.emit("\x1b[200~super-secret-key\x1b[201~");
    await waitFor(() => terminal.output.includes("********"));
    expect(terminal.output).not.toContain("super-secret");
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Context window"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Max output tokens"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Tool calling"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Check the endpoint now?"));
    terminal.emit("\u001b[B");
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("[connect] saved jiuwei-tcm"));
    expect(terminal.output).not.toContain("super-secret");

    await terminal.type("/quit");
    await running;
  });

  it("connects to a real endpoint with tools off and keeps the key out of storage", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "pika-connect-config-"));
    const sessionDir = await mkdtemp(path.join(tmpdir(), "pika-connect-sessions-"));
    cleanups.push(() => rm(configDir, { recursive: true, force: true }));
    cleanups.push(() => rm(sessionDir, { recursive: true, force: true }));

    const apiKey = "smoke-local-key";
    const recorded: { tools?: unknown[] | undefined; authorization?: string | null } = {};
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        recorded.authorization = request.headers.get("authorization");
        const body = (await request.json()) as { tools?: unknown[] };
        recorded.tools = body.tools;
        const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
          `data: ${JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 0,
            model: "jiuwei-tcm",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        const stream = [
          chunk({ role: "assistant", content: "pong from fake" }, null),
          chunk({}, "stop"),
          "data: [DONE]\n\n",
        ].join("");
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    cleanups.push(async () => fake.stop(true));

    const serve = await startServe({
      port: 0,
      host: "127.0.0.1",
      dir: sessionDir,
      sandboxBackend: "none",
      help: false,
    });
    const client = new PikaClient({
      transport: createWebSocketClientTransport(serve.url),
      clientName: "connect-e2e",
    });
    cleanups.push(async () => {
      client.close();
      await serve.close();
    });
    await client.initialize();
    const started = await client.startSession({ cwd: sessionDir });

    const terminal = new FakeTerminal();
    const running = runInteractive(
      {
        client,
        catalog: { presets: [], sources: {}, warnings: [] },
        cwd: sessionDir,
        session: started.session,
        sandbox: started.sandbox,
      },
      {
        terminal,
        env: { PIKA_CONFIG_DIR: configDir },
        onExit: () => undefined,
      },
    );

    await waitFor(() => terminal.output.includes("Run /connect"));
    await terminal.type("/connect");
    await waitFor(() => terminal.output.includes("Provider type"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Base URL"));
    await terminal.type(`http://127.0.0.1:${fake.port}/v1`);
    await waitFor(() => terminal.output.includes("Model id"));
    await terminal.type("jiuwei-tcm");
    await waitFor(() => terminal.output.includes("Alias"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("API key"));
    terminal.emit(apiKey);
    await waitFor(() => terminal.output.includes("********"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Context window"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Max output tokens"));
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Tool calling"));
    terminal.emit("\u001b[B");
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("Check the endpoint now?"));
    terminal.emit("\u001b[B");
    terminal.emit("\r");
    await waitFor(() => terminal.output.includes("[connect] saved jiuwei-tcm"));

    await terminal.type("hello");
    await waitFor(() => terminal.output.includes("pong from fake"));
    await waitFor(() => terminal.output.includes("[turn end]"));
    await waitFor(() => terminal.output.includes("settled |"));

    expect(recorded.authorization).toBe(`Bearer ${apiKey}`);
    expect(recorded.tools ?? []).toEqual([]);

    await terminal.type("/config");
    await waitFor(() => terminal.output.includes("credentials set"));
    expect(terminal.output).not.toContain(apiKey);

    await terminal.type("/quit");
    await running;

    const logs = (await readdir(sessionDir, { recursive: true }))
      .filter((entry) => entry.endsWith("log.jsonl"))
      .map((entry) => path.join(sessionDir, entry));
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) expect(await readFile(log, "utf8")).not.toContain(apiKey);
  }, 20_000);

  it("runs slash commands and turns through the tui", async () => {
    const env = await createTestServer({ provider: new FauxProvider([textTurn, sideTurn]) });
    const [serverSide, clientSide] = createInProcessTransportPair();
    env.server.attach(serverSide);
    const client = new PikaClient({ transport: clientSide, clientName: "interactive-test" });
    cleanups.push(async () => {
      client.close();
      await env.cleanup();
    });
    await client.initialize();
    const started = await client.startSession({ cwd: env.cwd, model: "alpha-model" });

    const terminal = new FakeTerminal();
    let exited = false;
    const running = runInteractive(
      {
        client,
        catalog,
        cwd: env.cwd,
        session: started.session,
        sandbox: started.sandbox,
        alias: "alpha",
      },
      {
        terminal,
        onExit: () => {
          exited = true;
        },
      },
    );

    await waitFor(() => terminal.output.includes("settled |"));
    expect(terminal.output).toContain("alpha-model (alpha)");

    await terminal.type("/models");
    await waitFor(() => terminal.output.includes("beta - beta-model"));

    await terminal.type("hello");
    await waitFor(() => terminal.output.includes("hello from the model"));
    await waitFor(() => terminal.output.includes("[turn end]"));
    await waitFor(() => terminal.output.includes("settled |"));

    await terminal.type("/model beta");
    await waitFor(() => terminal.output.includes("[session] switched to"));
    expect(terminal.output).toContain("beta-model (beta)");

    await terminal.type("/btw what changed");
    await waitFor(() => terminal.output.includes("[btw] side answer"));

    await terminal.type("/quit");
    await running;
    expect(exited).toBe(true);
  });
});
