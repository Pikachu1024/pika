import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmEvent } from "@pika-harness/core";
import {
  createEventCollector,
  createIdGenerator,
  createRuntime,
  FauxProvider,
  replaySession,
} from "@pika-harness/core";
import { describe, expect, it } from "vitest";
import { RawCaptureProvider } from "../../src/provider/raw-capture.js";
import { JsonlSessionStore } from "../../src/storage/jsonl-store.js";

const turns: LlmEvent[][] = [
  [
    { type: "tool_call_delta", index: 0, id: "call_1", name: "read_file" },
    { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"a.txt"}' },
    { type: "done", stopReason: "tool_use" },
  ],
  [
    { type: "text_delta", text: "done" },
    { type: "done", stopReason: "end" },
  ],
];

describe("RawCaptureProvider", () => {
  it("writes sidecar requests and responses without affecting replay", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pika-raw-")));
    try {
      const store = new JsonlSessionStore(join(root, "sessions"));
      await store.create({
        id: "session_raw",
        cwd: "/work",
        model: "faux-model",
        createdAt: "2026-11-02T12:00:00.000Z",
      });
      const provider = new RawCaptureProvider(new FauxProvider(turns), {
        sessionId: "session_raw",
        directory: join(root, "raw"),
        now: () => new Date("2026-11-02T12:00:00.000Z"),
      });
      const sink = createEventCollector();
      const runtime = createRuntime({
        sessionId: "session_raw",
        model: "faux-model",
        provider,
        sessionStore: store,
        eventSink: sink,
        ids: createIdGenerator(),
      });

      await runtime.prompt("read");
      await runtime.settled();

      const rawDir = join(root, "raw", "session_raw");
      const files = (await readdir(rawDir)).sort();
      expect(files).toHaveLength(4);
      expect(files.filter((file) => file.endsWith("request.json"))).toHaveLength(2);
      const firstRequest = JSON.parse(
        await readFile(join(rawDir, files[0] ?? ""), "utf8"),
      ) as Record<string, unknown>;
      expect(firstRequest).toMatchObject({ model: "faux-model" });

      const entries = await store.entries("session_raw");
      const replayBefore = replaySession({ entries });
      expect(replayBefore.promptChecks).toHaveLength(2);
      expect(replayBefore.promptChecks.every((check) => check.matches)).toBe(true);

      await rm(join(root, "raw"), { recursive: true, force: true });
      const replayAfter = replaySession({ entries });
      expect(replayAfter.promptChecks.map((check) => check.replayedHash)).toEqual(
        replayBefore.promptChecks.map((check) => check.replayedHash),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
