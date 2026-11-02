import { afterEach, describe, expect, it } from "bun:test";
import type { Terminal } from "@mariozechner/pi-tui";
import { PikaClient } from "@pika-harness/client";
import type { LlmEvent } from "@pika-harness/core";
import { FauxProvider } from "@pika-harness/core";
import type { ModelPreset } from "@pika-harness/schema";
import { createInProcessTransportPair } from "@pika-harness/server";
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
