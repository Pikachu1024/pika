import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import type { SessionEntry } from "@pika-harness/schema";
import { SessionEntrySchema } from "@pika-harness/schema";
import { replaySession } from "../../src/session/replay.js";

describe("docs sample session log", () => {
  it("replays every recorded prompt hash", async () => {
    const contents = await readFile(
      new URL("../../../../docs/samples/session-log.jsonl", import.meta.url),
      "utf8",
    );
    const entries: SessionEntry[] = contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => SessionEntrySchema.parse(JSON.parse(line)));

    const replay = replaySession({ entries });
    expect(replay.promptChecks).toHaveLength(1);
    expect(replay.promptChecks[0]?.matches).toBe(true);
    expect(replay.turns).toHaveLength(1);
    expect(replay.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
