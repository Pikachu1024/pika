import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ContentPart,
  Delivery,
  MessageDelta,
  NormalizedError,
  SandboxDecision,
  SandboxPolicy,
  StopReason,
  ToolCall,
  ToolResult,
  Usage,
} from "@pika-harness/schema";
import type {
  AgentRuntime,
  AgentState,
  RuntimeCompactionOptions,
  RuntimeOptions,
  RuntimeSandboxOptions,
} from "../agent.js";
import type { Clock, IdGenerator } from "../clock.js";
import { createIdGenerator, systemClock } from "../clock.js";
import { hashPrompt } from "../context/hash.js";
import { estimateMessages } from "../context/token-estimator.js";
import type { PromptSection } from "../context.js";
import type { EventSink } from "../events.js";
import type { LlmEvent, LlmMessage, LlmRequest, Provider, ProviderTool } from "../provider.js";
import type { SessionStore } from "../session-store.js";
import type {
  ApprovalRequestInput,
  SandboxState,
  ToolBatchContext,
  ToolExecutor,
} from "../tools.js";

type ToolCallDelta = Extract<LlmEvent, { type: "tool_call_delta" }>;

interface TurnInput {
  text: string;
  delivery: Delivery;
}

interface ActiveTurn {
  id: string;
  number: number;
}

interface PendingToolCall {
  id: string;
  name?: string;
  arguments: string;
}

interface ModelStepSuccess {
  kind: "done";
  stopReason: StopReason;
  calls: ToolCall[];
  usage: Usage | undefined;
  message: LlmMessage | undefined;
  messageId: string;
  messageEntryId: string | undefined;
}

type ModelStepResult =
  | ModelStepSuccess
  | { kind: "error"; error: NormalizedError; messageStarted: boolean }
  | { kind: "aborted" };

const defaultMaxModelCallsPerTurn = 16;

class SingleWriterRuntime implements AgentRuntime {
  readonly #sessionId: string;
  readonly #model: string;
  readonly #provider: Provider;
  readonly #systemPrompt: string;
  readonly #promptSections: PromptSection[];
  readonly #toolsAdded: string[];
  readonly #toolsRemoved: string[];
  readonly #tools: ProviderTool[];
  readonly #toolExecutor: ToolExecutor | undefined;
  readonly #eventSink: EventSink;
  readonly #sessionStore: SessionStore | undefined;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #maxModelCallsPerTurn: number;
  readonly #compaction: RuntimeCompactionOptions | undefined;
  readonly #sandbox: RuntimeSandboxOptions | undefined;

  #sandboxPolicy: SandboxPolicy | undefined;

  #currentState: AgentState = "idle";
  #history: LlmMessage[] = [];
  #historyEntryIds: Array<string | undefined> = [];
  #promptQueue: string[] = [];
  #steerQueue: string[] = [];
  #followUpQueue: string[] = [];
  #activeTurn: ActiveTurn | null = null;
  #turnCounter = 0;
  #running = false;
  #agentStarted = false;
  #interruptRequested = false;
  #interruptReason: string | undefined;
  #abortController: AbortController | null = null;
  #emissionChain: Promise<void> = Promise.resolve();
  #settleWaiters: Array<() => void> = [];

  constructor(options: RuntimeOptions) {
    this.#sessionId = options.sessionId;
    this.#model = options.model;
    this.#provider = options.provider;
    this.#systemPrompt = options.systemPrompt ?? "";
    this.#promptSections = [...(options.promptSections ?? [])];
    this.#toolsAdded = [...(options.toolsAdded ?? [])];
    this.#toolsRemoved = [...(options.toolsRemoved ?? [])];
    this.#tools = [...(options.tools ?? [])];
    this.#toolExecutor = options.toolExecutor;
    this.#eventSink = options.eventSink;
    this.#sessionStore = options.sessionStore;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? createIdGenerator();
    this.#maxModelCallsPerTurn = options.maxModelCallsPerTurn ?? defaultMaxModelCallsPerTurn;
    this.#compaction = options.compaction;
    this.#sandbox = options.sandbox;
    this.#sandboxPolicy = options.sandbox?.policy;
    if (options.initialHistory !== undefined) {
      this.#history = options.initialHistory.map((entry) => entry.message);
      this.#historyEntryIds = options.initialHistory.map((entry) => entry.entryId);
    }
  }

  get state(): AgentState {
    return this.#currentState;
  }

  /**
   * Starts a turn when idle; when a turn is already running the text becomes a follow-up turn.
   * Resolves once the command is accepted into the serialized queue; await settled() to wait.
   */
  async prompt(text: string): Promise<void> {
    this.#promptQueue.push(text);
    this.#wake();
  }

  /**
   * Applies the text after the current model step; an idle runtime treats it as a prompt.
   * Resolves once the command is accepted into the serialized queue; await settled() to wait.
   */
  async steer(text: string): Promise<void> {
    this.#steerQueue.push(text);
    this.#wake();
  }

  /** Queues a new turn after the current turn ends. */
  async followUp(text: string): Promise<void> {
    this.#followUpQueue.push(text);
    this.#wake();
  }

  /** Signals the active stream or tool batch through its AbortController. */
  async interrupt(reason?: string): Promise<void> {
    if (this.#activeTurn === null) {
      return;
    }
    this.#interruptRequested = true;
    this.#interruptReason = reason;
    const controller = this.#abortController;
    if (controller !== null && !controller.signal.aborted) {
      controller.abort(new Error(reason ?? "interrupted"));
    }
  }

  settled(): Promise<void> {
    if (!this.#running && !this.#hasQueuedWork() && this.#currentState === "idle") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#settleWaiters.push(resolve);
    });
  }

  #wake(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    void this.#runLoop().then(
      () => {
        this.#finishRun();
      },
      () => {
        this.#finishRun();
      },
    );
  }

  #finishRun(): void {
    this.#running = false;
    if (this.#hasQueuedWork()) {
      this.#wake();
      return;
    }
    this.#resolveSettled();
  }

  async #runLoop(): Promise<void> {
    try {
      while (true) {
        this.#routePrompts();
        const input = this.#takeNextInput();
        if (input === null) {
          break;
        }
        await this.#runTurn(input);
      }
      if (this.#agentStarted) {
        this.#agentStarted = false;
        this.#currentState = "idle";
        await this.#emitAgentEnd();
      }
      this.#currentState = "idle";
      await this.#emitSettled();
      this.#resolveSettled();
    } catch (error) {
      this.#currentState = "idle";
      throw error;
    }
  }

  #hasQueuedWork(): boolean {
    return (
      this.#activeTurn !== null ||
      this.#promptQueue.length > 0 ||
      this.#steerQueue.length > 0 ||
      this.#followUpQueue.length > 0
    );
  }

  #routePrompts(): void {
    if (this.#activeTurn === null) {
      return;
    }
    while (this.#promptQueue.length > 0) {
      const text = this.#promptQueue.shift();
      if (text !== undefined) {
        this.#followUpQueue.push(text);
      }
    }
  }

  #takeNextInput(): TurnInput | null {
    const prompt = this.#promptQueue.shift();
    if (prompt !== undefined) {
      return { text: prompt, delivery: "prompt" };
    }
    const followUp = this.#followUpQueue.shift();
    if (followUp !== undefined) {
      return { text: followUp, delivery: "follow_up" };
    }
    const steer = this.#steerQueue.shift();
    if (steer !== undefined) {
      return { text: steer, delivery: "prompt" };
    }
    return null;
  }

  async #runTurn(input: TurnInput): Promise<void> {
    await this.#ensureAgentStart();
    this.#interruptRequested = false;
    this.#interruptReason = undefined;
    const turn: ActiveTurn = { id: this.#ids.next("turn"), number: ++this.#turnCounter };
    this.#activeTurn = turn;
    await this.#emitTurnStart(turn, input);
    const userEntryId = await this.#emitUserMessage(turn, input.text, input.delivery);
    this.#history.push({ role: "user", content: [{ type: "text", text: input.text }] });
    this.#historyEntryIds.push(userEntryId);

    let stopReason: StopReason = "end";
    let turnUsage: Usage | undefined;
    let modelCalls = 0;
    let overflowRetried = false;

    while (true) {
      this.#routePrompts();
      if (this.#interruptRequested) {
        stopReason = "aborted";
        break;
      }
      if (modelCalls >= this.#maxModelCallsPerTurn) {
        await this.#emitError(turn, {
          code: "max_model_calls",
          message: `model call limit of ${this.#maxModelCallsPerTurn} exceeded in one turn`,
          retryable: false,
        });
        stopReason = "error";
        break;
      }

      if (this.#compaction !== undefined) {
        await this.#compactIfNeeded(turn, "threshold");
      }

      modelCalls += 1;
      const step = await this.#runModelStep(turn);
      this.#routePrompts();
      if (step.kind === "aborted") {
        stopReason = "aborted";
        break;
      }
      if (step.kind === "error") {
        if (
          !overflowRetried &&
          !step.messageStarted &&
          isContextOverflow(step.error) &&
          (await this.#compactIfNeeded(turn, "overflow", true))
        ) {
          overflowRetried = true;
          continue;
        }
        await this.#emitError(turn, step.error);
        stopReason = "error";
        break;
      }

      turnUsage = step.usage === undefined ? turnUsage : addUsage(turnUsage, step.usage);
      if (step.message !== undefined) {
        this.#history.push(step.message);
        this.#historyEntryIds.push(step.messageEntryId);
      }
      for (const call of step.calls) {
        await this.#emitToolCallStart(turn, step.messageId, call);
      }

      const usedTools = step.calls.length > 0;
      if (usedTools) {
        await this.#runToolBatch(turn, step.calls);
        if (this.#interruptRequested) {
          stopReason = "aborted";
          break;
        }
      }

      const steered = await this.#applySteering(turn);
      if (steered || usedTools) {
        continue;
      }

      // An inconsistent "tool_use" response with no calls cannot make progress.
      stopReason = step.stopReason === "tool_use" ? "end" : step.stopReason;
      break;
    }

    if (stopReason === "aborted") {
      this.#currentState = "aborted";
      await this.#emitTurnEnd(turn, stopReason, turnUsage);
      this.#currentState = "idle";
    } else {
      this.#currentState = "idle";
      await this.#emitTurnEnd(turn, stopReason, turnUsage);
    }
    this.#activeTurn = null;
  }

  async #ensureAgentStart(): Promise<void> {
    if (this.#agentStarted) {
      return;
    }
    this.#agentStarted = true;
    await this.#emitAgentStart();
  }

  async #runModelStep(turn: ActiveTurn): Promise<ModelStepResult> {
    this.#currentState = "streaming";
    const controller = new AbortController();
    this.#abortController = controller;
    const messageId = this.#ids.next("msg");
    let messageStarted = false;
    let text = "";
    let usage: Usage | undefined;
    let stopReason: StopReason | undefined;
    let providerError: NormalizedError | undefined;
    const pending = new Map<number, PendingToolCall>();

    try {
      const request: LlmRequest = {
        model: this.#model,
        system: this.#systemPrompt,
        messages: [...this.#history],
        tools: [...this.#tools],
      };
      await this.#emitContextProjected(turn, request);
      for await (const event of this.#provider.stream(request, controller.signal)) {
        if (this.#interruptRequested) {
          break;
        }
        switch (event.type) {
          case "text_delta": {
            if (!messageStarted) {
              messageStarted = true;
              await this.#emitMessageStart(turn, messageId);
            }
            text += event.text;
            await this.#emitMessageDelta(turn, messageId, { kind: "text", text: event.text });
            break;
          }
          case "reasoning_delta": {
            if (!messageStarted) {
              messageStarted = true;
              await this.#emitMessageStart(turn, messageId);
            }
            await this.#emitMessageDelta(turn, messageId, {
              kind: "reasoning",
              text: event.text,
            });
            break;
          }
          case "tool_call_delta": {
            if (!messageStarted) {
              messageStarted = true;
              await this.#emitMessageStart(turn, messageId);
            }
            const call = accumulateToolCall(this.#ids, pending, event);
            const delta: MessageDelta = {
              kind: "tool_call",
              index: event.index,
              id: call.id,
              ...(call.name !== undefined ? { name: call.name } : {}),
              ...(event.argumentsDelta !== undefined
                ? { argumentsDelta: event.argumentsDelta }
                : {}),
            };
            await this.#emitMessageDelta(turn, messageId, delta);
            break;
          }
          case "usage": {
            usage = event.usage;
            break;
          }
          case "done": {
            stopReason = event.stopReason;
            break;
          }
          case "error": {
            providerError = event.error;
            break;
          }
        }
        if (stopReason !== undefined || providerError !== undefined) {
          break;
        }
      }
    } catch (error) {
      if (!this.#interruptRequested) {
        providerError = providerFailure(error);
      }
    } finally {
      if (this.#abortController === controller) {
        this.#abortController = null;
      }
    }

    const calls = finalizeToolCalls(pending);

    if (providerError !== undefined) {
      if (messageStarted) {
        await this.#emitMessageEnd(turn, messageId, "error", usage);
      }
      return { kind: "error", error: providerError, messageStarted };
    }

    if (controller.signal.aborted || this.#interruptRequested) {
      if (messageStarted) {
        await this.#emitMessageEnd(turn, messageId, "aborted", usage);
      }
      return { kind: "aborted" };
    }

    if (stopReason === undefined) {
      if (messageStarted) {
        await this.#emitMessageEnd(turn, messageId, "error", usage);
      }
      return {
        kind: "error",
        error: {
          code: "provider_stream_incomplete",
          message: "provider stream ended without a done event",
          retryable: false,
        },
        messageStarted,
      };
    }

    const messageEntryId = messageStarted
      ? await this.#emitMessageEnd(turn, messageId, stopReason, usage)
      : undefined;

    const content: ContentPart[] = text.length > 0 ? [{ type: "text", text }] : [];
    const message: LlmMessage | undefined =
      content.length > 0 || calls.length > 0
        ? {
            role: "assistant",
            content,
            ...(calls.length > 0 ? { toolCalls: calls } : {}),
          }
        : undefined;

    return { kind: "done", stopReason, calls, usage, message, messageId, messageEntryId };
  }

  async #applySteering(turn: ActiveTurn): Promise<boolean> {
    let applied = false;
    while (this.#steerQueue.length > 0) {
      const text = this.#steerQueue.shift();
      if (text === undefined) {
        break;
      }
      const entryId = await this.#emitUserMessage(turn, text, "steer");
      this.#history.push({ role: "user", content: [{ type: "text", text }] });
      this.#historyEntryIds.push(entryId);
      applied = true;
    }
    return applied;
  }

  async #runToolBatch(turn: ActiveTurn, calls: ToolCall[]): Promise<void> {
    this.#currentState = "tool-calling";
    if (this.#toolExecutor === undefined) {
      for (const call of calls) {
        await this.#emitToolExecutionStart(turn, call);
        const result = errorToolResult(call.id, "no tool executor is configured", "no_executor");
        const entryId = await this.#emitToolExecutionEnd(turn, call.id, result);
        this.#history.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
        });
        this.#historyEntryIds.push(entryId);
      }
      return;
    }

    const executor = this.#toolExecutor;
    const controller = new AbortController();
    this.#abortController = controller;
    if (this.#interruptRequested) {
      controller.abort(new Error(this.#interruptReason ?? "interrupted"));
    }

    const started = new Set<string>();
    const ended = new Set<string>();
    const results = new Map<string, ToolResult>();
    const entryIds = new Map<string, string | undefined>();
    let returned: ToolResult[] | undefined;
    let failure: unknown;

    let sandboxState: SandboxState | undefined;
    if (this.#sandbox !== undefined && this.#sandboxPolicy !== undefined) {
      const state: SandboxState = {
        backend: this.#sandbox.backend,
        policy: this.#sandboxPolicy,
        approvalMode: this.#sandbox.approvalMode ?? "on-request",
        setPolicy: (policy) => {
          this.#sandboxPolicy = policy;
          state.policy = policy;
        },
      };
      sandboxState = state;
    }

    const context: ToolBatchContext = {
      sessionId: this.#sessionId,
      turnId: turn.id,
      signal: controller.signal,
      ...(sandboxState === undefined ? {} : { sandbox: sandboxState }),
      ...(sandboxState === undefined
        ? {}
        : {
            recordSandboxDecision: (decision: SandboxDecision) =>
              this.#emitSandboxDecision(turn, decision),
            requestApproval: (request: ApprovalRequestInput) =>
              this.#requestApproval(turn, request),
          }),
      onStart: (call) => {
        if (started.has(call.id)) {
          return;
        }
        started.add(call.id);
        this.#detach(this.#emitToolExecutionStart(turn, call));
      },
      onUpdate: (call, chunk) => {
        this.#detach(this.#emitToolExecutionUpdate(turn, call.id, chunk));
      },
      onEnd: (call, result) => {
        if (ended.has(call.id)) {
          return;
        }
        ended.add(call.id);
        results.set(call.id, result);
        if (!started.has(call.id)) {
          started.add(call.id);
          this.#detach(this.#emitToolExecutionStart(turn, call));
        }
        this.#detach(
          this.#emitToolExecutionEnd(turn, call.id, result).then((entryId) => {
            entryIds.set(call.id, entryId);
          }),
        );
      },
    };

    try {
      if (!controller.signal.aborted) {
        returned = await executor.execute(calls, context);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (this.#abortController === controller) {
        this.#abortController = null;
      }
    }
    await this.#flushEmissions();

    for (const call of calls) {
      if (results.has(call.id)) {
        continue;
      }
      const fromExecutor = returned?.find((result) => result.toolCallId === call.id);
      const result = fromExecutor ?? fallbackToolResult(call.id, controller.signal, failure);
      if (!started.has(call.id)) {
        started.add(call.id);
        await this.#emitToolExecutionStart(turn, call);
      }
      results.set(call.id, result);
      const entryId = await this.#emitToolExecutionEnd(turn, call.id, result);
      entryIds.set(call.id, entryId);
    }

    for (const call of calls) {
      const result = results.get(call.id);
      if (result !== undefined) {
        this.#history.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
        });
        this.#historyEntryIds.push(entryIds.get(call.id));
      }
    }
  }

  #base(): { sessionId: string; timestamp: string } {
    return { sessionId: this.#sessionId, timestamp: this.#clock.now().toISOString() };
  }

  #turnMeta(turn: ActiveTurn): { sessionId: string; timestamp: string; turnId: string } {
    return { ...this.#base(), turnId: turn.id };
  }

  #emit(event: AgentEvent): Promise<string | undefined> {
    let entryId: string | undefined;
    const run = this.#emissionChain.then(async () => {
      if (this.#sessionStore !== undefined) {
        const entry = await this.#sessionStore.append(this.#sessionId, event, undefined);
        entryId = entry.id;
      }
      await this.#eventSink.emit(event);
    });
    // Keep the chain alive after a failed sink so later events still have a stable order.
    this.#emissionChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => entryId);
  }

  async #flushEmissions(): Promise<void> {
    await this.#emissionChain;
  }

  // Executor callbacks have no caller to observe a rejected emission.
  #detach(emission: Promise<unknown>): void {
    void emission.catch(() => undefined);
  }

  async #emitAgentStart(): Promise<void> {
    await this.#emit({ ...this.#base(), type: "agent_start" });
  }

  async #emitAgentEnd(): Promise<void> {
    await this.#emit({ ...this.#base(), type: "agent_end" });
  }

  async #emitSettled(): Promise<void> {
    await this.#emit({ ...this.#base(), type: "settled" });
  }

  async #emitTurnStart(turn: ActiveTurn, input: TurnInput): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "turn_start",
      turnNumber: turn.number,
      input: { role: "user", text: input.text },
    };
    await this.#emit(event);
  }

  async #emitTurnEnd(
    turn: ActiveTurn,
    stopReason: StopReason,
    usage: Usage | undefined,
  ): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "turn_end",
      stopReason,
      ...(usage !== undefined ? { usage } : {}),
    };
    await this.#emit(event);
  }

  async #emitUserMessage(
    turn: ActiveTurn,
    text: string,
    delivery: Delivery,
  ): Promise<string | undefined> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "user_message",
      messageId: this.#ids.next("msg"),
      delivery,
      message: { role: "user", text },
    };
    return this.#emit(event);
  }

  async #emitMessageStart(turn: ActiveTurn, messageId: string): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "message_start",
      messageId,
      role: "assistant",
    };
    await this.#emit(event);
  }

  async #emitMessageDelta(turn: ActiveTurn, messageId: string, delta: MessageDelta): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "message_delta",
      messageId,
      delta,
    };
    await this.#emit(event);
  }

  async #emitMessageEnd(
    turn: ActiveTurn,
    messageId: string,
    stopReason: StopReason,
    usage: Usage | undefined,
  ): Promise<string | undefined> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "message_end",
      messageId,
      stopReason,
      ...(usage !== undefined ? { usage } : {}),
    };
    return this.#emit(event);
  }

  async #emitToolCallStart(turn: ActiveTurn, messageId: string, call: ToolCall): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "tool_call_start",
      messageId,
      call,
    };
    await this.#emit(event);
  }

  async #emitToolExecutionStart(turn: ActiveTurn, call: ToolCall): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "tool_execution_start",
      toolCallId: call.id,
      name: call.name,
    };
    await this.#emit(event);
  }

  async #emitToolExecutionUpdate(
    turn: ActiveTurn,
    toolCallId: string,
    chunk: string,
  ): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "tool_execution_update",
      toolCallId,
      chunk,
    };
    await this.#emit(event);
  }

  async #emitToolExecutionEnd(
    turn: ActiveTurn,
    toolCallId: string,
    result: ToolResult,
  ): Promise<string | undefined> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "tool_execution_end",
      toolCallId,
      result,
    };
    return this.#emit(event);
  }

  async #emitError(turn: ActiveTurn, error: NormalizedError): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "error",
      error,
    };
    await this.#emit(event);
  }

  async #emitSandboxDecision(turn: ActiveTurn, decision: SandboxDecision): Promise<void> {
    await this.#emit({ ...this.#turnMeta(turn), type: "sandbox_decision", decision });
  }

  async #requestApproval(turn: ActiveTurn, input: ApprovalRequestInput): Promise<ApprovalDecision> {
    const sandbox = this.#sandbox;
    if (sandbox?.approve === undefined || (sandbox.approvalMode ?? "on-request") === "never") {
      return "deny";
    }
    const approval: ApprovalRequest = {
      id: this.#ids.next("approval"),
      kind: input.kind,
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      toolName: input.toolName,
      args: input.args,
      reason: input.reason,
      createdAt: this.#clock.now().toISOString(),
    };
    await this.#emit({ ...this.#turnMeta(turn), type: "approval_requested", approval });

    let decision: ApprovalDecision;
    try {
      decision = await sandbox.approve(approval);
    } catch {
      decision = "deny";
    }

    await this.#emit({
      ...this.#turnMeta(turn),
      type: "approval_resolved",
      approvalId: approval.id,
      resolution: {
        approvalId: approval.id,
        decision,
        resolvedAt: this.#clock.now().toISOString(),
      },
    });
    return decision;
  }

  async #emitContextProjected(turn: ActiveTurn, request: LlmRequest): Promise<void> {
    const event: AgentEvent = {
      ...this.#turnMeta(turn),
      type: "context_projected",
      promptHash: hashPrompt({
        system: request.system,
        messages: request.messages,
        tools: request.tools,
      }),
      system: request.system,
      sections: this.#promptSections,
      toolsAdded: this.#toolsAdded,
      toolsRemoved: this.#toolsRemoved,
      tools: request.tools,
      messageCount: request.messages.length,
      estimatedTokens: estimateMessages(request.messages),
    };
    await this.#emit(event);
  }

  async #compactIfNeeded(
    turn: ActiveTurn,
    reason: "threshold" | "overflow" | "manual",
    force = false,
  ): Promise<boolean> {
    const settings = this.#compaction;
    if (settings === undefined) {
      return false;
    }
    const tokensBefore = estimateMessages(this.#history);
    if (!force && tokensBefore <= settings.contextWindow - settings.reserveTokens) {
      return false;
    }
    const cutIndex = findCompactionCut(this.#history, settings.keepRecentTurns, force);
    if (cutIndex <= 0) {
      return false;
    }

    this.#currentState = "compacting";
    await this.#emitCompactionStart(turn, reason);
    let summary: string;
    try {
      summary = (await settings.summarize(this.#history.slice(0, cutIndex))).trim();
    } catch (error) {
      summary = "";
      await this.#emitError(turn, {
        code: "compaction_failed",
        message: errorMessage(error),
        retryable: false,
      });
    }
    if (summary.length === 0) {
      summary = "Earlier conversation was compacted.";
    }

    const replacedEntryIds = this.#historyEntryIds
      .slice(0, cutIndex)
      .filter((entryId): entryId is string => entryId !== undefined);
    this.#history = [compactedMessage(summary), ...this.#history.slice(cutIndex)];
    const tokensAfter = estimateMessages(this.#history);
    const entryId = await this.#emitCompactionEnd(turn, {
      summary,
      replacedEntryIds,
      tokensBefore,
      tokensAfter,
    });
    this.#historyEntryIds = [entryId, ...this.#historyEntryIds.slice(cutIndex)];
    return true;
  }

  async #emitCompactionStart(
    turn: ActiveTurn,
    reason: "threshold" | "overflow" | "manual",
  ): Promise<void> {
    await this.#emit({ ...this.#turnMeta(turn), type: "compaction_start", reason });
  }

  async #emitCompactionEnd(
    turn: ActiveTurn,
    details: {
      summary: string;
      replacedEntryIds: string[];
      tokensBefore: number;
      tokensAfter: number;
    },
  ): Promise<string | undefined> {
    return this.#emit({
      ...this.#turnMeta(turn),
      type: "compaction_end",
      summary: details.summary,
      replacedEntryIds: details.replacedEntryIds,
      tokensBefore: details.tokensBefore,
      tokensAfter: details.tokensAfter,
      model: this.#model,
    });
  }

  #resolveSettled(): void {
    const waiters = this.#settleWaiters;
    this.#settleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}

/** Creates a single-writer agent runtime over the given provider and executor. */
export function createRuntime(options: RuntimeOptions): AgentRuntime {
  return new SingleWriterRuntime(options);
}

function accumulateToolCall(
  ids: IdGenerator,
  pending: Map<number, PendingToolCall>,
  event: ToolCallDelta,
): PendingToolCall {
  const existing = pending.get(event.index);
  if (existing === undefined) {
    const created: PendingToolCall = {
      id: event.id ?? ids.next("call"),
      arguments: event.argumentsDelta ?? "",
      ...(event.name !== undefined ? { name: event.name } : {}),
    };
    pending.set(event.index, created);
    return created;
  }
  if (event.id !== undefined) {
    existing.id = event.id;
  }
  if (event.name !== undefined) {
    existing.name = event.name;
  }
  if (event.argumentsDelta !== undefined) {
    existing.arguments += event.argumentsDelta;
  }
  return existing;
}

function finalizeToolCalls(pending: Map<number, PendingToolCall>): ToolCall[] {
  return [...pending.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => ({
      id: call.id,
      name: call.name ?? "unknown",
      arguments: call.arguments,
    }));
}

function fallbackToolResult(toolCallId: string, signal: AbortSignal, failure: unknown): ToolResult {
  if (signal.aborted) {
    return errorToolResult(toolCallId, abortMessage(signal), "aborted");
  }
  if (failure !== undefined) {
    return errorToolResult(toolCallId, errorMessage(failure), "execution_error");
  }
  return errorToolResult(toolCallId, "tool executor returned no result", "missing_result");
}

function errorToolResult(toolCallId: string, message: string, code: string): ToolResult {
  return {
    toolCallId,
    content: [{ type: "error", message: message.length > 0 ? message : "tool error", code }],
    isError: true,
  };
}

function abortMessage(signal: AbortSignal): string {
  const { reason } = signal;
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return `tool call aborted: ${reason.message}`;
  }
  return "tool call aborted";
}

function addUsage(current: Usage | undefined, next: Usage): Usage {
  if (current === undefined) {
    return { ...next };
  }
  const cacheRead = addOptional(current.cacheReadTokens, next.cacheReadTokens);
  const cacheWrite = addOptional(current.cacheWriteTokens, next.cacheWriteTokens);
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function providerFailure(error: unknown): NormalizedError {
  return { code: "provider_error", message: errorMessage(error), retryable: false };
}

function isContextOverflow(error: NormalizedError): boolean {
  const haystack = `${error.code} ${error.message}`.toLowerCase();
  return (
    error.code === "context_overflow" ||
    error.code === "context_length_exceeded" ||
    haystack.includes("context length") ||
    haystack.includes("maximum context") ||
    haystack.includes("too many tokens") ||
    haystack.includes("prompt is too long")
  );
}

function findCompactionCut(
  messages: LlmMessage[],
  keepRecentTurns: number,
  force: boolean,
): number {
  if (keepRecentTurns > 0) {
    let seen = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "user") {
        continue;
      }
      seen += 1;
      if (seen === keepRecentTurns) {
        return index;
      }
    }
  }
  if (!force) {
    return 0;
  }
  for (let index = messages.length - 1; index > 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return 0;
}

function compactedMessage(summary: string): LlmMessage {
  return { role: "user", content: [{ type: "text", text: `[compacted context]\n${summary}` }] };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message : "unknown error";
}
