import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdGenerator } from "@pika-harness/core";
import type { AgentEvent, SessionMeta } from "@pika-harness/schema";
import { registerSessionStoreContract } from "../../../core/test/session/store-contract.js";
import { JsonlSessionStore } from "../../src/storage/jsonl-store.js";

function deterministicIds(): IdGenerator {
  let counter = 0;
  return { next: (prefix) => `${prefix}_${++counter}` };
}

registerSessionStoreContract("JsonlSessionStore", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "pika-session-contract-"));
  return {
    store: new JsonlSessionStore(rootDir, { ids: deterministicIds() }),
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
});

const createdAt = "2026-11-02T09:00:00.000Z";

function makeMeta(id: string): SessionMeta {
  return { id, cwd: "/tmp/pika-work", model: "test-model", createdAt };
}

function agentStart(sessionId: string, at: string): AgentEvent {
  return { type: "agent_start", sessionId, timestamp: at };
}

function settled(sessionId: string, at: string): AgentEvent {
  return { type: "settled", sessionId, timestamp: at };
}

describe("JsonlSessionStore layout", () => {
  const roots: string[] = [];

  async function createFixture(): Promise<{
    rootDir: string;
    store: JsonlSessionStore;
  }> {
    const rootDir = await mkdtemp(join(tmpdir(), "pika-session-layout-"));
    roots.push(rootDir);
    return { rootDir, store: new JsonlSessionStore(rootDir, { ids: deterministicIds() }) };
  }

  afterEach(async () => {
    for (const rootDir of roots.splice(0)) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("writes meta.json and one JSON entry per log line", async () => {
    const { rootDir, store } = await createFixture();
    const meta = makeMeta("session_layout");
    await store.create(meta);
    const first = await store.append(meta.id, agentStart(meta.id, "2026-11-02T10:00:00.000Z"));
    const second = await store.append(meta.id, settled(meta.id, "2026-11-02T10:00:01.000Z"));

    const directory = join(rootDir, meta.id);
    const metaText = await readFile(join(directory, "meta.json"), "utf8");
    expect(JSON.parse(metaText)).toEqual(meta);

    const logText = await readFile(join(directory, "log.jsonl"), "utf8");
    const lines = logText.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([first, second]);
  });

  it("loads persisted sessions from a new store instance", async () => {
    const { rootDir, store } = await createFixture();
    const meta = makeMeta("session_persisted");
    await store.create(meta);
    await store.append(meta.id, agentStart(meta.id, "2026-11-02T10:00:00.000Z"));
    await store.append(meta.id, settled(meta.id, "2026-11-02T10:00:01.000Z"));

    const reopened = new JsonlSessionStore(rootDir);
    expect(await reopened.entries(meta.id)).toEqual(await store.entries(meta.id));
  });

  it("throws a clear error naming the file and line for invalid JSON", async () => {
    const { rootDir, store } = await createFixture();
    const meta = makeMeta("session_corrupt");
    await store.create(meta);
    await store.append(meta.id, agentStart(meta.id, "2026-11-02T10:00:00.000Z"));
    await appendFile(join(rootDir, meta.id, "log.jsonl"), '{"broken"\n', "utf8");

    await expect(store.entries(meta.id)).rejects.toThrow(/log\.jsonl at line 2/);
  });

  it("rejects session ids that would escape the root directory", async () => {
    const { store } = await createFixture();
    await expect(store.create(makeMeta("../escape"))).rejects.toThrow(/Invalid session id/);
  });
});
