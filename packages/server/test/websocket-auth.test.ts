import { afterEach, describe, expect, it } from "bun:test";
import { createWebSocketClientTransport, PikaClient, withToken } from "@pika-harness/client";
import type { WebSocketServerHandle } from "@pika-harness/server";
import { startWebSocketServer } from "@pika-harness/server";
import { WebSocket } from "ws";
import type { TestServer } from "../../../test/helpers.js";
import { createTestServer } from "../../../test/helpers.js";

const TOKEN = "local-run-token";

describe("websocket token authentication", () => {
  let handle: WebSocketServerHandle | undefined;
  let env: TestServer | undefined;
  let client: PikaClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await handle?.close();
    handle = undefined;
    await env?.cleanup();
    env = undefined;
  });

  async function startAuthenticated(): Promise<WebSocketServerHandle> {
    env = await createTestServer();
    const started = await startWebSocketServer({
      port: 0,
      token: TOKEN,
      onConnection: (transport) => {
        env?.server.attach(transport);
      },
    });
    handle = started;
    return started;
  }

  it("accepts a client that presents the token", async () => {
    const started = await startAuthenticated();
    client = new PikaClient({
      transport: createWebSocketClientTransport(started.url, { token: TOKEN }),
      clientName: "auth-test",
    });
    const initialized = await client.initialize();
    expect(initialized.protocolVersion).toBeGreaterThan(0);
  });

  it("rejects a client without a token", async () => {
    const started = await startAuthenticated();
    const result = await attempt(started.url);
    expect(result.opened).toBe(false);
    expect(result.status).toBe(401);
    expect(result.messages).toBe(0);
  });

  it("rejects a client with a stale token", async () => {
    const started = await startAuthenticated();
    const result = await attempt(withToken(started.url, "stale-token"));
    expect(result.opened).toBe(false);
    expect(result.status).toBe(401);
    expect(result.messages).toBe(0);
  });
});

interface AttemptResult {
  opened: boolean;
  status?: number;
  messages: number;
}

function attempt(url: string): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let messages = 0;
    let status: number | undefined;
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      socket.terminate();
      resolve({ opened, messages, ...(status === undefined ? {} : { status }) });
    };
    socket.on("message", () => {
      messages += 1;
    });
    socket.on("open", () => finish(true));
    socket.on("unexpected-response", (_request, response) => {
      status = response.statusCode;
      finish(false);
    });
    socket.on("error", () => finish(false));
  });
}
