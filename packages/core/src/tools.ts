import type { ToolCall, ToolResult } from "@pika-harness/schema";
import type { z } from "zod";

export type ToolOutput = Omit<ToolResult, "toolCallId">;

export interface ToolContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
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
}

/** Executes a model-issued batch and returns results in the original call order. */
export interface ToolExecutor {
  execute(calls: ToolCall[], context: ToolBatchContext): Promise<ToolResult[]>;
}
