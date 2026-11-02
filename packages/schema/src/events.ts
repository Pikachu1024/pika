import { z as zod } from "zod";
import { ApprovalRequestSchema, ApprovalResolutionSchema } from "./approvals.js";
import { ContentPartSchema } from "./content.js";
import {
  ApprovalIdSchema,
  EntryIdSchema,
  MessageIdSchema,
  SessionIdSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from "./ids.js";
import { SandboxDecisionSchema } from "./sandbox.js";
import { TimestampSchema } from "./timestamp.js";
import { DeliverySchema, StopReasonSchema, UserMessageSchema } from "./turns.js";
import { UsageSchema } from "./usage.js";

const EventBaseSchema = zod.object({
  sessionId: SessionIdSchema,
  timestamp: TimestampSchema,
});

const TurnEventBaseSchema = EventBaseSchema.extend({
  turnId: TurnIdSchema,
});

export const ToolCallSchema = zod.object({
  id: ToolCallIdSchema,
  name: zod.string().min(1),
  arguments: zod.string(),
});

export const ToolResultSchema = zod.object({
  toolCallId: ToolCallIdSchema,
  content: zod.array(ContentPartSchema),
  isError: zod.boolean(),
  details: zod.record(zod.string(), zod.unknown()).optional(),
  fullOutputRef: zod.string().min(1).optional(),
});

export const MessageDeltaSchema = zod.discriminatedUnion("kind", [
  zod.object({ kind: zod.literal("text"), text: zod.string() }),
  zod.object({ kind: zod.literal("reasoning"), text: zod.string() }),
  zod.object({
    kind: zod.literal("tool_call"),
    index: zod.number().int().nonnegative(),
    id: ToolCallIdSchema.optional(),
    name: zod.string().min(1).optional(),
    argumentsDelta: zod.string().optional(),
  }),
]);

export const NormalizedErrorSchema = zod.object({
  code: zod.string().min(1),
  message: zod.string().min(1),
  retryable: zod.boolean().default(false),
  details: zod.record(zod.string(), zod.unknown()).optional(),
});

export const ProviderToolSchema = zod.object({
  name: zod.string().min(1),
  description: zod.string(),
  parameters: zod.record(zod.string(), zod.unknown()),
});

export const PromptSectionSchema = zod.object({
  name: zod.string().min(1),
  content: zod.string(),
});

export const AgentEventSchema = zod.discriminatedUnion("type", [
  EventBaseSchema.extend({ type: zod.literal("agent_start") }),
  EventBaseSchema.extend({ type: zod.literal("agent_end") }),
  TurnEventBaseSchema.extend({
    type: zod.literal("turn_start"),
    turnNumber: zod.number().int().positive(),
    input: UserMessageSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("turn_end"),
    stopReason: StopReasonSchema,
    usage: UsageSchema.optional(),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("user_message"),
    messageId: MessageIdSchema,
    delivery: DeliverySchema,
    message: UserMessageSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("message_start"),
    messageId: MessageIdSchema,
    role: zod.literal("assistant"),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("message_delta"),
    messageId: MessageIdSchema,
    delta: MessageDeltaSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("message_end"),
    messageId: MessageIdSchema,
    stopReason: StopReasonSchema,
    usage: UsageSchema.optional(),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("tool_call_start"),
    messageId: MessageIdSchema,
    call: ToolCallSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("tool_execution_start"),
    toolCallId: ToolCallIdSchema,
    name: zod.string().min(1),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("tool_execution_update"),
    toolCallId: ToolCallIdSchema,
    chunk: zod.string(),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("tool_execution_end"),
    toolCallId: ToolCallIdSchema,
    result: ToolResultSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("approval_requested"),
    approval: ApprovalRequestSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("approval_resolved"),
    approvalId: ApprovalIdSchema,
    resolution: ApprovalResolutionSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("sandbox_decision"),
    decision: SandboxDecisionSchema,
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("compaction_start"),
    reason: zod.enum(["threshold", "overflow", "manual"]),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("compaction_end"),
    summary: zod.string().min(1),
    replacedEntryIds: zod.array(EntryIdSchema),
    tokensBefore: zod.number().int().nonnegative(),
    tokensAfter: zod.number().int().nonnegative(),
    model: zod.string().min(1),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("context_projected"),
    promptHash: zod.string().regex(/^[0-9a-f]{64}$/),
    system: zod.string(),
    sections: zod.array(PromptSectionSchema),
    toolsAdded: zod.array(zod.string()),
    toolsRemoved: zod.array(zod.string()),
    tools: zod.array(ProviderToolSchema),
    messageCount: zod.number().int().nonnegative(),
    estimatedTokens: zod.number().int().nonnegative(),
  }),
  TurnEventBaseSchema.extend({
    type: zod.literal("error"),
    error: NormalizedErrorSchema,
  }),
  EventBaseSchema.extend({ type: zod.literal("settled") }),
]);

export type ToolCall = zod.infer<typeof ToolCallSchema>;
export type ToolResult = zod.infer<typeof ToolResultSchema>;
export type MessageDelta = zod.infer<typeof MessageDeltaSchema>;
export type NormalizedError = zod.infer<typeof NormalizedErrorSchema>;
export type ProviderTool = zod.infer<typeof ProviderToolSchema>;
export type PromptSection = zod.infer<typeof PromptSectionSchema>;
export type AgentEvent = zod.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent["type"];
