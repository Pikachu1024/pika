import { describe, expect, it } from "bun:test";
import {
  EventNotificationParamsSchema,
  InitializeResultSchema,
  isJsonRpcRequest,
  JsonRpcErrorResponseSchema,
  JsonRpcMessageSchema,
  JsonRpcRequestSchema,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_METHODS,
  PROTOCOL_VERSION,
  ProtocolMethodSchema,
  SessionForkResultSchema,
  SessionListResultSchema,
  SessionStartResultSchema,
} from "../src/index.js";

const request = (method: string, params: unknown) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method,
  params,
});

describe("protocol schemas", () => {
  it("round-trips the documented initialize exchange", () => {
    expect(
      JsonRpcRequestSchema.parse(
        request("initialize", { clientName: "docs-client", protocolVersion: PROTOCOL_VERSION }),
      ),
    ).toEqual(
      request("initialize", { clientName: "docs-client", protocolVersion: PROTOCOL_VERSION }),
    );

    const result: ReturnType<typeof InitializeResultSchema.parse> = {
      protocolVersion: PROTOCOL_VERSION,
      serverName: "pika-harness",
      capabilities: { transports: ["stdio", "websocket", "in-process"] },
    };
    expect(InitializeResultSchema.parse(result)).toEqual(result);
    expect(JsonRpcMessageSchema.parse({ jsonrpc: "2.0", id: 1, result })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result,
    });
  });

  it("validates the documented session and turn examples", () => {
    const start: ReturnType<typeof SessionStartResultSchema.parse> = {
      session: {
        id: "session_1",
        cwd: "/workspace",
        model: "faux-model",
        status: "settled",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        lastEntryId: "entry_9",
        title: "New session",
      },
      sandbox: { backend: "none", mode: "workspace-write", network: "none" },
    };
    expect(SessionStartResultSchema.parse(start)).toEqual(start);

    expect(SessionListResultSchema.parse({ sessions: [start.session] })).toEqual({
      sessions: [start.session],
    });
    const meta: ReturnType<typeof SessionForkResultSchema.parse>["session"] = {
      id: start.session.id,
      cwd: start.session.cwd,
      model: start.session.model,
      createdAt: start.session.createdAt,
      title: start.session.title,
    };
    expect(SessionForkResultSchema.parse({ session: meta })).toEqual({ session: meta });
    expect(PROTOCOL_METHODS["session.start"].result.parse(start)).toEqual(start);
  });

  it("accepts an optional LLM endpoint for start and resume", () => {
    const llm = {
      baseUrl: "http://127.0.0.1:59000/v1",
      model: "local-model",
      apiKey: "secret-key",
      contextWindow: 32_768,
    };
    expect(
      PROTOCOL_METHODS["session.start"].params.parse({ cwd: "/workspace", llm }),
    ).toMatchObject({ llm });
    expect(
      PROTOCOL_METHODS["session.resume"].params.parse({ sessionId: "session_1", llm }),
    ).toMatchObject({ llm });

    const start = PROTOCOL_METHODS["session.start"].params;
    expect(start.safeParse({ cwd: "/workspace", llm: { baseUrl: "", model: "m" } }).success).toBe(
      false,
    );
    expect(
      start.safeParse({ cwd: "/workspace", llm: { baseUrl: "http://x/v1", model: "" } }).success,
    ).toBe(false);
    expect(
      start.safeParse({
        cwd: "/workspace",
        llm: { baseUrl: "http://x/v1", model: "m", contextWindow: 0 },
      }).success,
    ).toBe(false);
  });

  it("accepts the optional tools flag and leaves it undefined by default", () => {
    const start = PROTOCOL_METHODS["session.start"].params;
    const base = { baseUrl: "http://x/v1", model: "m" };
    expect(start.parse({ cwd: "/workspace", llm: base }).llm).toEqual(base);
    expect(start.parse({ cwd: "/workspace", llm: { ...base, tools: false } }).llm).toEqual({
      ...base,
      tools: false,
    });
    expect(start.parse({ cwd: "/workspace", llm: { ...base, tools: true } }).llm).toEqual({
      ...base,
      tools: true,
    });
    expect(start.safeParse({ cwd: "/workspace", llm: { ...base, tools: "no" } }).success).toBe(
      false,
    );
  });

  it("rejects invalid sandbox selections and turn text", () => {
    expect(
      PROTOCOL_METHODS["sandbox.mode"].params.safeParse({
        sessionId: "session_1",
        mode: "root",
      }).success,
    ).toBe(false);
    expect(
      PROTOCOL_METHODS["turn.start"].params.safeParse({ sessionId: "session_1", text: "" }).success,
    ).toBe(false);
    expect(
      PROTOCOL_METHODS["approval.respond"].params.safeParse({
        sessionId: "session_1",
        approvalId: "approval_1",
        decision: "allow",
      }).success,
    ).toBe(false);
  });

  it("preserves the JSON-RPC error shape, including null ids", () => {
    const error = {
      jsonrpc: "2.0" as const,
      id: null,
      error: { code: PROTOCOL_ERROR_CODES.parseError, message: "parse error" },
    };
    expect(JsonRpcErrorResponseSchema.parse(error)).toEqual(error);
    expect(JsonRpcMessageSchema.parse(error)).toEqual(error);

    const withData = {
      jsonrpc: "2.0" as const,
      id: "request-1",
      error: {
        code: PROTOCOL_ERROR_CODES.sessionNotFound,
        message: "session not found: session_9",
        data: { sessionId: "session_9" },
      },
    };
    expect(JsonRpcErrorResponseSchema.parse(withData)).toEqual(withData);
  });

  it("accepts fork overrides and the compact and side-question methods", () => {
    const llm = {
      baseUrl: "http://127.0.0.1:59000/v1",
      model: "override-model",
      apiKey: "secret-key",
    };
    expect(
      PROTOCOL_METHODS["session.fork"].params.parse({
        sessionId: "session_1",
        entryId: "entry_1",
        model: "override-model",
        llm,
        cwd: "/workspace/next",
      }),
    ).toEqual({
      sessionId: "session_1",
      entryId: "entry_1",
      model: "override-model",
      llm,
      cwd: "/workspace/next",
    });
    expect(
      PROTOCOL_METHODS["session.fork"].params.safeParse({
        sessionId: "session_1",
        entryId: "entry_1",
        cwd: "",
      }).success,
    ).toBe(false);

    expect(PROTOCOL_METHODS["session.compact"].params.parse({ sessionId: "session_1" })).toEqual({
      sessionId: "session_1",
    });
    const compacted = {
      compacted: true,
      tokensBefore: 900,
      tokensAfter: 120,
    };
    expect(PROTOCOL_METHODS["session.compact"].result.parse(compacted)).toEqual(compacted);

    const btw = { text: "answer", usage: { inputTokens: 5, outputTokens: 2 } };
    expect(
      PROTOCOL_METHODS["session.btw"].params.parse({ sessionId: "session_1", text: "why?" }),
    ).toEqual({ sessionId: "session_1", text: "why?" });
    expect(PROTOCOL_METHODS["session.btw"].result.parse(btw)).toEqual(btw);
    expect(
      PROTOCOL_METHODS["session.btw"].params.safeParse({ sessionId: "session_1", text: "" })
        .success,
    ).toBe(false);
  });

  it("distinguishes requests from notifications and responses", () => {
    expect(isJsonRpcRequest(request("initialize", {}))).toBe(true);
    expect(isJsonRpcRequest({ jsonrpc: "2.0", method: "event", params: {} })).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: "2.0", id: 1, result: {} })).toBe(false);
    expect(
      JsonRpcMessageSchema.parse({
        jsonrpc: "2.0",
        method: "event",
        params: { subscriptionId: "sub_1", event: { type: "settled" } },
      }),
    ).toBeDefined();
  });

  it("uses stable numeric error codes", () => {
    expect(PROTOCOL_ERROR_CODES).toEqual({
      parseError: -32700,
      invalidRequest: -32600,
      methodNotFound: -32601,
      invalidParams: -32602,
      internalError: -32603,
      sessionNotFound: 1001,
      sessionNotSettled: 1002,
      approvalNotFound: 1003,
      sandboxNotConfigured: 1004,
    });
  });

  it("keeps the method registry and method enum in sync", () => {
    const registered = Object.keys(PROTOCOL_METHODS)
      .map((method) => ProtocolMethodSchema.parse(method))
      .sort();
    const declared = [...ProtocolMethodSchema.options].sort();
    expect(declared).toEqual(registered);
  });

  it("validates event notifications against the agent event schema", () => {
    const params: ReturnType<typeof EventNotificationParamsSchema.parse> = {
      subscriptionId: "subscription_1",
      event: {
        sessionId: "session_1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "sandbox_policy",
        backend: "none",
        mode: "read-only",
        network: "none",
        reason: "session started",
      },
    };
    expect(EventNotificationParamsSchema.parse(params)).toEqual(params);
    expect(
      EventNotificationParamsSchema.safeParse({
        ...params,
        event: { ...params.event, mode: "root" },
      }).success,
    ).toBe(false);
  });
});
