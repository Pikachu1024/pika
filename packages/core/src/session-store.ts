import type { AgentEvent, SessionEntry, SessionMeta, SessionSummary } from "@pika-harness/schema";

export interface SessionForkOverrides {
  model?: string;
  cwd?: string;
}

export interface SessionStore {
  create(meta: SessionMeta): Promise<void>;
  append(sessionId: string, event: AgentEvent, parentId?: string | null): Promise<SessionEntry>;
  entries(sessionId: string): Promise<SessionEntry[]>;
  list(): Promise<SessionSummary[]>;
  fork(sessionId: string, entryId: string, overrides?: SessionForkOverrides): Promise<SessionMeta>;
  close(): Promise<void>;
}
