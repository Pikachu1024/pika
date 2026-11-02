import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IdGenerator, SessionForkOverrides, SessionStore } from "@pika-harness/core";
import type {
  AgentEvent,
  SessionEntry,
  SessionMeta,
  SessionSummary,
  Usage,
} from "@pika-harness/schema";

const defaultIds: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID()}`,
};

const META_FILE = "meta.json";
const LOG_FILE = "log.jsonl";

/** Append-only JSONL session store with one directory per session. */
export class JsonlSessionStore implements SessionStore {
  private readonly rootDir: string;
  private readonly ids: IdGenerator;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootDir: string, options: { ids?: IdGenerator } = {}) {
    this.rootDir = resolve(rootDir);
    this.ids = options.ids ?? defaultIds;
  }

  async create(meta: SessionMeta): Promise<void> {
    await this.withLock(meta.id, async () => {
      const directory = this.sessionDirectory(meta.id);
      await mkdir(this.rootDir, { recursive: true });
      try {
        // Non-recursive mkdir doubles as the duplicate check for a session id.
        await mkdir(directory);
      } catch (error) {
        if (isErrorCode(error, "EEXIST")) {
          throw new Error(`Session already exists: ${meta.id}`);
        }
        throw error;
      }
      try {
        await writeFile(this.metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async append(
    sessionId: string,
    event: AgentEvent,
    parentId?: string | null,
  ): Promise<SessionEntry> {
    return this.withLock(sessionId, async () => {
      await this.requireMeta(sessionId);
      if (event.sessionId !== sessionId) {
        throw new Error(`Event sessionId ${event.sessionId} does not match session ${sessionId}`);
      }
      const existing = await this.readEntries(sessionId);
      const leaf = existing.at(-1);
      const resolvedParentId = parentId !== undefined ? parentId : (leaf?.id ?? null);
      if (resolvedParentId !== null && !existing.some((entry) => entry.id === resolvedParentId)) {
        throw new Error(`Parent entry not found in session ${sessionId}: ${resolvedParentId}`);
      }
      const entry: SessionEntry = {
        id: this.ids.next("entry"),
        parentId: resolvedParentId,
        event,
      };
      await appendFile(this.logPath(sessionId), `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    });
  }

  async entries(sessionId: string): Promise<SessionEntry[]> {
    // Read under the append lock so an in-process append cannot expose a partial line.
    return this.withLock(sessionId, () => this.readEntries(sessionId));
  }

  async list(): Promise<SessionSummary[]> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return [];
      throw error;
    }
    const summaries: SessionSummary[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const meta = await this.withLock(dirent.name, () => this.readMeta(dirent.name));
      if (meta === null) continue;
      const entries = await this.withLock(meta.id, () => this.readEntries(meta.id));
      summaries.push(summarize(meta, entries));
    }
    summaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return summaries;
  }

  async fork(
    sessionId: string,
    entryId: string,
    overrides: SessionForkOverrides = {},
  ): Promise<SessionMeta> {
    return this.withLock(sessionId, async () => {
      const sourceMeta = await this.requireMeta(sessionId);
      const sourceEntries = await this.readEntries(sessionId);
      const chain = collectAncestors(sourceEntries, entryId, sessionId);
      const id = this.ids.next("session");
      if (id === sessionId) {
        throw new Error(`Forked session id collides with the source session: ${id}`);
      }
      const meta: SessionMeta = {
        id,
        ...(sourceMeta.title !== undefined ? { title: sourceMeta.title } : {}),
        cwd: overrides.cwd ?? sourceMeta.cwd,
        model: overrides.model ?? sourceMeta.model,
        createdAt: new Date().toISOString(),
        parentSessionId: sessionId,
        forkEntryId: entryId,
      };
      await this.create(meta);
      try {
        const body = `${chain.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
        await writeFile(this.logPath(id), body, "utf8");
      } catch (error) {
        await rm(this.sessionDirectory(id), { recursive: true, force: true });
        throw error;
      }
      return meta;
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.locks.values()]);
  }

  private sessionDirectory(sessionId: string): string {
    if (
      sessionId === "" ||
      sessionId === "." ||
      sessionId === ".." ||
      sessionId.includes("/") ||
      sessionId.includes("\\") ||
      sessionId.includes("\0")
    ) {
      throw new Error(`Invalid session id for a directory name: ${sessionId}`);
    }
    return join(this.rootDir, sessionId);
  }

  private metaPath(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), META_FILE);
  }

  private logPath(sessionId: string): string {
    return join(this.sessionDirectory(sessionId), LOG_FILE);
  }

  private async readMeta(sessionId: string): Promise<SessionMeta | null> {
    const file = this.metaPath(sessionId);
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid JSON in ${file}: ${errorMessage(error)}`, { cause: error });
    }
    return parseMeta(value, file);
  }

  private async requireMeta(sessionId: string): Promise<SessionMeta> {
    const meta = await this.readMeta(sessionId);
    if (meta === null) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return meta;
  }

  private async readEntries(sessionId: string): Promise<SessionEntry[]> {
    const file = this.logPath(sessionId);
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return [];
      throw error;
    }
    const entries: SessionEntry[] = [];
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") continue;
      const lineNumber = index + 1;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON in ${file} at line ${lineNumber}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      entries.push(parseEntry(value, file, lineNumber));
    }
    return entries;
  }

  private async withLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const queued = previous.then(() => current);
    this.locks.set(sessionId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(sessionId) === queued) {
        this.locks.delete(sessionId);
      }
    }
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

function parseMeta(value: unknown, file: string): SessionMeta {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid session metadata in ${file}`);
  }
  const record = value as Record<string, unknown>;
  const { id, cwd, model, createdAt } = record;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof cwd !== "string" ||
    cwd.length === 0 ||
    typeof model !== "string" ||
    model.length === 0 ||
    typeof createdAt !== "string"
  ) {
    throw new Error(`Invalid session metadata in ${file}`);
  }
  return {
    id,
    cwd,
    model,
    createdAt,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.parentSessionId === "string"
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(typeof record.forkEntryId === "string" ? { forkEntryId: record.forkEntryId } : {}),
  };
}

function parseEntry(value: unknown, file: string, line: number): SessionEntry {
  if (typeof value !== "object" || value === null) {
    throw invalidEntryError(file, line);
  }
  const record = value as Record<string, unknown>;
  const { id, parentId, event } = record;
  if (typeof id !== "string" || id.length === 0) {
    throw invalidEntryError(file, line);
  }
  if (parentId !== null && typeof parentId !== "string") {
    throw invalidEntryError(file, line);
  }
  if (!isAgentEventLike(event)) {
    throw invalidEntryError(file, line);
  }
  return { id, parentId, event };
}

function invalidEntryError(file: string, line: number): Error {
  return new Error(`Invalid session entry in ${file} at line ${line}`);
}

function isAgentEventLike(value: unknown): value is AgentEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.timestamp === "string"
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
