import path from "node:path";
import type {
  AgentRuntime,
  ApprovalMode,
  Clock,
  IdGenerator,
  PromptSection,
  Provider,
  ProviderTool,
  RuntimeHistoryEntry,
  SessionStore,
  ToolExecutor,
} from "@pika-harness/core";
import {
  createIdGenerator,
  createRuntime,
  loadResumeState,
  replaySession,
  resolveSandboxPolicy,
  systemClock,
} from "@pika-harness/core";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  EffectiveSandbox,
  JsonRpcId,
  JsonRpcMessage,
  NetworkPolicy,
  ProtocolMethod,
  ProtocolTransport,
  SandboxBackend,
  SandboxMode,
  SandboxPolicy,
  SessionMeta,
  SessionSummary,
} from "@pika-harness/schema";
import {
  isJsonRpcRequest,
  JsonRpcMessageSchema,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
  ProtocolMethodSchema,
  type SandboxSelection,
  SandboxSelectionSchema,
} from "@pika-harness/schema";
export interface SessionContext {
  sessionId: string;
  cwd: string;
  model: string;
}

export interface ServerSandboxOptions {
  backend: SandboxBackend;
  defaultMode?: SandboxMode;
  defaultNetwork?: NetworkPolicy;
  /** Requests wider than these ceilings are clamped and reported as effective. */
  maxMode?: SandboxMode;
  maxNetwork?: NetworkPolicy;
  approvalMode?: ApprovalMode;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SessionServerOptions {
  store: SessionStore;
  provider: Provider | ((context: SessionContext) => Provider);
  toolExecutor?: ToolExecutor | ((context: SessionContext) => ToolExecutor);
  tools?: ProviderTool[];
  systemPrompt?: string;
  promptSections?: PromptSection[];
  defaultModel?: string;
  defaultCwd?: string;
  sandbox: ServerSandboxOptions;
  approvalTimeoutMs?: number;
  clock?: Clock;
  ids?: IdGenerator;
}

export interface SessionServer {
  attach(transport: ProtocolTransport): () => void;
  handle(transport: ProtocolTransport, message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

/** Raised by a protocol handler; the server converts it into a JSON-RPC error. */
export class ProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.data = data;
  }
}

interface ManagedSession {
  meta: SessionMeta;
  runtime: AgentRuntime;
  policy: SandboxPolicy | undefined;
}

interface Subscription {
  id: string;
  sessionId: string;
  transport: ProtocolTransport;
}

interface PendingApproval {
  sessionId: string;
  /** Set once the runtime asks the server to wait for a decision. */
  resolve?(decision: ApprovalDecision): void;
  /** Set when a client answers between the announcement and the runtime wait. */
  decision?: ApprovalDecision;
  timer?: NodeJS.Timeout;
}

interface ApprovalResponseInput {
  sessionId: string;
  approvalId: string;
  decision: ApprovalDecision;
}

interface SandboxModeInput {
  sessionId: string;
  mode: SandboxMode;
  network?: NetworkPolicy;
}

const MODE_RANK: Record<SandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};
const NETWORK_RANK: Record<NetworkPolicy, number> = { none: 0, proxy: 1, full: 2 };

/** JSON-RPC session server: one runtime per session, shared across all transports. */
export class DefaultSessionServer implements SessionServer {
  readonly #store: SessionStore;
  readonly #provider: SessionServerOptions["provider"];
  readonly #toolExecutor: SessionServerOptions["toolExecutor"];
  readonly #tools: ProviderTool[];
  readonly #systemPrompt: string | undefined;
  readonly #promptSections: PromptSection[] | undefined;
  readonly #defaultModel: string | undefined;
  readonly #defaultCwd: string;
  readonly #sandbox: ServerSandboxOptions;
  readonly #approvalTimeoutMs: number;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #transportSubscriptions = new WeakMap<ProtocolTransport, Set<string>>();
  readonly #approvals = new Map<string, PendingApproval>();

  constructor(options: SessionServerOptions) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#toolExecutor = options.toolExecutor;
    this.#tools = [...(options.tools ?? [])];
    this.#systemPrompt = options.systemPrompt;
    this.#promptSections = options.promptSections;
    this.#defaultModel = options.defaultModel ?? defaultModelOf(options.provider);
    this.#defaultCwd = path.resolve(options.defaultCwd ?? process.cwd());
    this.#sandbox = options.sandbox;
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? createIdGenerator();
  }

  attach(transport: ProtocolTransport): () => void {
    const offMessage = transport.onMessage((message) => {
      void this.handle(transport, message);
    });
    const offClose = transport.onClose?.(() => this.#detach(transport)) ?? (() => undefined);
    return () => {
      offMessage();
      offClose();
      this.#detach(transport);
    };
  }

  async handle(transport: ProtocolTransport, raw: JsonRpcMessage): Promise<void> {
    const parsed = JsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.#sendError(transport, idOf(raw), PROTOCOL_ERROR_CODES.invalidRequest, "invalid request");
      return;
    }
    const message = parsed.data;
    if (!isJsonRpcRequest(message)) {
      // Notifications and responses from clients are not part of this protocol.
      return;
    }

    const method = ProtocolMethodSchema.safeParse(message.method);
    if (!method.success) {
      this.#sendError(
        transport,
        message.id,
        PROTOCOL_ERROR_CODES.methodNotFound,
        `unknown method: ${message.method}`,
      );
      return;
    }

    const definition = PROTOCOL_METHODS[method.data];
    const params = definition.params.safeParse(message.params ?? {});
    if (!params.success) {
      this.#sendError(
        transport,
        message.id,
        PROTOCOL_ERROR_CODES.invalidParams,
        "invalid params",
        params.error.issues,
      );
      return;
    }

    try {
      const result = await this.#dispatch(transport, method.data, params.data as never);
      transport.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.#sendError(transport, message.id, error.code, error.message, error.data);
        return;
      }
      this.#sendError(
        transport,
        message.id,
        PROTOCOL_ERROR_CODES.internalError,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async close(): Promise<void> {
    for (const pending of this.#approvals.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.resolve?.("deny");
    }
    this.#approvals.clear();
    this.#subscriptions.clear();
    this.#sessions.clear();
    await this.#store.close();
  }

  async #dispatch(
    transport: ProtocolTransport,
    method: ProtocolMethod,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverName: "pika-harness",
          capabilities: { transports: ["stdio", "websocket", "in-process"] },
        };
      case "session.start":
        return this.#startSession(
          params as { cwd: string; model?: string; sandbox?: SandboxSelection },
        );
      case "session.resume":
        return this.#resumeSession(params as { sessionId: string });
      case "session.fork":
        return this.#forkSession(params as { sessionId: string; entryId: string });
      case "session.list":
        return { sessions: await this.#store.list() };
      case "turn.start": {
        const input = params as { sessionId: string; text: string };
        const session = this.#requireSession(input);
        await session.runtime.prompt(input.text);
        return { accepted: true };
      }
      case "turn.steer": {
        const input = params as { sessionId: string; text: string };
        const session = this.#requireSession(input);
        await session.runtime.steer(input.text);
        return { accepted: true };
      }
      case "turn.follow_up": {
        const input = params as { sessionId: string; text: string };
        const session = this.#requireSession(input);
        await session.runtime.followUp(input.text);
        return { accepted: true };
      }
      case "turn.interrupt": {
        const input = params as { sessionId: string; reason?: string };
        const session = this.#requireSession(input);
        await session.runtime.interrupt(input.reason);
        return { accepted: true };
      }
      case "approval.respond":
        return this.#respondToApproval(params as ApprovalResponseInput);
      case "subscribe":
        return this.#subscribe(transport, params as { sessionId: string });
      case "unsubscribe":
        return this.#unsubscribe(transport, params as { subscriptionId: string });
      case "sandbox.mode":
        return this.#selectSandboxMode(params as SandboxModeInput);
    }
  }

  async #startSession(input: {
    cwd: string;
    model?: string;
    sandbox?: SandboxSelection;
  }): Promise<{ session: SessionSummary; sandbox: EffectiveSandbox }> {
    const cwd = path.resolve(this.#defaultCwd, input.cwd);
    const model = input.model ?? this.#defaultModel ?? "unknown-model";
    const sessionId = this.#ids.next("session");
    const createdAt = this.#clock.now().toISOString();
    const policy = this.#resolvePolicy(input.sandbox, cwd);

    await this.#store.create({ id: sessionId, cwd, model, createdAt });

    const runtime = this.#createRuntime({ sessionId, cwd, model }, policy, []);
    const meta: SessionMeta = { id: sessionId, cwd, model, createdAt };
    this.#sessions.set(sessionId, { meta, runtime, policy });
    await this.#applyPolicy(runtime, policy, "session started");
    return { session: await this.#summary(sessionId), sandbox: effective(policy, this.#backend()) };
  }

  async #resumeSession(input: {
    sessionId: string;
  }): Promise<{ session: SessionSummary; sandbox: EffectiveSandbox }> {
    const existing = this.#sessions.get(input.sessionId);
    if (existing !== undefined && existing.policy !== undefined) {
      return {
        session: await this.#summary(input.sessionId),
        sandbox: effective(existing.policy, this.#backend()),
      };
    }
    let state: Awaited<ReturnType<typeof loadResumeState>>;
    try {
      state = await loadResumeState(this.#store, input.sessionId);
    } catch (error) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.sessionNotSettled,
        error instanceof Error ? error.message : String(error),
      );
    }
    const meta: SessionMeta = {
      id: state.summary.id,
      cwd: state.summary.cwd,
      model: state.summary.model,
      createdAt: state.summary.createdAt,
      ...(state.summary.title === undefined ? {} : { title: state.summary.title }),
    };
    const policy = this.#resolvePolicy(undefined, meta.cwd);
    const runtime = this.#createRuntime(
      { sessionId: meta.id, cwd: meta.cwd, model: meta.model },
      policy,
      state.history.map((message) => ({ message })),
    );
    this.#sessions.set(meta.id, { meta, runtime, policy });
    await this.#applyPolicy(runtime, policy, "session resumed");
    return { session: state.summary, sandbox: effective(policy, this.#backend()) };
  }

  async #forkSession(input: { sessionId: string; entryId: string }): Promise<{
    session: SessionMeta;
  }> {
    const source = this.#requireSession(input);
    const meta = await this.#store.fork(input.sessionId, input.entryId);
    const entries = await this.#store.entries(meta.id);
    const history = replaySession({ entries }).messages;
    const policy = source.policy ?? this.#resolvePolicy(undefined, meta.cwd);
    const runtime = this.#createRuntime(
      { sessionId: meta.id, cwd: meta.cwd, model: meta.model },
      policy,
      history.map((message) => ({ message })),
    );
    this.#sessions.set(meta.id, { meta, runtime, policy });
    await this.#applyPolicy(runtime, policy, "session forked");
    return { session: meta };
  }

  #respondToApproval(input: ApprovalResponseInput): { accepted: true } {
    const pending = this.#approvals.get(input.approvalId);
    if (pending === undefined || pending.sessionId !== input.sessionId) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.approvalNotFound,
        `approval not found: ${input.approvalId}`,
      );
    }
    if (pending.resolve === undefined) {
      // The client can answer before the runtime starts awaiting the decision.
      pending.decision = input.decision;
      const timer = setTimeout(() => {
        this.#approvals.delete(input.approvalId);
      }, this.#approvalTimeoutMs);
      timer.unref?.();
      pending.timer = timer;
      return { accepted: true };
    }
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#approvals.delete(input.approvalId);
    pending.resolve(input.decision);
    return { accepted: true };
  }

  #subscribe(
    transport: ProtocolTransport,
    input: { sessionId: string },
  ): { subscriptionId: string } {
    this.#requireSession(input);
    const id = this.#ids.next("subscription");
    this.#subscriptions.set(id, { id, sessionId: input.sessionId, transport });
    let owned = this.#transportSubscriptions.get(transport);
    if (owned === undefined) {
      owned = new Set();
      this.#transportSubscriptions.set(transport, owned);
    }
    owned.add(id);
    return { subscriptionId: id };
  }

  #unsubscribe(
    transport: ProtocolTransport,
    input: { subscriptionId: string },
  ): { removed: boolean } {
    const subscription = this.#subscriptions.get(input.subscriptionId);
    if (subscription === undefined || subscription.transport !== transport) {
      return { removed: false };
    }
    this.#subscriptions.delete(input.subscriptionId);
    this.#transportSubscriptions.get(transport)?.delete(input.subscriptionId);
    return { removed: true };
  }

  async #selectSandboxMode(input: SandboxModeInput): Promise<EffectiveSandbox> {
    const session = this.#requireSession(input);
    const selection = SandboxSelectionSchema.parse({
      mode: input.mode,
      ...(input.network === undefined ? {} : { network: input.network }),
    });
    const policy = this.#resolvePolicy(selection, session.meta.cwd);
    session.policy = policy;
    await this.#applyPolicy(
      session.runtime,
      policy,
      `client selected ${policy.mode}/${policy.network}`,
    );
    return effective(policy, this.#backend());
  }

  #createRuntime(
    context: SessionContext,
    policy: SandboxPolicy,
    history: RuntimeHistoryEntry[],
  ): AgentRuntime {
    const provider =
      typeof this.#provider === "function" ? this.#provider(context) : this.#provider;
    const toolExecutor =
      typeof this.#toolExecutor === "function" ? this.#toolExecutor(context) : this.#toolExecutor;
    return createRuntime({
      sessionId: context.sessionId,
      model: context.model,
      provider,
      eventSink: {
        emit: (event) => this.#broadcast(context.sessionId, event),
      },
      sessionStore: this.#store,
      clock: this.#clock,
      ids: this.#ids,
      initialHistory: history,
      tools: this.#tools,
      ...(this.#systemPrompt === undefined ? {} : { systemPrompt: this.#systemPrompt }),
      ...(this.#promptSections === undefined ? {} : { promptSections: this.#promptSections }),
      ...(toolExecutor === undefined ? {} : { toolExecutor }),
      sandbox: {
        backend: this.#sandbox.backend,
        policy,
        ...(this.#sandbox.approvalMode === undefined
          ? {}
          : { approvalMode: this.#sandbox.approvalMode }),
        approve: (request: ApprovalRequest) => this.#requestApproval(context.sessionId, request),
      },
    });
  }

  async #applyPolicy(runtime: AgentRuntime, policy: SandboxPolicy, reason: string): Promise<void> {
    await runtime.setSandboxPolicy(policy, reason);
  }

  #requestApproval(sessionId: string, request: ApprovalRequest): Promise<ApprovalDecision> {
    const announced = this.#approvals.get(request.id);
    const timer = setTimeout(() => {
      this.#approvals.delete(request.id);
    }, this.#approvalTimeoutMs);
    timer.unref?.();

    if (announced !== undefined && announced.sessionId === sessionId) {
      announced.timer = timer;
      if (announced.decision !== undefined) {
        const decision = announced.decision;
        clearTimeout(timer);
        this.#approvals.delete(request.id);
        return Promise.resolve(decision);
      }
      return new Promise((resolve) => {
        announced.resolve = (decision) => {
          clearTimeout(timer);
          resolve(decision);
        };
      });
    }

    return new Promise((resolve) => {
      this.#approvals.set(request.id, {
        sessionId,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
        timer,
      });
    });
  }

  #broadcast(sessionId: string, event: AgentEvent): void {
    if (event.type === "approval_requested" && !this.#approvals.has(event.approval.id)) {
      // Register the announced id so a fast client response is accepted, not rejected.
      this.#approvals.set(event.approval.id, { sessionId });
    }
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.sessionId !== sessionId) continue;
      subscription.transport.send({
        jsonrpc: "2.0",
        method: "event",
        params: { subscriptionId: subscription.id, event },
      });
    }
  }

  #resolvePolicy(selection: SandboxSelection | undefined, workspaceRoot: string): SandboxPolicy {
    const sandbox = this.#sandbox;
    const requestedMode = selection?.mode ?? sandbox.defaultMode ?? "workspace-write";
    const requestedNetwork = selection?.network ?? sandbox.defaultNetwork ?? "none";
    const mode = clampMode(requestedMode, sandbox.maxMode ?? "danger-full-access");
    const network = clampNetwork(requestedNetwork, sandbox.maxNetwork ?? "full");
    return resolveSandboxPolicy({
      mode,
      workspaceRoot,
      network,
      ...(sandbox.timeoutMs === undefined ? {} : { timeoutMs: sandbox.timeoutMs }),
      ...(sandbox.maxOutputBytes === undefined ? {} : { maxOutputBytes: sandbox.maxOutputBytes }),
    });
  }

  #backend(): SandboxBackend {
    return this.#sandbox.backend;
  }

  #requireSession(input: { sessionId: string }): ManagedSession {
    const session = this.#sessions.get(input.sessionId);
    if (session === undefined) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.sessionNotFound,
        `session not found: ${input.sessionId}`,
      );
    }
    return session;
  }

  async #summary(sessionId: string): Promise<SessionSummary> {
    const sessions = await this.#store.list();
    const summary = sessions.find((candidate) => candidate.id === sessionId);
    if (summary === undefined) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.sessionNotFound,
        `session not found: ${sessionId}`,
      );
    }
    return summary;
  }

  #detach(transport: ProtocolTransport): void {
    const owned = this.#transportSubscriptions.get(transport);
    if (owned === undefined) return;
    for (const id of owned) this.#subscriptions.delete(id);
    this.#transportSubscriptions.delete(transport);
  }

  #sendError(
    transport: ProtocolTransport,
    id: JsonRpcId | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    transport.send({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  }
}

/** Creates a session server backed by the given provider, store, and tool executor. */
export function createSessionServer(options: SessionServerOptions): SessionServer {
  return new DefaultSessionServer(options);
}

function defaultModelOf(provider: SessionServerOptions["provider"]): string | undefined {
  if (typeof provider === "function") return undefined;
  return provider.models()[0]?.id;
}

function effective(policy: SandboxPolicy, backend: SandboxBackend): EffectiveSandbox {
  return { backend, mode: policy.mode, network: policy.network };
}

function clampMode(requested: SandboxMode, ceiling: SandboxMode): SandboxMode {
  return MODE_RANK[requested] <= MODE_RANK[ceiling] ? requested : ceiling;
}

function clampNetwork(requested: NetworkPolicy, ceiling: NetworkPolicy): NetworkPolicy {
  return NETWORK_RANK[requested] <= NETWORK_RANK[ceiling] ? requested : ceiling;
}

function idOf(message: JsonRpcMessage): JsonRpcId | null {
  if ("id" in message) {
    return message.id;
  }
  return null;
}
