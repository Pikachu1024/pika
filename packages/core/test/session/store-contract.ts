import type { AgentEvent, SessionMeta, SessionSummary, Usage } from "@pika-harness/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionStore } from "../../src/session-store.js";

export interface SessionStoreFixture {
  store: SessionStore;
  cleanup(): Promise<void>;
}

export type SessionStoreFactory = () => SessionStoreFixture | Promise<SessionStoreFixture>;

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 2, 10, 0, seconds)).toISOString();
}

function makeMeta(id: string, title?: string): SessionMeta {
  return {
    id,
    cwd: "/tmp/pika-work",
    model: "test-model",
    createdAt: timestamp(0),
    ...(title === undefined ? {} : { title }),
  };
}

function agentStart(sessionId: string, at: string): AgentEvent {
  return { type: "agent_start", sessionId, timestamp: at };
}

function turnStart(sessionId: string, turnId: string, at: string): AgentEvent {
  return {
    type: "turn_start",
    sessionId,
    turnId,
    turnNumber: 1,
    timestamp: at,
    input: { role: "user", text: "hello" },
  };
}

function messageEnd(
  sessionId: string,
  turnId: string,
  messageId: string,
  at: string,
  usage: Usage,
): AgentEvent {
  return {
    type: "message_end",
    sessionId,
    turnId,
    messageId,
    timestamp: at,
    stopReason: "end",
    usage,
  };
}

function turnEnd(sessionId: string, turnId: string, at: string, usage: Usage): AgentEvent {
  return { type: "turn_end", sessionId, turnId, timestamp: at, stopReason: "end", usage };
}

function errorEvent(sessionId: string, turnId: string, at: string): AgentEvent {
  return {
    type: "error",
    sessionId,
    turnId,
    timestamp: at,
    error: { code: "provider_error", message: "boom", retryable: false },
  };
}

function settledEvent(sessionId: string, at: string): AgentEvent {
  return { type: "settled", sessionId, timestamp: at };
}

function summaryFor(summaries: SessionSummary[], id: string): SessionSummary {
  const found = summaries.find((summary) => summary.id === id);
  if (found === undefined) throw new Error(`Missing summary for session ${id}`);
  return found;
}

/** Registers the shared SessionStore behavior suite against a store factory. */
export function registerSessionStoreContract(name: string, factory: SessionStoreFactory): void {
  describe(name, () => {
    let fixture: SessionStoreFixture | undefined;

    beforeEach(async () => {
      fixture = await factory();
    });

    afterEach(async () => {
      if (fixture === undefined) return;
      await fixture.store.close();
      await fixture.cleanup();
      fixture = undefined;
    });

    function store(): SessionStore {
      if (fixture === undefined) {
        throw new Error("Session store fixture was not initialized");
      }
      return fixture.store;
    }

    it("creates a session and appends entries in append order", async () => {
      const meta = makeMeta("session_order");
      await store().create(meta);

      const first = await store().append(meta.id, agentStart(meta.id, timestamp(1)));
      const second = await store().append(meta.id, turnStart(meta.id, "turn_1", timestamp(2)));
      const third = await store().append(meta.id, settledEvent(meta.id, timestamp(3)));

      expect(new Set([first.id, second.id, third.id]).size).toBe(3);
      const entries = await store().entries(meta.id);
      expect(entries.map((entry) => entry.event.type)).toEqual([
        "agent_start",
        "turn_start",
        "settled",
      ]);
      expect(entries.map((entry) => entry.id)).toEqual([first.id, second.id, third.id]);
      expect(entries.map((entry) => entry.parentId)).toEqual([null, first.id, second.id]);
    });

    it("defaults to the current leaf and honors explicit parents", async () => {
      const meta = makeMeta("session_links");
      await store().create(meta);

      const root = await store().append(meta.id, agentStart(meta.id, timestamp(1)));
      const leaf = await store().append(meta.id, settledEvent(meta.id, timestamp(2)));
      const explicit = await store().append(meta.id, agentStart(meta.id, timestamp(3)), root.id);
      const defaulted = await store().append(meta.id, agentStart(meta.id, timestamp(4)));
      const detached = await store().append(meta.id, agentStart(meta.id, timestamp(5)), null);

      const entries = await store().entries(meta.id);
      expect(entries.map((entry) => entry.id)).toEqual([
        root.id,
        leaf.id,
        explicit.id,
        defaulted.id,
        detached.id,
      ]);
      expect(entries.map((entry) => entry.parentId)).toEqual([
        null,
        root.id,
        root.id,
        explicit.id,
        null,
      ]);
    });

    it("rejects an event whose sessionId does not match the session", async () => {
      const meta = makeMeta("session_mismatch");
      await store().create(meta);

      await expect(
        store().append(meta.id, settledEvent("session_other", timestamp(1))),
      ).rejects.toThrow(/does not match/);
      expect(await store().entries(meta.id)).toEqual([]);
    });

    it("rejects appends to an unknown session", async () => {
      await expect(
        store().append("session_missing", settledEvent("session_missing", timestamp(1))),
      ).rejects.toThrow(/not found/);
    });

    it("rejects a duplicate create", async () => {
      const meta = makeMeta("session_duplicate");
      await store().create(meta);

      await expect(store().create(meta)).rejects.toThrow(/already exists/);
      expect(await store().list()).toHaveLength(1);
    });

    it("returns an empty array for entries of an unknown session", async () => {
      expect(await store().entries("session_missing")).toEqual([]);
      expect(await store().list()).toEqual([]);
    });

    it("lists status, usage, last entry id, and timestamps", async () => {
      const activeMeta = makeMeta("session_active");
      const settledMeta = makeMeta("session_settled", "Settled session");
      const errorMeta = makeMeta("session_error");
      const emptyMeta = makeMeta("session_empty");
      await store().create(activeMeta);
      await store().create(settledMeta);
      await store().create(errorMeta);
      await store().create(emptyMeta);

      const activeEntry = await store().append(
        activeMeta.id,
        agentStart(activeMeta.id, timestamp(1)),
      );
      await store().append(settledMeta.id, turnStart(settledMeta.id, "turn_1", timestamp(2)));
      await store().append(
        settledMeta.id,
        messageEnd(settledMeta.id, "turn_1", "message_1", timestamp(3), {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 8,
        }),
      );
      await store().append(
        settledMeta.id,
        messageEnd(settledMeta.id, "turn_1", "message_2", timestamp(4), {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 1,
          cacheWriteTokens: 3,
        }),
      );
      // turn_end aggregates the turn; its usage must not be added on top.
      await store().append(
        settledMeta.id,
        turnEnd(settledMeta.id, "turn_1", timestamp(5), {
          inputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 100,
          cacheWriteTokens: 100,
        }),
      );
      const settledEntry = await store().append(
        settledMeta.id,
        settledEvent(settledMeta.id, timestamp(6)),
      );
      const errorEntry = await store().append(
        errorMeta.id,
        errorEvent(errorMeta.id, "turn_1", timestamp(7)),
      );

      const summaries = await store().list();
      expect(summaries).toHaveLength(4);

      const active = summaryFor(summaries, activeMeta.id);
      expect(active.status).toBe("active");
      expect(active.lastEntryId).toBe(activeEntry.id);
      expect(active.updatedAt).toBe(timestamp(1));
      expect(active.usage).toBeUndefined();

      const settled = summaryFor(summaries, settledMeta.id);
      expect(settled.title).toBe("Settled session");
      expect(settled.status).toBe("settled");
      expect(settled.lastEntryId).toBe(settledEntry.id);
      expect(settled.updatedAt).toBe(timestamp(6));
      expect(settled.usage).toEqual({
        inputTokens: 12,
        outputTokens: 5,
        cacheReadTokens: 9,
        cacheWriteTokens: 3,
      });

      const errored = summaryFor(summaries, errorMeta.id);
      expect(errored.status).toBe("error");
      expect(errored.lastEntryId).toBe(errorEntry.id);

      const empty = summaryFor(summaries, emptyMeta.id);
      expect(empty.status).toBe("active");
      expect(empty.lastEntryId).toBeNull();
      expect(empty.updatedAt).toBe(emptyMeta.createdAt);
      expect(empty.usage).toBeUndefined();
    });

    it("copies the ancestor chain when forking and leaves the original unchanged", async () => {
      const source = makeMeta("session_source", "Source session");
      await store().create(source);
      const first = await store().append(source.id, agentStart(source.id, timestamp(1)));
      const second = await store().append(
        source.id,
        messageEnd(source.id, "turn_1", "message_1", timestamp(2), {
          inputTokens: 3,
          outputTokens: 2,
        }),
      );
      const third = await store().append(source.id, settledEvent(source.id, timestamp(3)));

      const forked = await store().fork(source.id, second.id);
      expect(forked.id).not.toBe(source.id);
      expect(forked.parentSessionId).toBe(source.id);
      expect(forked.forkEntryId).toBe(second.id);
      expect(forked.cwd).toBe(source.cwd);
      expect(forked.model).toBe(source.model);
      expect(forked.title).toBe(source.title);

      const copied = await store().entries(forked.id);
      expect(copied.map((entry) => entry.id)).toEqual([first.id, second.id]);
      expect(copied.map((entry) => entry.parentId)).toEqual([null, first.id]);
      expect(copied.map((entry) => entry.event)).toEqual([first.event, second.event]);

      const original = await store().entries(source.id);
      expect(original.map((entry) => entry.id)).toEqual([first.id, second.id, third.id]);
      expect(original.at(-1)?.id).toBe(third.id);

      const appended = await store().append(forked.id, agentStart(forked.id, timestamp(4)));
      expect(appended.parentId).toBe(second.id);
      expect(await store().entries(source.id)).toHaveLength(3);

      const summaries = await store().list();
      expect(summaryFor(summaries, source.id).status).toBe("settled");
      expect(summaryFor(summaries, forked.id).status).toBe("active");
    });

    it("rejects a fork at an unknown entry", async () => {
      const meta = makeMeta("session_fork_missing");
      await store().create(meta);
      await store().append(meta.id, agentStart(meta.id, timestamp(1)));

      await expect(store().fork(meta.id, "entry_missing")).rejects.toThrow(/not found/);
    });

    it("is safe to close twice", async () => {
      await store().close();
      await store().close();
    });

    it("serializes concurrent appends into a single chain", async () => {
      const meta = makeMeta("session_concurrent");
      await store().create(meta);
      const events = Array.from({ length: 16 }, (_, index) =>
        agentStart(meta.id, timestamp(index + 1)),
      );

      await Promise.all(events.map((event) => store().append(meta.id, event)));

      const entries = await store().entries(meta.id);
      expect(entries).toHaveLength(events.length);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(events.length);
      expect(entries.map((entry) => entry.event)).toEqual(events);
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) throw new Error("Missing concurrent entry");
        expect(entry.parentId).toBe(index === 0 ? null : (entries[index - 1]?.id ?? null));
      }
    });
  });
}
