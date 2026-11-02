import { afterEach, describe, expect, it } from "bun:test";
import { createWebSocketClientTransport, withToken } from "@pika-harness/client";

interface FakeWebSocketConstructor {
  new (
    url: string,
  ): {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: () => void): void;
  };
  readonly OPEN: number;
}

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

function captureUrl(): { readonly url: string } {
  const captured = { url: "" };
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    constructor(url: string) {
      captured.url = url;
    }
    send(_data: string): void {}
    close(): void {}
    addEventListener(_type: string, _listener: () => void): void {}
  }
  (globalThis as { WebSocket?: unknown }).WebSocket =
    FakeSocket as unknown as FakeWebSocketConstructor;
  return captured;
}

describe("websocket client transport token", () => {
  it("appends the token as a query parameter", () => {
    expect(withToken("ws://127.0.0.1:7331", "abc123")).toBe("ws://127.0.0.1:7331/?token=abc123");
  });

  it("preserves existing query parameters", () => {
    const url = new URL(withToken("ws://127.0.0.1:7331/?mode=local", "abc123"));
    expect(url.searchParams.get("mode")).toBe("local");
    expect(url.searchParams.get("token")).toBe("abc123");
  });

  it("encodes tokens with reserved characters", () => {
    const token = "a b&c=d/e+f";
    const url = new URL(withToken("ws://127.0.0.1:7331", token));
    expect(url.searchParams.get("token")).toBe(token);
  });

  it("leaves the URL untouched when no token is provided", () => {
    const captured = captureUrl();
    const transport = createWebSocketClientTransport("ws://127.0.0.1:7331");
    transport.close();
    expect(captured.url).toBe("ws://127.0.0.1:7331");
  });

  it("connects with the token when one is provided", () => {
    const captured = captureUrl();
    const transport = createWebSocketClientTransport("ws://127.0.0.1:7331", { token: "abc123" });
    transport.close();
    expect(new URL(captured.url).searchParams.get("token")).toBe("abc123");
  });
});
