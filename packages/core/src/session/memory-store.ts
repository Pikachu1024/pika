import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  SessionEntry,
  SessionMeta,
  SessionSummary,
  Usage,
} from "@pika-harness/schema";
import type { IdGenerator } from "../clock.js";
import type { SessionStore } from "../session-store.js";

interface StoredSession {
  meta: SessionMeta;
  entries: SessionEntry[];
}

const defaultIds: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID()}`,
};

/** Session store backed by in-memory maps for tests and single-process use. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly ids: IdGenerator;

  constructor(options: { ids?: IdGenerator } = {}) {
    this.ids = options.ids ?? defaultIds;
  }

  async create(meta: SessionMeta): Promise<void> {
    if (this.sessions.has(meta.id)) {
      throw new Error(`Session already exists: ${meta.id}`);
    }
    this.sessions.set(meta.id, { meta: structuredClone(meta), entries: [] });
  }

  async append(
    sessionId: string,
    event: AgentEvent,
    parentId?: string | null,
  ): Promise<SessionEntry> {
    const session = this.requireSession(sessionId);
    if (event.sessionId !== sessionId) {
      throw new Error(`Event sessionId ${event.sessionId} does not match session ${sessionId}`);
    }
    const leaf = session.entries.at(-1);
    const resolvedParentId = parentId !== undefined ? parentId : (leaf?.id ?? null);
    if (
      resolvedParentId !== null &&
      !session.entries.some((entry) => entry.id === resolvedParentId)
    ) {
      throw new Error(`Parent entry not found in session ${sessionId}: ${resolvedParentId}`);
    }
    const entry: SessionEntry = {
      id: this.ids.next("entry"),
      parentId: resolvedParentId,
      event,
    };
    session.entries.push(entry);
    return entry;
  }

  async entries(sessionId: string): Promise<SessionEntry[]> {
    return [...(this.sessions.get(sessionId)?.entries ?? [])];
  }

  async list(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map((session) => summarize(session.meta, session.entries));
  }

  async fork(sessionId: string, entryId: string): Promise<SessionMeta> {
    const source = this.requireSession(sessionId);
    const chain = collectAncestors(source.entries, entryId, sessionId);
    const id = this.ids.next("session");
    if (id === sessionId || this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }
    const meta: SessionMeta = {
      id,
      ...(source.meta.title !== undefined ? { title: source.meta.title } : {}),
      cwd: source.meta.cwd,
      model: source.meta.model,
      createdAt: new Date().toISOString(),
      parentSessionId: sessionId,
      forkEntryId: entryId,
    };
    this.sessions.set(id, { meta, entries: structuredClone(chain) });
    return meta;
  }

  async close(): Promise<void> {
    // In-memory writes are synchronous, so there is nothing to flush.
  }

  private requireSession(sessionId: string): StoredSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}

function summarize(meta: SessionMeta, entries: SessionEntry[]): SessionSummary {
  const last = entries.at(-1);
  const usage = aggregateUsage(entries);
  return {
    id: meta.id,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    cwd: meta.cwd,
    model: meta.model,
    status: statusOf(last),
    createdAt: meta.createdAt,
    updatedAt: last?.event.timestamp ?? meta.createdAt,
    lastEntryId: last?.id ?? null,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function statusOf(entry: SessionEntry | undefined): SessionSummary["status"] {
  if (entry === undefined) return "active";
  if (entry.event.type === "settled") return "settled";
  if (entry.event.type === "error") return "error";
  return "active";
}

function aggregateUsage(entries: SessionEntry[]): Usage | undefined {
  let found = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const entry of entries) {
    // turn_end repeats aggregate turn usage; counting it would double count message_end.
    if (entry.event.type !== "message_end" || entry.event.usage === undefined) continue;
    found = true;
    inputTokens += entry.event.usage.inputTokens;
    outputTokens += entry.event.usage.outputTokens;
    cacheReadTokens += entry.event.usage.cacheReadTokens ?? 0;
    cacheWriteTokens += entry.event.usage.cacheWriteTokens ?? 0;
  }
  if (!found) return undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function collectAncestors(
  entries: SessionEntry[],
  entryId: string,
  sessionId: string,
): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: string | null = entryId;
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(`Cycle detected in session ${sessionId} at entry ${current}`);
    }
    seen.add(current);
    const entry = byId.get(current);
    if (entry === undefined) {
      throw new Error(`Entry not found in session ${sessionId}: ${current}`);
    }
    chain.push(entry);
    current = entry.parentId;
  }
  return chain.reverse();
}
