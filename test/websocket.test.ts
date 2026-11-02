import { createWebSocketClientTransport, PikaClient } from "@pika-harness/client";
import type { AgentEvent, JsonRpcMessage } from "@pika-harness/schema";
import type { WebSocketServerHandle } from "@pika-harness/server";
import { startWebSocketServer } from "@pika-harness/server";
import { afterEach, describe, expect, it } from "vitest";
import { collectUntilSettled, createTestServer } from "./helpers.js";

describe("websocket transport", () => {
  let handle: WebSocketServerHandle | undefined;
  const clients: PikaClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await handle?.close();
    handle = undefined;
  });

  it("broadcasts one ordered event stream to every subscriber and stops after unsubscribe", async () => {
    const env = await createTestServer({
      turns: [
        [
          { type: "text_delta", text: "first" },
          { type: "done", stopReason: "end" },
        ],
        [
          { type: "text_delta", text: "second" },
          { type: "done", stopReason: "end" },
        ],
      ],
    });
    handle = await startWebSocketServer({
      port: 0,
      onConnection: (transport) => {
        env.server.attach(transport);
      },
    });

    const transportA = createWebSocketClientTransport(handle.url);
    const transportB = createWebSocketClientTransport(handle.url);
    let rawNotifications = 0;
    transportB.onMessage((message: JsonRpcMessage) => {
      if ("method" in message && message.method === "event") rawNotifications += 1;
    });

    const clientA = new PikaClient({ transport: transportA, clientName: "subscriber-a" });
    const clientB = new PikaClient({ transport: transportB, clientName: "subscriber-b" });
    clients.push(clientA, clientB);

    await Promise.all([clientA.initialize(), clientB.initialize()]);
    const started = await clientA.startSession({ cwd: "." });
    const subscriptionA = await clientA.subscribe(started.session.id);
    const subscriptionB = await clientB.subscribe(started.session.id);

    const eventsB: AgentEvent[] = [];
    subscriptionB.onEvent((event) => eventsB.push(event));

    await clientA.prompt(started.session.id, "first turn");
    const eventsA = await collectUntilSettled(subscriptionA);
    await waitFor(() => eventsB.some((event) => event.type === "settled"));

    expect(eventsB.map((event) => event.type)).toEqual(eventsA.map((event) => event.type));
    expect(eventsB).toEqual(eventsA);
    const notificationsBefore = rawNotifications;

    await subscriptionB.unsubscribe();
    await clientA.prompt(started.session.id, "second turn");
    const secondEvents = await collectUntilSettled(subscriptionA);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(secondEvents.at(-1)?.type).toBe("settled");
    expect(rawNotifications).toBe(notificationsBefore);
    expect(eventsB.filter((event) => event.type === "settled")).toHaveLength(1);

    await env.cleanup();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
