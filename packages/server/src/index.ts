// Public entry point for the session server, transports, and approval routing.

export type { RunningServe, ServeLlmOptions, ServeOptions } from "./serve.js";
export { parseServeArgs, serveMain, serveUsage, startServe } from "./serve.js";
export type {
  ResolvedServeSandbox,
  ServeSandboxDependencies,
  ServeSandboxSelection,
} from "./serve-sandbox.js";
export {
  createServeSandbox,
  isServeSandboxSelection,
  SERVE_SANDBOX_SELECTIONS,
} from "./serve-sandbox.js";
export type { ServeToolingOptions } from "./serve-tooling.js";
export { createServeTooling } from "./serve-tooling.js";
export type {
  CompactionFactory,
  ServerSandboxOptions,
  SessionContext,
  SessionServer,
  SessionServerOptions,
  SessionTooling,
  SessionToolingFactory,
} from "./session-server.js";
export { createSessionServer, DefaultSessionServer, ProtocolError } from "./session-server.js";
export type { StdioTransportOptions } from "./transports.js";
export {
  createInProcessTransportPair,
  parseError,
  StdioTransport,
} from "./transports.js";
export type {
  WebSocketServerHandle,
  WebSocketServerOptions,
} from "./websocket.js";
export { startWebSocketServer, WebSocketTransport } from "./websocket.js";
