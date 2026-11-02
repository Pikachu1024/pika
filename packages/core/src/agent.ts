import type {
  ApprovalDecision,
  ApprovalRequest,
  SandboxBackend,
  SandboxPolicy,
  Usage,
} from "@pika-harness/schema";
import type { Clock, IdGenerator } from "./clock.js";
import type { PromptSection } from "./context.js";
import type { EventSink } from "./events.js";
import type { LlmMessage, Provider, ProviderTool } from "./provider.js";
import type { ApprovalMode } from "./sandbox/decisions.js";
import type { SessionStore } from "./session-store.js";
import type { ToolExecutor } from "./tools.js";

export type AgentState = "idle" | "streaming" | "tool-calling" | "compacting" | "aborted";

export interface RuntimeHistoryEntry {
  message: LlmMessage;
  entryId?: string;
}

export interface RuntimeCompactionOptions {
  contextWindow: number;
  reserveTokens: number;
  keepRecentTurns: number;
  summarize(messages: LlmMessage[]): string | Promise<string>;
}

export interface CompactionResult {
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
}

export interface SideQuestionResult {
  text: string;
  usage?: Usage;
}

/** Raised when an operation requires an idle runtime. */
export class NotSettledError extends Error {
  constructor(message = "session is not settled") {
    super(message);
    this.name = "NotSettledError";
  }
}

/** Resolves a sandbox escalation prompt. Returning deny keeps the original policy. */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => ApprovalDecision | Promise<ApprovalDecision>;

export interface RuntimeSandboxOptions {
  backend: SandboxBackend;
  policy: SandboxPolicy;
  /** `on-request` prompts only on denial; `untrusted` also gates writes and shells. */
  approvalMode?: ApprovalMode;
  approve?: ApprovalHandler;
}

export interface RuntimeOptions {
  sessionId: string;
  model: string;
  provider: Provider;
  systemPrompt?: string;
  promptSections?: PromptSection[];
  toolsAdded?: string[];
  toolsRemoved?: string[];
  tools?: ProviderTool[];
  toolExecutor?: ToolExecutor;
  eventSink: EventSink;
  sessionStore?: SessionStore;
  clock?: Clock;
  ids?: IdGenerator;
  maxModelCallsPerTurn?: number;
  initialHistory?: RuntimeHistoryEntry[];
  compaction?: RuntimeCompactionOptions;
  sandbox?: RuntimeSandboxOptions;
}

/** Single-writer runtime facade. Callers enqueue commands; state leaves only as events. */
export interface AgentRuntime {
  readonly state: AgentState;
  /** True when no turn, queue, side question, or compaction is active. */
  isSettled(): boolean;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  /** Replaces the effective sandbox policy and records the change in the session log. */
  setSandboxPolicy(policy: SandboxPolicy, reason?: string): Promise<void>;
  /** Forces compaction below the threshold when a cut point exists. */
  compact(): Promise<CompactionResult>;
  /** Answers without writing to the session log or changing history. */
  askSideQuestion(text: string): Promise<SideQuestionResult>;
  settled(): Promise<void>;
}
