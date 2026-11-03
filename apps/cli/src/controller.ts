import type { SelectItem } from "@mariozechner/pi-tui";
import type { EventSubscription, PikaClient } from "@pika-harness/client";
import type {
  AgentEvent,
  EffectiveSandbox,
  LlmEndpoint,
  ModelPreset,
  SandboxMode,
  SessionMeta,
  SessionSummary,
  Usage,
} from "@pika-harness/schema";
import type { CatalogState } from "./catalog.js";
import {
  catalogPresets,
  describeCatalog,
  endpointForModel,
  loadCatalog,
  presetSource,
  resolvePreset,
  saveUserPreset,
} from "./catalog.js";
import type {
  CommandContext,
  ConnectOptions,
  HandoffOptions,
  SandboxOptions,
} from "./commands/types.js";
import type { Credentials } from "./credentials.js";
import { loadCredentials, saveCredential } from "./credentials.js";

export interface ControllerUi {
  append(text: string): void;
  setStatus(text: string): void;
  select(title: string, items: SelectItem[]): Promise<string | undefined>;
  promptText(title: string): Promise<string | undefined>;
  promptSecret(title: string): Promise<string | undefined>;
  resetTranscript(): void;
}

export interface InitialSession {
  session: SessionSummary;
  sandbox: EffectiveSandbox;
  alias?: string;
}

export interface SessionControllerOptions {
  client: PikaClient;
  ui: ControllerUi;
  catalog: CatalogState;
  cwd: string;
  env?: Record<string, string | undefined>;
  initial: InitialSession;
  onQuit(): void;
}

interface ContextProjection {
  messageCount: number;
  estimatedTokens: number;
}

type CompactionReason = "threshold" | "overflow" | "manual";

/** Owns the active session, its subscription, and the slash-command state. */
export class SessionController implements CommandContext {
  readonly #client: PikaClient;
  readonly #ui: ControllerUi;
  #catalog: CatalogState;
  readonly #cwd: string;
  readonly #env: Record<string, string | undefined>;
  readonly #onQuit: () => void;
  #session: SessionSummary;
  #sandbox: EffectiveSandbox;
  #alias: string | undefined;
  #subscription: EventSubscription | undefined;
  #busy = false;
  #pendingApprovalId: string | undefined;
  #projection: ContextProjection | undefined;
  #usage: Usage | undefined;
  #sessionIds: string[];
  #generation = 0;
  #compactionReason: CompactionReason | undefined;

  constructor(options: SessionControllerOptions) {
    this.#client = options.client;
    this.#ui = options.ui;
    this.#catalog = options.catalog;
    this.#cwd = options.cwd;
    this.#env = options.env ?? {};
    this.#onQuit = options.onQuit;
    this.#session = options.initial.session;
    this.#sandbox = options.initial.sandbox;
    this.#alias = options.initial.alias;
    this.#usage = options.initial.session.usage;
    this.#sessionIds = [options.initial.session.id];
  }

  get catalog(): CatalogState {
    return this.#catalog;
  }

  get env(): Record<string, string | undefined> {
    return this.#env;
  }

  get cwd(): string {
    return this.#cwd;
  }

  get sessionId(): string {
    return this.#session.id;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get sandbox(): EffectiveSandbox {
    return this.#sandbox;
  }

  async start(): Promise<void> {
    await this.#subscribe();
    this.#ui.append(`session ${this.#session.id} (${this.#session.model}, ${this.#session.cwd})\n`);
    if (catalogPresets(this.#catalog).length === 0) {
      this.#ui.append(
        "No LLM endpoint is configured. Run /connect to add one, or set PIKA_LLM_* variables.\n",
      );
    }
    this.#updateStatus();
  }

  async dispose(): Promise<void> {
    this.#generation += 1;
    const subscription = this.#subscription;
    this.#subscription = undefined;
    if (subscription !== undefined) {
      try {
        await subscription.unsubscribe();
      } catch {
        // The transport may already be closed during shutdown.
      }
    }
  }

  print(text: string): void {
    this.#ui.append(text);
  }

  quit(): void {
    this.#onQuit();
  }

  select(title: string, items: SelectItem[]): Promise<string | undefined> {
    return this.#ui.select(title, items);
  }

  promptText(title: string): Promise<string | undefined> {
    return this.#ui.promptText(title);
  }

  promptSecret(title: string): Promise<string | undefined> {
    return this.#ui.promptSecret(title);
  }

  sessionIds(): string[] {
    return [...this.#sessionIds];
  }

  async prompt(text: string): Promise<void> {
    this.#busy = true;
    this.#updateStatus();
    try {
      await this.#client.prompt(this.#session.id, text);
    } catch (error) {
      this.#busy = false;
      this.#updateStatus();
      throw error;
    }
  }

  async respondApproval(decision: "approve" | "approve_for_session" | "deny"): Promise<void> {
    const approvalId = this.#pendingApprovalId;
    if (approvalId === undefined) {
      this.print("No pending approval.\n");
      return;
    }
    this.print(`[approval] submitting ${decision}\n`);
    await this.#client.respondToApproval(this.#session.id, approvalId, decision);
  }

  showModels(): void {
    const presets = catalogPresets(this.#catalog);
    if (presets.length === 0) {
      this.print(
        `No model catalog configured. Active model: ${this.#session.model}. ` +
          "Run /connect, create .pika/models.json, or set PIKA_LLM_* variables.\n",
      );
      return;
    }
    const active = this.#activeAlias();
    const lines = presets.map((preset) => {
      const selected = preset.name === active;
      const source = presetSource(this.#catalog, preset.name);
      const hint = preset.apiKeyEnv === undefined ? "" : ` key=${preset.apiKeyEnv}`;
      const tools = preset.tools === false ? " tools=off" : "";
      return `${selected ? "*" : " "} ${preset.name} - ${preset.model} [${source}]${hint}${tools}`;
    });
    this.print(`${lines.join("\n")}\n`);
  }

  showConfig(): void {
    this.print(`${describeCatalog(this.#catalog, this.#env).join("\n")}\n`);
  }

  showStatus(): void {
    const alias = this.#activeAlias();
    const lines = [
      `session: ${this.#session.id}`,
      `model: ${this.#session.model}${alias === undefined ? "" : ` (${alias})`}`,
      `sandbox: ${this.#sandbox.mode}/${this.#sandbox.network}`,
      `cwd: ${this.#session.cwd}`,
      `state: ${this.#busy ? "running" : "settled"}`,
    ];
    if (this.#projection !== undefined) {
      lines.push(
        `context: ${this.#projection.messageCount} messages, ~${this.#projection.estimatedTokens} tokens`,
      );
    }
    this.print(`${lines.join("\n")}\n`);
  }

  async showUsage(): Promise<void> {
    const summary = await this.#currentSummary();
    const usage = summary?.usage ?? this.#usage;
    if (usage === undefined) {
      this.print("No usage recorded for this session.\n");
      return;
    }
    const parts = [`input ${usage.inputTokens}`, `output ${usage.outputTokens}`];
    if (usage.cacheReadTokens !== undefined) parts.push(`cache read ${usage.cacheReadTokens}`);
    if (usage.cacheWriteTokens !== undefined) parts.push(`cache write ${usage.cacheWriteTokens}`);
    const total = usage.inputTokens + usage.outputTokens;
    this.print(`usage: ${parts.join(", ")}, total ${total} tokens\n`);
  }

  showContext(): void {
    if (this.#projection === undefined) {
      this.print("No context projection yet.\n");
      return;
    }
    this.print(
      `context: ${this.#projection.messageCount} messages, ~${this.#projection.estimatedTokens} tokens\n`,
    );
  }

  async startNewSession(): Promise<void> {
    this.#requireSettled();
    const resolved = this.#alias === undefined ? undefined : this.#resolve(this.#alias);
    const result = await this.#client.startSession({
      cwd: this.#session.cwd,
      model: resolved?.preset.model ?? this.#session.model,
      ...(resolved === undefined ? {} : { llm: resolved.endpoint }),
      sandbox: { mode: this.#sandbox.mode, network: this.#sandbox.network },
    });
    await this.#adopt(result.session, result.sandbox, resolved?.alias);
    this.print(`[session] started ${result.session.id}\n`);
  }

  async showSessions(): Promise<void> {
    const sessions = await this.#client.listSessions();
    this.#sessionIds = sessions.map((session) => session.id);
    const lines = sessions.map((session) => {
      const marker = session.id === this.#session.id ? "*" : " ";
      const title = session.title === undefined ? "" : ` ${session.title}`;
      return `${marker} ${session.id} ${session.status} ${session.model}${title}`;
    });
    this.print(`${lines.join("\n")}\n`);
  }

  async resumeSession(sessionId?: string): Promise<void> {
    this.#requireSettled();
    const sessions = await this.#client.listSessions();
    this.#sessionIds = sessions.map((session) => session.id);
    const id = sessionId ?? (await this.#chooseSession(sessions));
    if (id === undefined) return;
    const summary = sessions.find((session) => session.id === id);
    const llm = summary === undefined ? undefined : this.#llmForModel(summary.model);
    const result = await this.#client.resumeSession(id, llm);
    await this.#adopt(result.session, result.sandbox, this.#aliasForModel(result.session.model));
    this.print(`[session] resumed ${result.session.id}\n`);
  }

  async forkSession(entryId?: string): Promise<void> {
    this.#requireSettled();
    const head = entryId ?? (await this.#headEntryId());
    const result = await this.#client.forkSession(this.#session.id, head);
    await this.#adopt(await this.#summaryFor(result.session), this.#sandbox, this.#alias);
    this.print(`[session] forked to ${result.session.id} at ${head}\n`);
  }

  async switchModel(alias?: string): Promise<void> {
    this.#requireSettled();
    const selected = alias ?? (await this.#chooseAlias());
    if (selected === undefined) return;
    const resolved = this.#resolve(selected);
    const head = await this.#headEntryId();
    const result = await this.#client.forkSession(this.#session.id, head, {
      model: resolved.preset.model,
      llm: resolved.endpoint,
    });
    await this.#adopt(await this.#summaryFor(result.session), this.#sandbox, resolved.alias);
    this.print(`[session] switched to ${result.session.id} using ${resolved.alias}\n`);
  }

  async handoff(options: HandoffOptions): Promise<void> {
    this.#requireSettled();
    const resolved = this.#resolve(options.alias);
    const head = await this.#headEntryId();
    const result = await this.#client.forkSession(this.#session.id, head, {
      model: resolved.preset.model,
      llm: resolved.endpoint,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    await this.#adopt(await this.#summaryFor(result.session), this.#sandbox, resolved.alias);
    if (options.mode !== undefined || options.network !== undefined) {
      await this.setSandbox({
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.network === undefined ? {} : { network: options.network }),
      });
    }
    this.print(
      `[session] handed off to ${result.session.id} (${resolved.alias}, ${result.session.cwd})\n`,
    );
  }

  async connect(options: ConnectOptions): Promise<void> {
    this.#requireSettled();
    const preset: ModelPreset = {
      name: options.alias,
      model: options.model,
      baseUrl: options.baseUrl,
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.tools ? {} : { tools: false }),
    };
    if (options.apiKey !== undefined) {
      await saveCredential(this.#env, options.alias, options.apiKey);
    }
    await saveUserPreset(this.#env, preset);

    let credentials: Credentials = this.#catalog.credentials ?? {};
    try {
      credentials = await loadCredentials(this.#env);
    } catch (error) {
      this.print(`[credentials] ${errorMessage(error)}\n`);
    }
    this.#catalog = await loadCatalog({
      cwd: this.#cwd,
      env: this.#env,
      credentials,
      ...(this.#catalog.envEndpoint === undefined ? {} : { llm: this.#catalog.envEndpoint }),
    });
    for (const warning of this.#catalog.warnings) this.print(`[catalog] ${warning}\n`);

    const endpoint: LlmEndpoint = {
      baseUrl: options.baseUrl,
      model: options.model,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.tools ? {} : { tools: false }),
    };
    const result = await this.#client.startSession({
      cwd: this.#session.cwd,
      model: options.model,
      llm: endpoint,
      sandbox: { mode: this.#sandbox.mode, network: this.#sandbox.network },
    });
    await this.#adopt(result.session, result.sandbox, options.alias);
    this.print(`[connect] saved ${options.alias}; session ${result.session.id}\n`);

    const check = await this.#ui.select("Check the endpoint now?", [
      { value: "yes", label: "Run /btw ping" },
      { value: "no", label: "Skip" },
    ]);
    if (check !== "yes") return;
    try {
      const side = await this.#client.askSideQuestion(result.session.id, "ping");
      this.print(`[connect] check ok: ${side.text}\n`);
    } catch (error) {
      this.print(`[connect] check failed: ${errorMessage(error)}\n`);
    }
  }

  async setSandbox(options: SandboxOptions): Promise<void> {
    const mode = options.mode ?? (await this.#chooseSandboxMode());
    if (mode === undefined) return;
    const network = options.network ?? this.#sandbox.network;
    const effective = await this.#client.setSandboxMode(this.#session.id, mode, network);
    this.#sandbox = effective;
    this.#updateStatus();
    this.print(`[sandbox] ${effective.mode}/${effective.network}\n`);
  }

  async compact(): Promise<void> {
    this.#requireSettled();
    this.#busy = true;
    this.#updateStatus();
    try {
      const result = await this.#client.compactSession(this.#session.id);
      if (result.compacted) {
        this.print(`[compact] ${result.tokensBefore} -> ${result.tokensAfter} tokens\n`);
      } else {
        this.print("[compact] nothing to compact\n");
      }
    } finally {
      this.#busy = false;
      this.#updateStatus();
    }
  }

  async askSideQuestion(question: string): Promise<void> {
    this.#requireSettled();
    this.#busy = true;
    this.#updateStatus();
    try {
      const result = await this.#client.askSideQuestion(this.#session.id, question);
      this.print(`\n[btw] ${result.text}\n`);
    } finally {
      this.#busy = false;
      this.#updateStatus();
    }
  }

  #handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.#busy = true;
        this.#updateStatus();
        break;
      case "message_delta":
        if (event.delta.kind === "text") this.print(event.delta.text);
        break;
      case "message_end":
        this.print("\n\n");
        break;
      case "tool_execution_start":
        this.print(`\n[tool] ${event.name}\n`);
        break;
      case "tool_execution_end":
        if (event.result.isError) this.print(`[tool error] ${toolResultText(event)}\n`);
        break;
      case "approval_requested":
        this.#pendingApprovalId = event.approval.id;
        this.print(
          `\n[approval required] ${event.approval.toolName}: ${event.approval.reason}\nType /approve or /deny.\n`,
        );
        break;
      case "approval_resolved":
        this.#pendingApprovalId = undefined;
        this.print(`[approval] ${event.resolution.decision}\n`);
        break;
      case "error":
        this.print(`\n[error] ${event.error.message}\n`);
        break;
      case "turn_end":
        this.print(`[turn ${event.stopReason}]\n`);
        break;
      case "context_projected":
        this.#projection = {
          messageCount: event.messageCount,
          estimatedTokens: event.estimatedTokens,
        };
        this.#updateStatus();
        break;
      case "sandbox_policy":
        this.#sandbox = { ...this.#sandbox, mode: event.mode, network: event.network };
        this.#updateStatus();
        break;
      case "compaction_start":
        this.#compactionReason = event.reason;
        if (event.reason !== "manual") this.print(`\n[compact] ${event.reason}\n`);
        break;
      case "compaction_end":
        if (this.#compactionReason !== "manual") {
          this.print(`[compact] ${event.tokensBefore} -> ${event.tokensAfter} tokens\n`);
        }
        this.#compactionReason = undefined;
        break;
      case "settled":
        this.#busy = false;
        this.#updateStatus();
        break;
      default:
        break;
    }
  }

  async #subscribe(): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const previous = this.#subscription;
    this.#subscription = undefined;
    if (previous !== undefined) {
      try {
        await previous.unsubscribe();
      } catch {
        // Ignore a subscription that the server already dropped.
      }
    }
    const subscription = await this.#client.subscribe(this.#session.id);
    this.#subscription = subscription;
    subscription.onEvent((event) => {
      if (generation === this.#generation) this.#handleEvent(event);
    });
  }

  async #adopt(
    session: SessionSummary,
    sandbox: EffectiveSandbox,
    alias: string | undefined,
  ): Promise<void> {
    this.#session = session;
    this.#sandbox = sandbox;
    this.#alias = alias;
    this.#usage = session.usage;
    this.#projection = undefined;
    this.#pendingApprovalId = undefined;
    this.#busy = false;
    this.#sessionIds = [session.id];
    this.#ui.resetTranscript();
    await this.#subscribe();
    this.print(`session ${session.id} (${session.model}, ${session.cwd})\n`);
    this.#updateStatus();
  }

  async #currentSummary(): Promise<SessionSummary | undefined> {
    const sessions = await this.#client.listSessions();
    this.#sessionIds = sessions.map((session) => session.id);
    return sessions.find((session) => session.id === this.#session.id);
  }

  async #summaryFor(meta: SessionMeta): Promise<SessionSummary> {
    const sessions = await this.#client.listSessions();
    this.#sessionIds = sessions.map((session) => session.id);
    const found = sessions.find((session) => session.id === meta.id);
    if (found !== undefined) return found;
    return {
      id: meta.id,
      cwd: meta.cwd,
      model: meta.model,
      status: "settled",
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt ?? meta.createdAt,
      lastEntryId: null,
      ...(meta.title === undefined ? {} : { title: meta.title }),
    };
  }

  async #headEntryId(): Promise<string> {
    const summary = await this.#currentSummary();
    if (summary?.lastEntryId === null || summary?.lastEntryId === undefined) {
      throw new Error("the session has no entries to fork");
    }
    return summary.lastEntryId;
  }

  async #chooseAlias(): Promise<string | undefined> {
    const presets = catalogPresets(this.#catalog);
    if (presets.length === 0) {
      throw new Error(
        "no model presets configured; create .pika/models.json or set PIKA_LLM_* variables",
      );
    }
    return this.#ui.select(
      "Select a model preset",
      presets.map((preset) => ({
        value: preset.name,
        label: preset.name,
        description: preset.model,
      })),
    );
  }

  async #chooseSession(sessions: SessionSummary[]): Promise<string | undefined> {
    if (sessions.length === 0) {
      this.print("No sessions available.\n");
      return undefined;
    }
    return this.#ui.select(
      "Resume a session",
      sessions.map((session) => ({
        value: session.id,
        label: session.id,
        description: `${session.model} ${session.status}`,
      })),
    );
  }

  async #chooseSandboxMode(): Promise<SandboxMode | undefined> {
    const modes: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
    return (await this.#ui.select(
      "Select a sandbox mode",
      modes.map((mode) => ({ value: mode, label: mode })),
    )) as SandboxMode | undefined;
  }

  #resolve(alias: string): ReturnType<typeof resolvePreset> {
    return resolvePreset(this.#catalog, alias, this.#env);
  }

  #llmForModel(model: string): LlmEndpoint | undefined {
    return endpointForModel(this.#catalog, model, this.#env);
  }

  #aliasForModel(model: string): string | undefined {
    return catalogPresets(this.#catalog).find((preset) => preset.model === model)?.name;
  }

  #activeAlias(): string | undefined {
    return this.#alias ?? this.#aliasForModel(this.#session.model);
  }

  #requireSettled(): void {
    if (this.#busy) {
      throw new Error("session is not settled; wait for the current turn to finish");
    }
  }

  #updateStatus(): void {
    const alias = this.#activeAlias();
    const model = alias === undefined ? this.#session.model : `${this.#session.model} (${alias})`;
    const state = this.#busy ? "running" : "settled";
    this.#ui.setStatus(
      `${state} | ${model} | ${this.#sandbox.mode}/${this.#sandbox.network} | ${this.#session.id} | ${this.#session.cwd}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolResultText(event: Extract<AgentEvent, { type: "tool_execution_end" }>): string {
  const error = event.result.content.find((part) => part.type === "error");
  return error === undefined ? "unknown tool failure" : error.message;
}
