import { StringDecoder } from "node:string_decoder";
import type { JsonRpcErrorResponse, JsonRpcMessage, ProtocolTransport } from "@pika-harness/schema";
import { PROTOCOL_ERROR_CODES } from "@pika-harness/schema";

export interface StdioTransportOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Newline-delimited JSON over a readable/writable stream pair. */
export class StdioTransport implements ProtocolTransport {
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  readonly #decoder = new StringDecoder("utf8");
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #closeHandlers = new Set<() => void>();
  #buffer = "";
  #closed = false;

  constructor(options: StdioTransportOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#input.on("data", this.#onData);
    this.#input.on("end", this.#onEnd);
  }

  send(message: JsonRpcMessage): void {
    if (this.#closed) return;
    this.#output.write(`${JSON.stringify(message)}\n`);
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
    this.#closed = true;
    this.#input.off("data", this.#onData);
    this.#input.off("end", this.#onEnd);
    for (const handler of [...this.#closeHandlers]) handler();
    this.#closeHandlers.clear();
    this.#handlers.clear();
  }

  readonly #onData = (chunk: Buffer | string): void => {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#dispatch(line);
      newline = this.#buffer.indexOf("\n");
    }
  };

  readonly #onEnd = (): void => {
    this.#buffer += this.#decoder.end();
    const line = this.#buffer.trim();
    this.#buffer = "";
    if (line !== "") this.#dispatch(line);
    this.close();
  };

  #dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.send(parseError());
      return;
    }
    for (const handler of [...this.#handlers]) handler(message as JsonRpcMessage);
  }
}

/** Connected in-memory transports; delivery is queued so ordering is deterministic. */
export function createInProcessTransportPair(): [ProtocolTransport, ProtocolTransport] {
  const left = new InProcessTransport();
  const right = new InProcessTransport();
  left.connect(right);
  right.connect(left);
  return [left, right];
}

class InProcessTransport implements ProtocolTransport {
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #closeHandlers = new Set<() => void>();
  #peer: InProcessTransport | undefined;
  #closed = false;

  connect(peer: InProcessTransport): void {
    this.#peer = peer;
  }

  send(message: JsonRpcMessage): void {
    if (this.#closed) return;
    const peer = this.#peer;
    if (peer === undefined) return;
    queueMicrotask(() => {
      if (peer.#closed) return;
      peer.#deliver(message);
    });
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
    this.#closed = true;
    for (const handler of [...this.#closeHandlers]) handler();
    this.#closeHandlers.clear();
    this.#handlers.clear();
  }

  #deliver(message: JsonRpcMessage): void {
    for (const handler of [...this.#handlers]) handler(message);
  }
}

/** Builds the standard parse-error response for a malformed frame. */
export function parseError(): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id: null,
    error: { code: PROTOCOL_ERROR_CODES.parseError, message: "parse error" },
  };
}
