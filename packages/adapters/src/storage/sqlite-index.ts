import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionStore } from "@pika-harness/core";
import type { AgentEvent, SessionEntry, SessionSummary, Usage } from "@pika-harness/schema";

interface SummaryRow {
  id: string;
  title: string | null;
  cwd: string;
  model: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_entry_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  has_usage: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_entry_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  has_usage INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_created_at ON sessions(created_at);
`;

/** Rebuildable SQLite query index derived from the append-only session log. */
export class SqliteSessionIndex {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
  }

  /** Deletes every indexed row and rebuilds it from the session store. */
  async rebuild(store: SessionStore): Promise<void> {
    const summaries = await store.list();
    this.#db.exec("DELETE FROM sessions");
    const insert = this.#db.prepare(`
      INSERT INTO sessions (
        id, title, cwd, model, status, created_at, updated_at, last_entry_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, has_usage, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#db.exec("BEGIN");
    try {
      for (const summary of summaries) {
        const entries = await store.entries(summary.id);
        const usage = summary.usage;
        insert.run(
          summary.id,
          summary.title ?? null,
          summary.cwd,
          summary.model,
          summary.status,
          summary.createdAt,
          summary.updatedAt,
          summary.lastEntryId,
          usage?.inputTokens ?? 0,
          usage?.outputTokens ?? 0,
          usage?.cacheReadTokens ?? 0,
          usage?.cacheWriteTokens ?? 0,
          usage === undefined ? 0 : 1,
          buildSearchText(summary, entries),
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Returns indexed sessions ordered by creation time. */
  list(): SessionSummary[] {
    const rows = this.#db
      .prepare("SELECT * FROM sessions ORDER BY created_at ASC, id ASC")
      .all() as unknown as SummaryRow[];
    return rows.map(toSummary);
  }

  /** Finds sessions whose id, title, cwd, or recorded text contains the query. */
  search(query: string): SessionSummary[] {
    const needle = `%${query.toLowerCase()}%`;
    const rows = this.#db
      .prepare(
        `SELECT * FROM sessions
         WHERE lower(id) LIKE ? OR lower(coalesce(title, '')) LIKE ? OR lower(cwd) LIKE ?
            OR search_text LIKE ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(needle, needle, needle, needle) as unknown as SummaryRow[];
    return rows.map(toSummary);
  }

  /** Returns the indexed token totals for one session. */
  usage(sessionId: string): Usage | undefined {
    const row = this.#db
      .prepare(
        `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, has_usage
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as unknown as SummaryRow | undefined;
    if (row === undefined || row.has_usage === 0) {
      return undefined;
    }
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
    };
  }

  close(): void {
    this.#db.close();
  }
}

function toSummary(row: SummaryRow): SessionSummary {
  return {
    id: row.id,
    ...(row.title === null ? {} : { title: row.title }),
    cwd: row.cwd,
    model: row.model,
    status: row.status as SessionSummary["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEntryId: row.last_entry_id,
    ...(row.has_usage === 0
      ? {}
      : {
          usage: {
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            cacheReadTokens: row.cache_read_tokens,
            cacheWriteTokens: row.cache_write_tokens,
          },
        }),
  };
}

function buildSearchText(summary: SessionSummary, entries: SessionEntry[]): string {
  const parts: string[] = [summary.id, summary.title ?? "", summary.cwd, summary.model];
  for (const entry of entries) {
    parts.push(eventText(entry.event));
  }
  return parts.join("\n").toLowerCase();
}

function eventText(event: AgentEvent): string {
  switch (event.type) {
    case "user_message":
      return event.message.text;
    case "message_delta":
      return event.delta.kind === "tool_call" ? (event.delta.name ?? "") : event.delta.text;
    case "tool_call_start":
      return `${event.call.name} ${event.call.arguments}`;
    case "tool_execution_end":
      return event.result.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "error") return part.message;
          return "";
        })
        .join(" ");
    case "compaction_end":
      return event.summary;
    case "error":
      return `${event.error.code} ${event.error.message}`;
    default:
      return "";
  }
}
