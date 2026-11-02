import type {
  AgentEvent,
  ApprovalDecision,
  EffectiveSandbox,
  EventNotificationParams,
  InitializeResult,
  JsonRpcId,
  JsonRpcMessage,
  NetworkPolicy,
  ProtocolTransport,
  SandboxMode,
  SandboxSelection,
  SessionForkResult,
  SessionStartResult,
  SessionSummary,
} from "@pika-harness/schema";
import {
  ApprovalRespondResultSchema,
  EffectiveSandboxSchema,
  EventNotificationParamsSchema,
  InitializeResultSchema,
  isJsonRpcRequest,
  JsonRpcMessageSchema,
  SessionForkResultSchema,
  SessionListResultSchema,
  SessionStartResultSchema,
  SubscribeResultSchema,
  TurnAcceptedResultSchema,
  UnsubscribeResultSchema,
} from "@pika-harness/schema";

export interface PikaClientOptions {
  transport: ProtocolTransport;
  clientName?: string;
  requestTimeoutMs?: number;
}

export interface StartSessionInput {
  cwd: string;
  model?: string;
  sandbox?: SandboxSelection;
}

/** Typed JSON-RPC error returned by the server. */
export class PikaProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "PikaProtocolError";
    this.code = code;
    this.data = data;
  }
}

export interface EventSubscription extends AsyncIterable<AgentEvent> {
  readonly id: string;
  onEvent(handler: (event: AgentEvent) => void): () => void;
  unsubscribe(): Promise<void>;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Thin typed SDK over the JSON-RPC protocol. */
export class PikaClient {
  readonly #transport: ProtocolTransport;
  readonly #clientName: string | undefined;
  readonly #timeoutMs: number;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #subscriptions = new Map<string, EventSubscriptionImpl>();
  #nextId = 1;
  #closed = false;

  constructor(options: PikaClientOptions) {
    this.#transport = options.transport;
    this.#clientName = options.clientName;
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#transport.onMessage((message) => this.#onMessage(message));
    this.#transport.onClose?.(() => this.#abort(new Error("transport closed")));
  }

  async initialize(): Promise<InitializeResult> {
    const result = await this.#request("initialize", {
      ...(this.#clientName === undefined ? {} : { clientName: this.#clientName }),
    });
    return InitializeResultSchema.parse(result);
  }

  async startSession(input: StartSessionInput): Promise<SessionStartResult> {
    const result = await this.#request("session.start", {
      cwd: input.cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    });
    return SessionStartResultSchema.parse(result);
  }

  async resumeSession(sessionId: string): Promise<SessionStartResult> {
    const result = await this.#request("session.resume", { sessionId });
    return SessionStartResultSchema.parse(result);
  }

  async forkSession(sessionId: string, entryId: string): Promise<SessionForkResult> {
    const result = await this.#request("session.fork", { sessionId, entryId });
    return SessionForkResultSchema.parse(result);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const result = SessionListResultSchema.parse(await this.#request("session.list", {}));
    return result.sessions;
  }

  async subscribe(sessionId: string): Promise<EventSubscription> {
    const result = SubscribeResultSchema.parse(await this.#request("subscribe", { sessionId }));
    const subscription = new EventSubscriptionImpl(result.subscriptionId, this);
    this.#subscriptions.set(result.subscriptionId, subscription);
    return subscription;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.#request("turn.start", { sessionId, text }, TurnAcceptedResultSchema);
  }

  async steer(sessionId: string, text: string): Promise<void> {
    await this.#request("turn.steer", { sessionId, text }, TurnAcceptedResultSchema);
  }

  async followUp(sessionId: string, text: string): Promise<void> {
    await this.#request("turn.follow_up", { sessionId, text }, TurnAcceptedResultSchema);
  }

  async interrupt(sessionId: string, reason?: string): Promise<void> {
    await this.#request(
      "turn.interrupt",
      { sessionId, ...(reason === undefined ? {} : { reason }) },
      TurnAcceptedResultSchema,
    );
  }

  async respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.#request(
      "approval.respond",
      { sessionId, approvalId, decision },
      ApprovalRespondResultSchema,
    );
  }

  async setSandboxMode(
    sessionId: string,
    mode: SandboxMode,
    network?: NetworkPolicy,
  ): Promise<EffectiveSandbox> {
    const result = await this.#request("sandbox.mode", {
      sessionId,
      mode,
      ...(network === undefined ? {} : { network }),
    });
    return EffectiveSandboxSchema.parse(result);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort(new Error("client closed"));
    for (const subscription of this.#subscriptions.values()) subscription.close();
    this.#subscriptions.clear();
    void this.#transport.close();
  }

  /** Removes a subscription after the server confirms it. */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const result = UnsubscribeResultSchema.parse(
      await this.#request("unsubscribe", { subscriptionId }),
    );
    if (result.removed) {
      this.#subscriptions.get(subscriptionId)?.close();
      this.#subscriptions.delete(subscriptionId);
    }
  }

  async #request(
    method: string,
    params: unknown,
    schema?: { parse(value: unknown): unknown },
  ): Promise<unknown> {
    if (this.#closed) {
      throw new Error("client is closed");
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`request timed out: ${method}`));
      }, this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    this.#transport.send({ jsonrpc: "2.0", id, method, params });
    const result = await promise;
    return schema === undefined ? result : schema.parse(result);
  }

  #onMessage(raw: JsonRpcMessage): void {
    const parsed = JsonRpcMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;

    if (isJsonRpcRequest(message)) {
      return;
    }
    if ("method" in message) {
      if (message.method === "event") this.#handleEvent(message.params);
      return;
    }

    if (message.id === null) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) {
      pending.reject(
        new PikaProtocolError(message.error.code, message.error.message, message.error.data),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #handleEvent(params: unknown): void {
    const parsed = EventNotificationParamsSchema.safeParse(params);
    if (!parsed.success) return;
    const notification: EventNotificationParams = parsed.data;
    this.#subscriptions.get(notification.subscriptionId)?.push(notification.event);
  }

  #abort(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

class EventSubscriptionImpl implements EventSubscription {
  readonly id: string;
  readonly #client: PikaClient;
  readonly #handlers = new Set<(event: AgentEvent) => void>();
  readonly #queue: AgentEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  #closed = false;

  constructor(id: string, client: PikaClient) {
    this.id = id;
    this.#client = client;
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  unsubscribe(): Promise<void> {
    return this.#client.unsubscribe(this.id);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
    this.#handlers.clear();
  }

  push(event: AgentEvent): void {
    if (this.#closed) return;
    for (const handler of [...this.#handlers]) handler(event);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    this.#queue.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const queued = this.#queue.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
