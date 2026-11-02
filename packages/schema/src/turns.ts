import { z } from "zod";

export const DeliverySchema = z.enum(["prompt", "steer", "follow_up"]);
export type Delivery = z.infer<typeof DeliverySchema>;

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  text: z.string().min(1),
});

export const PromptCommandSchema = z.object({
  type: z.literal("prompt"),
  text: z.string().min(1),
});

export const SteerCommandSchema = z.object({
  type: z.literal("steer"),
  text: z.string().min(1),
});

export const FollowUpCommandSchema = z.object({
  type: z.literal("follow_up"),
  text: z.string().min(1),
});

export const InterruptCommandSchema = z.object({
  type: z.literal("interrupt"),
  reason: z.string().optional(),
});

export const AgentCommandSchema = z.discriminatedUnion("type", [
  PromptCommandSchema,
  SteerCommandSchema,
  FollowUpCommandSchema,
  InterruptCommandSchema,
]);

export const TurnStatusSchema = z.enum(["running", "completed", "aborted", "error"]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const StopReasonSchema = z.enum(["end", "tool_use", "max_tokens", "aborted", "error"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export type UserMessage = z.infer<typeof UserMessageSchema>;
export type PromptCommand = z.infer<typeof PromptCommandSchema>;
export type SteerCommand = z.infer<typeof SteerCommandSchema>;
export type FollowUpCommand = z.infer<typeof FollowUpCommandSchema>;
export type InterruptCommand = z.infer<typeof InterruptCommandSchema>;
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
