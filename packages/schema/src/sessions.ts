import { z } from "zod";
import { AgentEventSchema } from "./events.js";
import { EntryIdSchema, SessionIdSchema } from "./ids.js";
import { TimestampSchema } from "./timestamp.js";
import { UsageSchema } from "./usage.js";

export const SessionStatusSchema = z.enum(["active", "settled", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionMetaSchema = z.object({
  id: SessionIdSchema,
  title: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().min(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
  parentSessionId: SessionIdSchema.optional(),
  forkEntryId: EntryIdSchema.optional(),
});

export const SessionSummarySchema = z.object({
  id: SessionIdSchema,
  title: z.string().optional(),
  cwd: z.string().min(1),
  model: z.string().min(1),
  status: SessionStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastEntryId: EntryIdSchema.nullable(),
  usage: UsageSchema.optional(),
});

export const SessionEntrySchema = z.object({
  id: EntryIdSchema,
  parentId: EntryIdSchema.nullable(),
  event: AgentEventSchema,
});

export const SessionListSchema = z.array(SessionSummarySchema);

export type SessionMeta = z.infer<typeof SessionMetaSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionEntry = z.infer<typeof SessionEntrySchema>;
