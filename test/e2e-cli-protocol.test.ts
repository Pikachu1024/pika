import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlSessionStore, SqliteSessionIndex } from "@pika-harness/adapters";
import { PikaClient } from "@pika-harness/client";
import type { Tool } from "@pika-harness/core";
import { replaySession } from "@pika-harness/core";
import type { AgentEvent, SessionEntry } from "@pika-harness/schema";
import { createInProcessTransportPair } from "@pika-harness/server";
import { z } from "zod";
import { collectUntilSettled, createTestServer, textTurn, toolCallTurn } from "./helpers.js";

const noteTool: Tool = {
  name: "write_note",
  description: "Writes a note",
  schema: z.object({ text: z.string() }),
  sandbox: { write: true, arbitraryProcess: false },
  async execute(_context, args) {
    const { text } = args as { text: string };
    return { content: [{ type: "text", text: `wrote ${text}` }], isError: false };
  },
};

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pika-e2e-"));
  temporary.push(root);
  return root;
}

interface SessionResult {
  sessionId: string;
  events: AgentEvent[];
  entries: SessionEntry[];
}

/** Drives one approved tool turn through the protocol client and returns the persisted log. */
async function runApprovedSession(sessionsDir: string): Promise<SessionResult> {
  const env = await createTestServer({
    turns: [toolCallTurn("write_note", { text: "hi" }), textTurn],
    tools: [noteTool],
    sandbox: { defaultMode: "read-only", approvalMode: "on-request" },
    store: new JsonlSessionStore(sessionsDir),
  });
  const [serverSide, clientSide] = createInProcessTransportPair();
  env.server.attach(serverSide);
  const client = new PikaClient({ transport: clientSide, clientName: "cli-e2e" });
  try {
    await client.initialize();
    const started = await client.startSession({ cwd: "." });
    const subscription = await client.subscribe(started.session.id);
    subscription.onEvent((event) => {
      if (event.type === "approval_requested") {
        void client.respondToApproval(started.session.id, event.approval.id, "approve_for_session");
      }
    });

    await client.prompt(started.session.id, "write a note");
    const events = await collectUntilSettled(subscription);
    return {
      sessionId: started.session.id,
      events,
      entries: await env.store.entries(started.session.id),
    };
  } finally {
    client.close();
    await env.cleanup();
  }
}

describe("CLI protocol end-to-end", () => {
  it("records the prompt, tool call, approval, tool result, and final message in the log", async () => {
    const root = await makeRoot();
    const result = await runApprovedSession(path.join(root, "sessions"));
    const types = result.events.map((event) => event.type);

    expect(types).toContain("approval_requested");
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types).toContain("settled");
    expect(types.indexOf("approval_requested")).toBeLessThan(types.indexOf("tool_execution_start"));

    const toolEnd = result.events.find((event) => event.type === "tool_execution_end");
    expect(toolEnd?.type === "tool_execution_end" ? toolEnd.result : undefined).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "wrote hi" }],
    });
    expect(result.events.at(-1)?.type).toBe("settled");

    const entryTypes = result.entries.map((entry) => entry.event.type);
    expect(entryTypes.slice(-types.length)).toEqual(types);
    expect(result.entries.every((entry) => entry.event.sessionId === result.sessionId)).toBe(true);

    const replay = replaySession({ entries: result.entries });
    expect(replay.promptChecks.length).toBeGreaterThan(0);
    expect(replay.promptChecks.every((check) => check.matches)).toBe(true);
    expect(replay.turns).toHaveLength(1);
    expect(JSON.stringify(replay.messages)).toContain("wrote hi");
    expect(JSON.stringify(replay.messages)).toContain("Hello ");
  });

  it("replays deterministically after a restart and an index rebuild", async () => {
    const root = await makeRoot();
    const sessionsDir = path.join(root, "sessions");
    const result = await runApprovedSession(sessionsDir);
    const firstReplay = replaySession({ entries: result.entries });

    const restarted = new JsonlSessionStore(sessionsDir);
    const restartedEntries = await restarted.entries(result.sessionId);
    expect(restartedEntries).toEqual(result.entries);

    const secondReplay = replaySession({ entries: restartedEntries });
    expect(secondReplay.promptChecks).toEqual(firstReplay.promptChecks);
    expect(secondReplay.messages).toEqual(firstReplay.messages);

    const index = new SqliteSessionIndex(path.join(root, "index.db"));
    await index.rebuild(restarted);
    const firstList = index.list();
    expect(firstList.map((summary) => summary.id)).toEqual([result.sessionId]);
    expect(firstList[0]?.lastEntryId).toBe(result.entries.at(-1)?.id);
    index.close();

    await rm(path.join(root, "index.db"));
    const rebuilt = new SqliteSessionIndex(path.join(root, "index.db"));
    await rebuilt.rebuild(restarted);
    expect(rebuilt.list()).toEqual(firstList);
    rebuilt.close();
  });
});
