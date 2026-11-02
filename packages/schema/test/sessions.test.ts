import { describe, expect, it } from "vitest";
import { SessionEntrySchema, SessionMetaSchema, SessionSummarySchema } from "../src/sessions.js";

const timestamp = "2026-11-02T10:00:00.000Z";

const meta = {
  id: "session_1",
  title: "Foundation",
  cwd: "/workspace/project",
  model: "gpt-5",
  createdAt: timestamp,
};

const summary = {
  ...meta,
  status: "settled",
  updatedAt: timestamp,
  lastEntryId: "entry_2",
  usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 },
};

const entry = {
  id: "entry_2",
  parentId: "entry_1",
  event: {
    type: "settled",
    sessionId: "session_1",
    timestamp,
  },
};

describe("SessionMetaSchema", () => {
  it("accepts session metadata", () => {
    expect(SessionMetaSchema.safeParse(meta).success).toBe(true);
  });

  it("rejects an empty session id", () => {
    expect(SessionMetaSchema.safeParse({ ...meta, id: "" }).success).toBe(false);
  });
});

describe("SessionSummarySchema", () => {
  it("accepts a settled session summary", () => {
    expect(SessionSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(SessionSummarySchema.safeParse({ ...summary, status: "paused" }).success).toBe(false);
  });
});

describe("SessionEntrySchema", () => {
  it("accepts a linked entry", () => {
    expect(SessionEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("accepts a root entry", () => {
    expect(SessionEntrySchema.safeParse({ ...entry, id: "entry_1", parentId: null }).success).toBe(
      true,
    );
  });

  it("rejects a non-string parent id", () => {
    expect(SessionEntrySchema.safeParse({ ...entry, parentId: 1 }).success).toBe(false);
  });

  it("rejects an invalid event", () => {
    expect(
      SessionEntrySchema.safeParse({ ...entry, event: { type: "settled", sessionId: "" } }).success,
    ).toBe(false);
  });
});
