import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { buildProcessEnvironment } from "../sandbox/node-executor.js";
import type { McpServerConfig } from "./config.js";

/** Tool metadata as returned by `tools/list`. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/** The subset of the MCP client used by the manager. */
export interface McpClientLike {
  listTools(
    params?: { cursor?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ tools: McpToolInfo[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{
    content?: unknown[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
  setNotificationHandler(schema: unknown, handler: () => void | Promise<void>): void;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

/** An initialized MCP client plus its transport lifetime. */
export interface McpConnection {
  client: McpClientLike;
  close(): Promise<void>;
}

export interface McpConnectionContext {
  server: McpServerConfig;
  sourceEnv: NodeJS.ProcessEnv;
  deniedEnvNames: readonly string[];
  oauthProvider?: OAuthClientProvider | undefined;
}

export type McpConnectionFactory = (context: McpConnectionContext) => Promise<McpConnection>;

export interface DefaultMcpConnectionFactoryOptions {
  /** Environment consulted for allowlisted names; defaults to `process.env`. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Extra names that are never forwarded even when allowlisted. */
  deniedEnvNames?: readonly string[];
  /** Required when an HTTP server config sets `oauth: true`. */
  oauthProvider?: OAuthClientProvider;
  clientInfo?: Implementation;
  clientOptions?: ClientOptions;
  /** Default allowlist for stdio servers; still filtered for credential-shaped names. */
  defaultEnvAllowlist?: readonly string[];
}

const DEFAULT_STDIO_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "TERM"] as const;

/** Creates connections with the official MCP SDK and an explicit child environment. */
export function createDefaultMcpConnectionFactory(
  options: DefaultMcpConnectionFactoryOptions = {},
): McpConnectionFactory {
  const sourceEnv = options.sourceEnv ?? process.env;
  const clientInfo = options.clientInfo ?? { name: "pika-harness", version: "0.0.0" };

  return async ({ server, deniedEnvNames, oauthProvider }) => {
    const client = new Client(clientInfo, options.clientOptions);
    let transport: Transport;

    if (server.transport === "stdio") {
      const allowlist =
        server.envAllowlist ?? options.defaultEnvAllowlist ?? DEFAULT_STDIO_ENV_ALLOWLIST;
      const env = {
        ...buildProcessEnvironment({ envAllowlist: allowlist }, sourceEnv, deniedEnvNames),
        ...server.env,
      };
      transport = new StdioClientTransport({
        command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        env,
        // Server stderr may include credentials; it is never forwarded to logs.
        stderr: "ignore",
      });
    } else {
      const provider = oauthProvider ?? options.oauthProvider;
      if (server.oauth === true && provider === undefined) {
        throw new Error(
          `MCP server ${server.name} requires OAuth but no auth provider was supplied`,
        );
      }
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        ...(provider === undefined ? {} : { authProvider: provider }),
        ...(server.headers === undefined ? {} : { requestInit: { headers: server.headers } }),
      });
    }

    await client.connect(transport);
    return {
      client: client as unknown as McpClientLike,
      close: () => client.close(),
    };
  };
}
