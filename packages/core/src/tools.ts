import type {
  ApprovalDecision,
  SandboxBackend,
  SandboxDecision,
  SandboxPolicy,
  ToolCall,
  ToolResult,
} from "@pika-harness/schema";
import type { z } from "zod";

export type ToolOutput = Omit<ToolResult, "toolCallId">;

/** Declares how a tool exercises the sandbox before it is authorized. */
export interface ToolSandboxProfile {
  /** Writes to the filesystem; PathPolicy still checks the concrete path. */
  write: boolean;
  /** Runs an arbitrary user-supplied command rather than a fixed helper. */
  arbitraryProcess: boolean;
}

export interface ApprovalRequestInput {
  kind: "tool" | "sandbox-escalation";
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

/** Effective sandbox state shared by the runtime and the batch executor. */
export interface SandboxState {
  backend: SandboxBackend;
  policy: SandboxPolicy;
  approvalMode?: "untrusted" | "on-failure" | "on-request" | "never";
  /** Replaces the policy for the rest of the session after an escalation. */
  setPolicy?(policy: SandboxPolicy): void;
}

export interface ToolContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  signal: AbortSignal;
  /** Streams incremental output to a tool_execution_update event. */
  onUpdate(chunk: string): void;
  /** Policy to pass to the executor; may widen after an escalation. */
  sandboxPolicy?: SandboxPolicy;
  /** Records a sandbox decision made while the tool was executing. */
  recordSandboxDecision?(decision: SandboxDecision): Promise<void>;
  /** Asks the client to approve a denied operation. Absent means deny. */
  requestApproval?(request: ApprovalRequestInput): Promise<ApprovalDecision>;
}

export interface ToolOutputStore {
  /** Persists complete output and returns a reference the model can cite. */
  write(toolCallId: string, content: string): Promise<string>;
}

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  /** Provider-facing JSON Schema when it cannot be derived from `schema` (for example MCP tools). */
  parameters?: Record<string, unknown>;
  /** Declares write or arbitrary-process behavior for sandbox classification. */
  sandbox?: ToolSandboxProfile;
  /** Returns a shared key for calls that must not run concurrently; null means independent. */
  concurrencyKey?(args: unknown): string | null;
  execute(context: ToolContext, args: unknown): Promise<ToolOutput>;
}

export interface ToolBatchContext {
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  onStart(call: ToolCall): void;
  onUpdate(call: ToolCall, chunk: string): void;
  onEnd(call: ToolCall, result: ToolResult): void;
  /** Present when the runtime enforces a sandbox policy. */
  sandbox?: SandboxState;
  recordSandboxDecision?(decision: SandboxDecision): Promise<void>;
  requestApproval?(request: ApprovalRequestInput): Promise<ApprovalDecision>;
}

/** Executes a model-issued batch and returns results in the original call order. */
export interface ToolExecutor {
  execute(calls: ToolCall[], context: ToolBatchContext): Promise<ToolResult[]>;
}
