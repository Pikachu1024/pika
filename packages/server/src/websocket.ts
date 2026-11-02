import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { JsonRpcMessage, ProtocolTransport } from "@pika-harness/schema";
import type { ServerOptions } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import { parseError } from "./transports.js";

export interface WebSocketServerOptions {
  port: number;
  host?: string;
  /** When set, connections must present this token in the `token` query parameter. */
  token?: string;
  onConnection(transport: ProtocolTransport): void;
}

export interface WebSocketServerHandle {
  url: string;
  close(): Promise<void>;
}

/** Wraps one WebSocket connection as a JSON-RPC transport. */
export class WebSocketTransport implements ProtocolTransport {
  readonly #socket: WebSocket;
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #closeHandlers = new Set<() => void>();
  #closed = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => this.#onData(data.toString()));
    socket.on("close", () => this.#finish());
    socket.on("error", () => this.#finish());
  }

  send(message: JsonRpcMessage): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }

  onMessage(handler: (message: JsonRpcMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#socket.close();
    this.#finish();
  }

  #onData(payload: string): void {
    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch {
      this.send(parseError());
      return;
    }
    for (const handler of [...this.#handlers]) handler(message as JsonRpcMessage);
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of [...this.#closeHandlers]) handler();
    this.#closeHandlers.clear();
    this.#handlers.clear();
  }
}

/** Starts a local WebSocket listener; defaults to loopback only. */
export async function startWebSocketServer(
  options: WebSocketServerOptions,
): Promise<WebSocketServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const serverOptions: ServerOptions = { port: options.port, host };
  if (options.token !== undefined) {
    const expected = options.token;
    serverOptions.verifyClient = (info, done) => {
      const candidate = readToken(info.req.url);
      const accepted = candidate !== null && tokenMatches(expected, candidate);
      done(accepted, accepted ? undefined : 401, accepted ? undefined : "Unauthorized");
    };
  }
  const server = new WebSocketServer(serverOptions);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket) => {
    options.onConnection(new WebSocketTransport(socket));
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? (address as AddressInfo).port : options.port;
  return {
    url: `ws://${host}:${port}`,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readToken(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined) return null;
  try {
    return new URL(rawUrl, "ws://127.0.0.1").searchParams.get("token");
  } catch {
    return null;
  }
}

function tokenMatches(expected: string, candidate: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const candidateDigest = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}
