import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionMeta } from "@pika-harness/schema";
import { JsonlSessionStore } from "../../src/storage/jsonl-store.js";
import { SqliteSessionIndex } from "../../src/storage/sqlite-index.js";

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 2, 12, 0, seconds)).toISOString();
}

function meta(id: string, title?: string): SessionMeta {
  return {
    id,
    cwd: "/work/project",
    model: "test-model",
    createdAt: timestamp(0),
    ...(title === undefined ? {} : { title }),
  };
}

function userMessage(sessionId: string, turnId: string, text: string): AgentEvent {
  return {
    type: "user_message",
    sessionId,
    turnId,
    timestamp: timestamp(1),
    messageId: `msg_${text}`,
    delivery: "prompt",
    message: { role: "user", text },
  };
}

function messageEnd(sessionId: string, turnId: string): AgentEvent {
  return {
    type: "message_end",
    sessionId,
    turnId,
    timestamp: timestamp(2),
    messageId: "msg_answer",
    stopReason: "end",
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 },
  };
}

function settled(sessionId: string): AgentEvent {
  return { type: "settled", sessionId, timestamp: timestamp(3) };
}

describe("SqliteSessionIndex", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "pika-index-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seededStore(): Promise<JsonlSessionStore> {
    const store = new JsonlSessionStore(join(root, "sessions"));
    await store.create(meta("session_alpha", "Alpha work"));
    await store.append("session_alpha", userMessage("session_alpha", "turn_1", "hello index"));
    await store.append("session_alpha", messageEnd("session_alpha", "turn_1"));
    await store.append("session_alpha", settled("session_alpha"));

    await store.create(meta("session_beta", "Beta work"));
    await store.append("session_beta", userMessage("session_beta", "turn_1", "unrelated text"));
    await store.append("session_beta", settled("session_beta"));
    return store;
  }

  it("indexes listings, usage totals, and search results", async () => {
    const store = await seededStore();
    const index = new SqliteSessionIndex(join(root, "index.db"));
    await index.rebuild(store);

    expect(index.list()).toEqual(await store.list());
    expect(index.list().map((summary) => summary.id)).toEqual(["session_alpha", "session_beta"]);
    expect(index.usage("session_alpha")).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
    expect(index.usage("session_beta")).toBeUndefined();
    expect(index.search("HELLO").map((summary) => summary.id)).toEqual(["session_alpha"]);
    expect(index.search("beta work").map((summary) => summary.id)).toEqual(["session_beta"]);
    expect(index.search("missing")).toEqual([]);
    index.close();
  });

  it("produces identical results after deleting and rebuilding the index", async () => {
    const store = await seededStore();
    const path = join(root, "index.db");
    const first = new SqliteSessionIndex(path);
    await first.rebuild(store);
    const before = {
      list: first.list(),
      search: first.search("work"),
      usage: first.usage("session_alpha"),
    };
    first.close();
    await rm(path, { force: true });

    const second = new SqliteSessionIndex(path);
    await second.rebuild(store);
    expect(second.list()).toEqual(before.list);
    expect(second.search("work")).toEqual(before.search);
    expect(second.usage("session_alpha")).toEqual(before.usage);
    second.close();
  });
});
