import { describe, expect, it } from "bun:test";
import type { SelectItem } from "@mariozechner/pi-tui";
import type { ModelPreset } from "@pika-harness/schema";
import type { CatalogState } from "../src/catalog.js";
import {
  createCommands,
  dispatchCommand,
  formatHelp,
  slashCommands,
} from "../src/commands/index.js";
import { parseCommand, tokenize } from "../src/commands/tokenizer.js";
import type {
  CommandContext,
  ConnectOptions,
  HandoffOptions,
  SandboxOptions,
} from "../src/commands/types.js";

function preset(name: string): ModelPreset {
  return { name, model: `${name}-model`, baseUrl: `http://127.0.0.1/${name}/v1` };
}

const catalog: CatalogState = {
  presets: [preset("alpha"), preset("beta")],
  sources: { alpha: "project", beta: "project" },
  warnings: [],
  defaultAlias: "alpha",
};

class FakeContext implements CommandContext {
  readonly catalog = catalog;
  readonly env = {};
  readonly cwd = "/workspace";
  readonly output: string[] = [];
  readonly calls: string[] = [];
  readonly selections: Array<string | undefined> = [];
  readonly prompts: Array<string | undefined> = [];
  readonly connectOptions: ConnectOptions[] = [];
  quitCalled = false;
  busy = false;

  print(text: string): void {
    this.output.push(text);
  }

  quit(): void {
    this.quitCalled = true;
  }

  select(_title: string, _items: SelectItem[]): Promise<string | undefined> {
    return Promise.resolve(this.selections.shift());
  }

  promptText(_title: string): Promise<string | undefined> {
    return Promise.resolve(this.prompts.shift());
  }

  promptSecret(_title: string): Promise<string | undefined> {
    return Promise.resolve(this.prompts.shift());
  }

  async connect(options: ConnectOptions): Promise<void> {
    this.connectOptions.push(options);
    this.calls.push("connect");
  }

  showModels(): void {
    this.calls.push("models");
  }

  showConfig(): void {
    this.calls.push("config");
  }

  showStatus(): void {
    this.calls.push("status");
  }

  async showUsage(): Promise<void> {
    this.calls.push("usage");
  }

  showContext(): void {
    this.calls.push("context");
  }

  async startNewSession(): Promise<void> {
    this.calls.push("new");
  }

  async showSessions(): Promise<void> {
    this.calls.push("sessions");
  }

  async resumeSession(sessionId?: string): Promise<void> {
    this.calls.push(`resume:${sessionId ?? "select"}`);
  }

  async forkSession(entryId?: string): Promise<void> {
    this.calls.push(`fork:${entryId ?? "head"}`);
  }

  async switchModel(alias?: string): Promise<void> {
    this.calls.push(`model:${alias ?? "select"}`);
  }

  async handoff(options: HandoffOptions): Promise<void> {
    this.calls.push(`handoff:${options.alias}:${options.cwd ?? ""}:${options.mode ?? ""}`);
  }

  async setSandbox(options: SandboxOptions): Promise<void> {
    this.calls.push(`sandbox:${options.mode ?? "select"}:${options.network ?? ""}`);
  }

  async compact(): Promise<void> {
    this.calls.push("compact");
  }

  async askSideQuestion(question: string): Promise<void> {
    this.calls.push(`btw:${question}`);
  }

  async respondApproval(decision: "approve" | "approve_for_session" | "deny"): Promise<void> {
    this.calls.push(`approval:${decision}`);
  }

  sessionIds(): string[] {
    return ["session_1", "session_2"];
  }

  text(): string {
    return this.output.join("");
  }
}

describe("slash command tokenizer", () => {
  it("splits plain and quoted arguments", () => {
    expect(tokenize("/btw explain the diff")).toEqual(["/btw", "explain", "the", "diff"]);
    expect(tokenize('/handoff alpha --cwd "work trees/one"')).toEqual([
      "/handoff",
      "alpha",
      "--cwd",
      "work trees/one",
    ]);
    expect(tokenize('/btw ""')).toEqual(["/btw", ""]);
    expect(tokenize('a "b \\"quoted\\"" c')).toEqual(["a", 'b "quoted"', "c"]);
    expect(tokenize("C:\\\\work\\\\\\\\dir")).toEqual(["C:\\\\work\\\\\\\\dir"]);
  });

  it("rejects unterminated quotes and empty commands", () => {
    expect(() => tokenize('/btw "unfinished')).toThrow(/unterminated quote/);
    expect(() => parseCommand("/")).toThrow(/empty command/);
  });

  it("returns undefined for plain prompts", () => {
    expect(parseCommand("hello /models")).toBeUndefined();
    expect(parseCommand("/models")).toEqual({ name: "models", args: [] });
  });
});

describe("command registry", () => {
  it("dispatches every read-only command", async () => {
    const context = new FakeContext();
    const commands = createCommands(context);
    for (const input of ["/models", "/config", "/status", "/usage", "/context", "/help"]) {
      expect(await dispatchCommand(commands, input, context)).toBe(true);
    }
    expect(context.calls).toEqual(["models", "config", "status", "usage", "context"]);
    expect(context.text()).toContain("/handoff");
  });

  it("rejects unknown commands locally", async () => {
    const context = new FakeContext();
    const commands = createCommands(context);
    expect(await dispatchCommand(commands, "/nope", context)).toBe(true);
    expect(context.text()).toContain("Unknown command: /nope");
    expect(context.calls).toEqual([]);
  });

  it("passes prompt text through untouched", async () => {
    const context = new FakeContext();
    expect(await dispatchCommand(createCommands(context), "say /hello", context)).toBe(false);
  });

  it("parses handoff and sandbox options", async () => {
    const context = new FakeContext();
    const commands = createCommands(context);
    await dispatchCommand(
      commands,
      '/handoff beta --cwd "work trees/one" --sandbox read-only --network none',
      context,
    );
    await dispatchCommand(commands, "/sandbox workspace-write --network proxy", context);
    expect(context.calls).toEqual([
      "handoff:beta:work trees/one:read-only",
      "sandbox:workspace-write:proxy",
    ]);
  });

  it("reports malformed command arguments", async () => {
    const context = new FakeContext();
    const commands = createCommands(context);
    await dispatchCommand(commands, "/handoff", context);
    await dispatchCommand(commands, "/handoff beta --sandbox nowhere", context);
    await dispatchCommand(commands, "/btw", context);
    const text = context.text();
    expect(text).toContain("usage: /handoff");
    expect(text).toContain("invalid sandbox mode: nowhere");
    expect(text).toContain("usage: /btw <question>");
    expect(context.calls).toEqual([]);
  });

  it("routes approvals, quit, and picks", async () => {
    const context = new FakeContext();
    const commands = createCommands(context);
    await dispatchCommand(commands, "/approve", context);
    await dispatchCommand(commands, "/deny", context);
    await dispatchCommand(commands, "/model", context);
    await dispatchCommand(commands, "/fork", context);
    await dispatchCommand(commands, "/quit", context);
    expect(context.calls).toEqual([
      "approval:approve_for_session",
      "approval:deny",
      "model:select",
      "fork:head",
    ]);
    expect(context.quitCalled).toBe(true);
  });

  it("collects a connect preset and rejects incomplete endpoints", async () => {
    const context = new FakeContext();
    const commands = createCommands(context);
    context.selections.push("openai-compatible", "disabled");
    context.prompts.push("http://127.0.0.1:59000/v1", "jiuwei-tcm", "", "smoke-key", "32768", "");
    await dispatchCommand(commands, "/connect", context);
    expect(context.connectOptions).toEqual([
      {
        provider: "openai-compatible",
        alias: "jiuwei-tcm",
        baseUrl: "http://127.0.0.1:59000/v1",
        model: "jiuwei-tcm",
        apiKey: "smoke-key",
        contextWindow: 32768,
        tools: false,
      },
    ]);

    const missingBase = new FakeContext();
    missingBase.selections.push("openai-compatible");
    missingBase.prompts.push("");
    await dispatchCommand(createCommands(missingBase), "/connect", missingBase);
    expect(missingBase.text()).toContain("missing base URL");
    expect(missingBase.connectOptions).toEqual([]);

    const missingModel = new FakeContext();
    missingModel.selections.push("openai-compatible");
    missingModel.prompts.push("http://127.0.0.1:59000/v1", "");
    await dispatchCommand(createCommands(missingModel), "/connect", missingModel);
    expect(missingModel.text()).toContain("missing model id");
    expect(missingModel.connectOptions).toEqual([]);
  });

  it("rejects /connect while a turn is running", async () => {
    const context = new FakeContext();
    context.busy = true;
    await dispatchCommand(createCommands(context), "/connect", context);
    expect(context.text()).toContain("not settled");
    expect(context.connectOptions).toEqual([]);
  });

  it("exposes completion metadata", async () => {
    const context = new FakeContext();
    const commands = createCommands(context);
    const definitions = slashCommands(commands);
    const model = definitions.find((command) => command.name === "model");
    expect(model?.argumentHint).toBe("<alias>");
    expect(await model?.getArgumentCompletions?.("be")).toEqual([
      { value: "beta", label: "beta", description: "beta-model" },
    ]);
    const resume = definitions.find((command) => command.name === "resume");
    expect(await resume?.getArgumentCompletions?.("session_2")).toEqual([
      { value: "session_2", label: "session_2" },
    ]);
    expect(formatHelp(commands)).toContain("Fork the current session with another model preset");
  });
});
