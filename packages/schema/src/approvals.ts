import { z } from "zod";
import { ApprovalIdSchema, ToolCallIdSchema } from "./ids.js";
import { TimestampSchema } from "./timestamp.js";

export const ApprovalKindSchema = z.enum(["tool", "sandbox-escalation"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalRequestSchema = z.object({
  id: ApprovalIdSchema,
  kind: ApprovalKindSchema,
  toolCallId: ToolCallIdSchema.optional(),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
  createdAt: TimestampSchema,
});

export const ApprovalDecisionSchema = z.enum(["approve", "approve_for_session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalResolutionSchema = z.object({
  approvalId: ApprovalIdSchema,
  decision: ApprovalDecisionSchema,
  resolvedAt: TimestampSchema,
  note: z.string().optional(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;
