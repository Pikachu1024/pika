import { z } from "zod";
import { AgentEventSchema } from "./events.js";
import { ApprovalIdSchema, EntryIdSchema, SessionIdSchema } from "./ids.js";
import { NetworkPolicySchema, SandboxBackendSchema, SandboxModeSchema } from "./sandbox.js";
import { SessionMetaSchema, SessionSummarySchema } from "./sessions.js";

export const PROTOCOL_VERSION = 1;

export const JsonRpcIdSchema = z.union([z.string().min(1), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string().min(1),
  data: z.unknown().optional(),
});

export const JsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema,
  result: z.unknown(),
});

export const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: JsonRpcIdSchema.nullable(),
  error: JsonRpcErrorObjectSchema,
});

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);

export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcResponseSchema,
]);

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

export const PROTOCOL_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  sessionNotFound: 1001,
  sessionNotSettled: 1002,
  approvalNotFound: 1003,
  sandboxNotConfigured: 1004,
} as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[keyof typeof PROTOCOL_ERROR_CODES];

/** One JSON-RPC endpoint; implementations frame the messages for their medium. */
export interface ProtocolTransport {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): () => void;
  onClose?(handler: () => void): () => void;
  close(): void | Promise<void>;
}

export const SandboxSelectionSchema = z.object({
  mode: SandboxModeSchema.optional(),
  network: NetworkPolicySchema.optional(),
});
export type SandboxSelection = z.infer<typeof SandboxSelectionSchema>;

export const EffectiveSandboxSchema = z.object({
  backend: SandboxBackendSchema,
  mode: SandboxModeSchema,
  network: NetworkPolicySchema,
});
export type EffectiveSandbox = z.infer<typeof EffectiveSandboxSchema>;

export const InitializeParamsSchema = z.object({
  clientName: z.string().min(1).optional(),
  protocolVersion: z.number().int().positive().optional(),
});
export const InitializeResultSchema = z.object({
  protocolVersion: z.number().int().positive(),
  serverName: z.string().min(1),
  capabilities: z.object({
    transports: z.array(z.enum(["stdio", "websocket", "in-process"])),
  }),
});
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

export const SessionStartParamsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1).optional(),
  sandbox: SandboxSelectionSchema.optional(),
});
export const SessionStartResultSchema = z.object({
  session: SessionSummarySchema,
  sandbox: EffectiveSandboxSchema,
});
export type SessionStartResult = z.infer<typeof SessionStartResultSchema>;

export const SessionResumeParamsSchema = z.object({ sessionId: SessionIdSchema });
export const SessionResumeResultSchema = SessionStartResultSchema;

export const SessionForkParamsSchema = z.object({
  sessionId: SessionIdSchema,
  entryId: EntryIdSchema,
});
export const SessionForkResultSchema = z.object({ session: SessionMetaSchema });
export type SessionForkResult = z.infer<typeof SessionForkResultSchema>;

export const SessionListParamsSchema = z.object({});
export const SessionListResultSchema = z.object({
  sessions: z.array(SessionSummarySchema),
});
export type SessionListResult = z.infer<typeof SessionListResultSchema>;

const TurnParamsSchema = z.object({
  sessionId: SessionIdSchema,
  text: z.string().min(1),
});
export const TurnStartParamsSchema = TurnParamsSchema;
export const TurnSteerParamsSchema = TurnParamsSchema;
export const TurnFollowUpParamsSchema = TurnParamsSchema;
export const TurnInterruptParamsSchema = z.object({
  sessionId: SessionIdSchema,
  reason: z.string().optional(),
});
export const TurnAcceptedResultSchema = z.object({ accepted: z.literal(true) });

export const ApprovalRespondParamsSchema = z.object({
  sessionId: SessionIdSchema,
  approvalId: ApprovalIdSchema,
  decision: z.enum(["approve", "approve_for_session", "deny"]),
});
export const ApprovalRespondResultSchema = z.object({ accepted: z.literal(true) });

export const SubscribeParamsSchema = z.object({ sessionId: SessionIdSchema });
export const SubscribeResultSchema = z.object({
  subscriptionId: z.string().min(1),
});
export const UnsubscribeParamsSchema = z.object({
  subscriptionId: z.string().min(1),
});
export const UnsubscribeResultSchema = z.object({ removed: z.boolean() });

export const SandboxModeParamsSchema = z.object({
  sessionId: SessionIdSchema,
  mode: SandboxModeSchema,
  network: NetworkPolicySchema.optional(),
});
export const SandboxModeResultSchema = EffectiveSandboxSchema;

export const EventNotificationParamsSchema = z.object({
  subscriptionId: z.string().min(1),
  event: AgentEventSchema,
});
export type EventNotificationParams = z.infer<typeof EventNotificationParamsSchema>;

export const PROTOCOL_METHODS = {
  initialize: {
    params: InitializeParamsSchema,
    result: InitializeResultSchema,
  },
  "session.start": {
    params: SessionStartParamsSchema,
    result: SessionStartResultSchema,
  },
  "session.resume": {
    params: SessionResumeParamsSchema,
    result: SessionResumeResultSchema,
  },
  "session.fork": {
    params: SessionForkParamsSchema,
    result: SessionForkResultSchema,
  },
  "session.list": {
    params: SessionListParamsSchema,
    result: SessionListResultSchema,
  },
  "turn.start": {
    params: TurnStartParamsSchema,
    result: TurnAcceptedResultSchema,
  },
  "turn.steer": {
    params: TurnSteerParamsSchema,
    result: TurnAcceptedResultSchema,
  },
  "turn.follow_up": {
    params: TurnFollowUpParamsSchema,
    result: TurnAcceptedResultSchema,
  },
  "turn.interrupt": {
    params: TurnInterruptParamsSchema,
    result: TurnAcceptedResultSchema,
  },
  "approval.respond": {
    params: ApprovalRespondParamsSchema,
    result: ApprovalRespondResultSchema,
  },
  subscribe: {
    params: SubscribeParamsSchema,
    result: SubscribeResultSchema,
  },
  unsubscribe: {
    params: UnsubscribeParamsSchema,
    result: UnsubscribeResultSchema,
  },
  "sandbox.mode": {
    params: SandboxModeParamsSchema,
    result: SandboxModeResultSchema,
  },
} as const;

export type ProtocolMethod = keyof typeof PROTOCOL_METHODS;

export const ProtocolMethodSchema = z.enum([
  "initialize",
  "session.start",
  "session.resume",
  "session.fork",
  "session.list",
  "turn.start",
  "turn.steer",
  "turn.follow_up",
  "turn.interrupt",
  "approval.respond",
  "subscribe",
  "unsubscribe",
  "sandbox.mode",
]);

/** Narrows a decoded JSON-RPC message to a request that expects a response. */
export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}
