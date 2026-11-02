import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { createStdioClientTransport, PikaClient } from "@pika-harness/client";
import type { AgentEvent, ProtocolTransport } from "@pika-harness/schema";
import { createInProcessTransportPair, StdioTransport } from "@pika-harness/server";
import { collectUntilSettled, createTestServer } from "./helpers.js";

interface SessionTrace {
  transcript: string[];
  events: AgentEvent[];
}

async function runSession(transport: ProtocolTransport): Promise<SessionTrace> {
  const client = new PikaClient({ transport, clientName: "equivalence" });
  try {
    const init = await client.initialize();
    const started = await client.startSession({ cwd: "." });
    const subscription = await client.subscribe(started.session.id);
    await client.prompt(started.session.id, "say hello");
    const events = await collectUntilSettled(subscription);
    await subscription.unsubscribe();
    return {
      transcript: [init.serverName, started.session.id, started.sandbox.mode],
      events,
    };
  } finally {
    client.close();
  }
}

describe("transport equivalence", () => {
  it("produces the same events over stdio and in-process transports", async () => {
    const inProcess = await createTestServer();
    const stdio = await createTestServer();
    try {
      const [serverSide, clientSide] = createInProcessTransportPair();
      inProcess.server.attach(serverSide);

      const serverToClient = new PassThrough();
      const clientToServer = new PassThrough();
      stdio.server.attach(new StdioTransport({ input: clientToServer, output: serverToClient }));
      const stdioClient = createStdioClientTransport({
        input: serverToClient,
        output: clientToServer,
      });

      const [inProcessTrace, stdioTrace] = await Promise.all([
        runSession(clientSide),
        runSession(stdioClient),
      ]);

      expect(stdioTrace.transcript).toEqual(inProcessTrace.transcript);
      expect(stdioTrace.events).toEqual(inProcessTrace.events);
      expect(stdioTrace.events.map((event) => event.type)).toEqual([
        "agent_start",
        "turn_start",
        "user_message",
        "context_projected",
        "message_start",
        "message_delta",
        "message_delta",
        "message_end",
        "turn_end",
        "agent_end",
        "settled",
      ]);
    } finally {
      await inProcess.cleanup();
      await stdio.cleanup();
    }
  });

  it("answers malformed stdio frames with a parse error", async () => {
    const server = await createTestServer();
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    try {
      server.server.attach(new StdioTransport({ input: clientToServer, output: serverToClient }));
      const frames: string[] = [];
      serverToClient.on("data", (chunk: Buffer) => frames.push(chunk.toString("utf8")));
      clientToServer.write("not json\n");

      await new Promise((resolve) => setTimeout(resolve, 20));
      const [frame] = frames.join("").trim().split("\n");
      expect(frame === undefined ? undefined : JSON.parse(frame)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
    } finally {
      await server.cleanup();
    }
  });
});
