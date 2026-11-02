import { z } from "zod";

export const SessionIdSchema = z.string().min(1);
export type SessionId = z.infer<typeof SessionIdSchema>;

export const TurnIdSchema = z.string().min(1);
export type TurnId = z.infer<typeof TurnIdSchema>;

export const EntryIdSchema = z.string().min(1);
export type EntryId = z.infer<typeof EntryIdSchema>;

export const MessageIdSchema = z.string().min(1);
export type MessageId = z.infer<typeof MessageIdSchema>;

export const ToolCallIdSchema = z.string().min(1);
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;

export const ApprovalIdSchema = z.string().min(1);
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
