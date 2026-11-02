import { describe, expect, it } from "vitest";
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

    const result = {
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
    const start = {
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
    const meta = {
      id: start.session.id,
      cwd: start.session.cwd,
      model: start.session.model,
      createdAt: start.session.createdAt,
      title: start.session.title,
    };
    expect(SessionForkResultSchema.parse({ session: meta })).toEqual({ session: meta });
    expect(PROTOCOL_METHODS["session.start"].result.parse(start)).toEqual(start);
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
    const registered = Object.keys(PROTOCOL_METHODS).sort();
    const declared = [...ProtocolMethodSchema.options].sort();
    expect(declared).toEqual(registered);
  });

  it("validates event notifications against the agent event schema", () => {
    const params = {
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
