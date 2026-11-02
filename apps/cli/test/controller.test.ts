import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import type { SelectItem } from "@mariozechner/pi-tui";
import { PikaClient } from "@pika-harness/client";
import type { LlmEvent, LlmMessage, LlmRequest, ModelInfo, Provider } from "@pika-harness/core";
import { FauxProvider } from "@pika-harness/core";
import type {
  EffectiveSandbox,
  LlmEndpoint,
  ModelPreset,
  SessionSummary,
} from "@pika-harness/schema";
import type { CompactionFactory } from "@pika-harness/server";
import { createInProcessTransportPair } from "@pika-harness/server";
import type { TestServer, TestServerOptions } from "../../../test/helpers.js";
import { createTestServer } from "../../../test/helpers.js";
import type { CatalogState } from "../src/catalog.js";
import type { ControllerUi } from "../src/controller.js";
import { SessionController } from "../src/controller.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeUi implements ControllerUi {
  log = "";
  status = "";
  readonly selections: Array<string | undefined> = [];

  append(text: string): void {
    this.log += text;
  }

  setStatus(text: string): void {
    this.status = text;
  }

  select(_title: string, _items: SelectItem[]): Promise<string | undefined> {
    return Promise.resolve(this.selections.shift());
  }

  resetTranscript(): void {
    this.log = "";
  }
}

function preset(name: string, overrides: Partial<ModelPreset> = {}): ModelPreset {
  return {
    name,
    model: `${name}-model`,
    baseUrl: `http://127.0.0.1/${name}/v1`,
    ...overrides,
  };
}

const catalog: CatalogState = {
  path: "/workspace/.pika/models.json",
  presets: [preset("alpha", { apiKeyEnv: "ALPHA_KEY" }), preset("beta")],
  defaultAlias: "alpha",
};

interface Harness {
  env: TestServer;
  client: PikaClient;
  controller: SessionController;
  ui: FakeUi;
  session: SessionSummary;
  sandbox: EffectiveSandbox;
  cleanup(): Promise<void>;
}

interface HarnessOptions extends TestServerOptions {
  catalog?: CatalogState;
  alias?: string;
  envVars?: Record<string, string | undefined>;
  llm?: LlmEndpoint;
  model?: string;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const env = await createTestServer(options);
  const [serverSide, clientSide] = createInProcessTransportPair();
  env.server.attach(serverSide);
  const client = new PikaClient({ transport: clientSide, clientName: "cli-controller-test" });
  await client.initialize();
  const started = await client.startSession({
    cwd: ".",
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.llm === undefined ? {} : { llm: options.llm }),
  });
  const ui = new FakeUi();
  const controller = new SessionController({
    client,
    ui,
    catalog: options.catalog ?? { presets: [] },
    cwd: env.cwd,
    env: options.envVars ?? {},
    initial: {
      session: started.session,
      sandbox: started.sandbox,
      ...(options.alias === undefined ? {} : { alias: options.alias }),
    },
    onQuit: () => undefined,
  });
  await controller.start();

  const cleanup = async (): Promise<void> => {
    await controller.dispose();
    client.close();
    await env.cleanup();
  };
  cleanups.push(cleanup);
  return {
    env,
    client,
    controller,
    ui,
    session: started.session,
    sandbox: started.sandbox,
    cleanup,
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function summarize(provider: Provider, messages: LlmMessage[]): Promise<string> {
  let text = "";
  for await (const event of provider.stream(
    { model: "faux-model", system: "", messages, tools: [] },
    new AbortController().signal,
  )) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "error") throw new Error(event.error.message);
    else if (event.type === "done") break;
  }
  return text;
}

describe("session controller", () => {
  it("renders models, config, status, usage, and context without leaking keys", async () => {
    const harness = await createHarness({
      catalog,
      alias: "alpha",
      envVars: { ALPHA_KEY: "super-secret" },
      model: "alpha-model",
    });

    harness.controller.showModels();
    expect(harness.ui.log).toContain("* alpha - alpha-model key=ALPHA_KEY");
    expect(harness.ui.log).toContain("  beta - beta-model");
    expect(harness.ui.log).not.toContain("super-secret");

    harness.ui.log = "";
    harness.controller.showConfig();
    expect(harness.ui.log).toContain("/workspace/.pika/models.json");
    expect(harness.ui.log).toContain("ALPHA_KEY set");
    expect(harness.ui.log).not.toContain("super-secret");

    harness.ui.log = "";
    harness.controller.showStatus();
    expect(harness.ui.log).toContain(`session: ${harness.session.id}`);
    expect(harness.ui.log).toContain("model: alpha-model (alpha)");
    expect(harness.ui.log).toContain("sandbox: workspace-write/none");
    expect(harness.ui.log).toContain(`cwd: ${harness.env.cwd}`);
    expect(harness.ui.log).toContain("state: settled");

    harness.ui.log = "";
    harness.controller.showContext();
    expect(harness.ui.log).toContain("No context projection yet.");

    await harness.controller.prompt("hello");
    await waitFor(() => !harness.controller.busy);

    harness.ui.log = "";
    harness.controller.showContext();
    expect(harness.ui.log).toContain("context: ");
    expect(harness.ui.log).toContain("messages");

    harness.ui.log = "";
    await harness.controller.showUsage();
    expect(harness.ui.log).toContain("usage: input 10, output 5");
    expect(harness.ui.log).toContain("total 15 tokens");
    expect(harness.ui.status).toContain("settled");
  });

  it("starts, resumes, and switches subscriptions without touching the source", async () => {
    const harness = await createHarness();
    const sourceId = harness.session.id;
    await harness.controller.prompt("hello");
    await waitFor(() => !harness.controller.busy);
    const sourceBefore = (await harness.client.listSessions()).find(
      (session) => session.id === sourceId,
    );
    if (sourceBefore === undefined) throw new Error("missing source session");

    await harness.controller.startNewSession();
    const newId = harness.controller.sessionId;
    expect(newId).not.toBe(sourceId);
    expect(harness.ui.log).toContain(`session ${newId}`);
    expect(harness.ui.status).toContain(newId);

    await harness.controller.prompt("second");
    await waitFor(() => !harness.controller.busy);
    const sessions = await harness.client.listSessions();
    const sourceAfter = sessions.find((session) => session.id === sourceId);
    const created = sessions.find((session) => session.id === newId);
    expect(created?.lastEntryId).not.toBeNull();
    expect(sourceAfter?.lastEntryId).toBe(sourceBefore.lastEntryId);

    await harness.controller.resumeSession(sourceId);
    expect(harness.controller.sessionId).toBe(sourceId);
    await harness.controller.prompt("third");
    await waitFor(() => !harness.controller.busy);
    const resumed = (await harness.client.listSessions()).find(
      (session) => session.id === sourceId,
    );
    expect(resumed?.lastEntryId).not.toBe(sourceBefore.lastEntryId ?? null);
  });

  it("forks when switching models and rejects unknown aliases", async () => {
    const harness = await createHarness({
      catalog,
      alias: "alpha",
      envVars: { ALPHA_KEY: "secret" },
      model: "alpha-model",
    });
    await harness.controller.prompt("hello");
    await waitFor(() => !harness.controller.busy);
    const sourceBefore = (await harness.client.listSessions()).find(
      (session) => session.id === harness.session.id,
    );

    await harness.controller.switchModel("beta");
    expect(harness.controller.sessionId).not.toBe(harness.session.id);
    expect(harness.ui.status).toContain("beta-model (beta)");

    const sessions = await harness.client.listSessions();
    expect(sessions.find((session) => session.id === harness.controller.sessionId)?.model).toBe(
      "beta-model",
    );
    expect(sessions.find((session) => session.id === harness.session.id)).toMatchObject({
      model: "alpha-model",
      lastEntryId: sourceBefore?.lastEntryId,
    });

    await expect(harness.controller.switchModel("missing")).rejects.toThrow(
      /unknown model preset: missing/,
    );
  });

  it("rejects session changes while a turn is running", async () => {
    const provider = new GatedProvider();
    const harness = await createHarness({ provider, catalog });
    await harness.controller.prompt("start");
    await provider.firstStepStarted.promise;
    expect(harness.controller.busy).toBe(true);

    await expect(harness.controller.switchModel("beta")).rejects.toThrow(/not settled/);
    await expect(harness.controller.compact()).rejects.toThrow(/not settled/);
    await expect(harness.controller.askSideQuestion("why?")).rejects.toThrow(/not settled/);

    provider.releaseFirstStep.resolve();
    await waitFor(() => !harness.controller.busy);
    await harness.controller.askSideQuestion("why?");
    expect(harness.ui.log).toContain("[btw] steered");
  });

  it("compacts manually and keeps side questions out of the session", async () => {
    const provider = new FauxProvider([longTurn, longTurn, summaryTurn, sideTurn]);
    const compaction: CompactionFactory = (_context, streamProvider) => ({
      contextWindow: 1_000_000,
      reserveTokens: 0,
      keepRecentTurns: 1,
      summarize: (messages) => summarize(streamProvider, messages),
    });
    const harness = await createHarness({ provider, compaction });

    await harness.controller.prompt("first");
    await waitFor(() => !harness.controller.busy);
    await harness.controller.prompt("second");
    await waitFor(() => !harness.controller.busy);

    harness.ui.log = "";
    await harness.controller.compact();
    expect(harness.ui.log).toMatch(/\[compact\] \d+ -> \d+ tokens/);
    expect(harness.controller.busy).toBe(false);

    const entriesBefore = await harness.env.store.entries(harness.session.id);
    harness.ui.log = "";
    await harness.controller.askSideQuestion("why?");
    expect(harness.ui.log).toContain("[btw] side answer");
    const entriesAfter = await harness.env.store.entries(harness.session.id);
    expect(entriesAfter).toEqual(entriesBefore);
  });

  it("hands off with a new preset, directory, and sandbox", async () => {
    const harness = await createHarness({
      catalog,
      alias: "alpha",
      envVars: { ALPHA_KEY: "secret" },
      model: "alpha-model",
      sandbox: { maxMode: "read-only", maxNetwork: "none" },
    });
    await harness.controller.prompt("hello");
    await waitFor(() => !harness.controller.busy);

    await harness.controller.handoff({
      alias: "beta",
      cwd: "worktrees/one",
      mode: "danger-full-access",
      network: "full",
    });

    const target = (await harness.client.listSessions()).find(
      (session) => session.id === harness.controller.sessionId,
    );
    expect(target).toMatchObject({
      model: "beta-model",
      cwd: path.join(harness.env.cwd, "worktrees", "one"),
    });
    expect(harness.controller.sandbox).toEqual({
      backend: "none",
      mode: "read-only",
      network: "none",
    });
    expect(harness.ui.status).toContain("beta-model (beta)");
    expect(harness.ui.status).toContain("read-only/none");

    await harness.controller.setSandbox({ mode: "read-only" });
    expect(harness.controller.sandbox.mode).toBe("read-only");
  });
});

class GatedProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  readonly firstStepStarted = deferred();
  readonly releaseFirstStep = deferred();
  #calls = 0;

  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.requests.push(request);
    this.#calls += 1;
    return this.#run(this.#calls, signal);
  }

  models(): ModelInfo[] {
    return [{ id: "gated-model", provider: "gated", contextWindow: 10_000 }];
  }

  async *#run(index: number, signal: AbortSignal): AsyncIterable<LlmEvent> {
    if (index === 1) {
      yield { type: "text_delta", text: "working" };
      this.firstStepStarted.resolve();
      await this.releaseFirstStep.promise;
      if (signal.aborted) return;
      yield { type: "done", stopReason: "end" };
      return;
    }
    yield { type: "text_delta", text: "steered" };
    yield { type: "done", stopReason: "end" };
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => {
      release?.();
    },
  };
}

const longTurn: LlmEvent[] = [
  { type: "text_delta", text: "x".repeat(400) },
  { type: "done", stopReason: "end" },
];

const summaryTurn: LlmEvent[] = [
  { type: "text_delta", text: "short summary" },
  { type: "done", stopReason: "end" },
];

const sideTurn: LlmEvent[] = [
  { type: "text_delta", text: "side answer" },
  { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
  { type: "done", stopReason: "end" },
];
