import { createInterface } from "node:readline";
import type { JsonRpcMessage, ProtocolTransport } from "@pika-harness/schema";

export interface StdioClientTransportOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Newline-delimited JSON transport for a client connected to a stdio server. */
export function createStdioClientTransport(
  options: StdioClientTransportOptions,
): ProtocolTransport {
  const handlers = new Set<(message: JsonRpcMessage) => void>();
  const closeHandlers = new Set<() => void>();
  const reader = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of [...closeHandlers]) handler();
    closeHandlers.clear();
    handlers.clear();
  };

  reader.on("line", (line) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    for (const handler of [...handlers]) handler(message as JsonRpcMessage);
  });
  reader.on("close", finish);

  return {
    send(message) {
      if (closed) return;
      options.output.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    close() {
      reader.close();
      finish();
    },
  };
}

interface ClientSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

interface ClientSocketConstructor {
  new (url: string): ClientSocket;
  readonly OPEN: number;
}

/** Connects to a WebSocket server using the runtime's global WebSocket client. */
export function createWebSocketClientTransport(url: string): ProtocolTransport {
  const WebSocketCtor = (globalThis as { WebSocket?: ClientSocketConstructor }).WebSocket;
  if (WebSocketCtor === undefined) {
    throw new Error("WebSocket is not available in this runtime");
  }
  const socket = new WebSocketCtor(url);
  const handlers = new Set<(message: JsonRpcMessage) => void>();
  const closeHandlers = new Set<() => void>();
  const queued: JsonRpcMessage[] = [];
  let opened = false;
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of [...closeHandlers]) handler();
    closeHandlers.clear();
    handlers.clear();
  };

  socket.addEventListener("open", () => {
    opened = true;
    for (const message of queued.splice(0)) socket.send(JSON.stringify(message));
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const handler of [...handlers]) handler(message as JsonRpcMessage);
  });
  socket.addEventListener("close", finish);
  socket.addEventListener("error", finish);

  return {
    send(message) {
      if (closed) return;
      if (!opened) {
        queued.push(message);
        return;
      }
      socket.send(JSON.stringify(message));
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    close() {
      socket.close();
      finish();
    },
  };
}
