import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, ToolOutput } from "@pika-harness/core";
import type { ContentPart } from "@pika-harness/schema";
import { z } from "zod";
import { isServerTrusted, isToolExposed, type McpServerConfig, namespaceTool } from "./config.js";
import {
  createDefaultMcpConnectionFactory,
  type McpClientLike,
  type McpConnection,
  type McpConnectionFactory,
  type McpToolInfo,
} from "./connection.js";

export type McpServerState = "starting" | "ready" | "unavailable" | "stopped" | "blocked";

export interface McpServerStatus {
  name: string;
  scope: "user" | "project";
  state: McpServerState;
  toolCount: number;
  error?: string;
}

/** A namespaced MCP tool ready for registration. */
export interface McpToolDescriptor {
  server: string;
  name: string;
  namespacedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpReconnectOptions {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
}

export interface McpManagerOptions {
  servers: readonly McpServerConfig[];
  /** Project-scoped servers stay blocked until this is true. */
  projectTrusted?: boolean;
  connectionFactory?: McpConnectionFactory;
  connectTimeoutMs?: number;
  reconnect?: McpReconnectOptions;
  sourceEnv?: NodeJS.ProcessEnv;
  deniedEnvNames?: readonly string[];
  /** Passed to HTTP servers whose config enables OAuth. */
  oauthProvider?: OAuthClientProvider;
}

export interface McpManager {
  start(): Promise<void>;
  statuses(): McpServerStatus[];
  tools(): McpToolDescriptor[];
  /** Builds Tool adapters; the returned tools delegate to the live connection. */
  createTools(): Tool[];
  /** Re-lists tools for every ready server. */
  refresh(): Promise<void>;
  /** Closes the current connection, if any, and connects again. */
  reconnect(serverName: string): Promise<boolean>;
  close(): Promise<void>;
}

interface ServerEntry {
  config: McpServerConfig;
  state: McpServerState;
  error: string | undefined;
  tools: McpToolInfo[];
  connection: McpConnection | undefined;
  attempts: number;
  timer: NodeJS.Timeout | undefined;
  connecting: Promise<boolean> | undefined;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
} as const;

/** Creates an MCP manager that isolates server failures from the session. */
export function createMcpManager(options: McpManagerOptions): McpManager {
  return new DefaultMcpManager(options);
}

class DefaultMcpManager implements McpManager {
  readonly #entries: ServerEntry[];
  readonly #factory: McpConnectionFactory;
  readonly #trusted: boolean;
  readonly #connectTimeoutMs: number;
  readonly #reconnect: Required<McpReconnectOptions>;
  readonly #sourceEnv: NodeJS.ProcessEnv;
  readonly #deniedEnvNames: readonly string[];
  readonly #oauthProvider: OAuthClientProvider | undefined;
  #started = false;
  #closed = false;

  constructor(options: McpManagerOptions) {
    this.#entries = options.servers.map((config) => ({
      config,
      state: "unavailable",
      error: undefined,
      tools: [],
      connection: undefined,
      attempts: 0,
      timer: undefined,
      connecting: undefined,
    }));
    this.#factory =
      options.connectionFactory ??
      createDefaultMcpConnectionFactory({
        ...(options.sourceEnv === undefined ? {} : { sourceEnv: options.sourceEnv }),
        ...(options.deniedEnvNames === undefined ? {} : { deniedEnvNames: options.deniedEnvNames }),
        ...(options.oauthProvider === undefined ? {} : { oauthProvider: options.oauthProvider }),
      });
    this.#oauthProvider = options.oauthProvider;
    this.#trusted = options.projectTrusted ?? false;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#reconnect = {
      enabled: options.reconnect?.enabled ?? DEFAULT_RECONNECT.enabled,
      initialDelayMs: options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
      maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
      factor: options.reconnect?.factor ?? DEFAULT_RECONNECT.factor,
    };
    this.#sourceEnv = options.sourceEnv ?? process.env;
    this.#deniedEnvNames = options.deniedEnvNames ?? [];
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("MCP manager is closed");
    if (this.#started) return;
    this.#started = true;
    for (const entry of this.#entries) {
      if (!isServerTrusted(entry.config, this.#trusted)) {
        entry.state = "blocked";
        entry.error = "project is not trusted";
        continue;
      }
      await this.#connect(entry);
    }
  }

  statuses(): McpServerStatus[] {
    return this.#entries.map((entry) => ({
      name: entry.config.name,
      scope: entry.config.scope,
      state: entry.state,
      toolCount: entry.tools.length,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));
  }

  tools(): McpToolDescriptor[] {
    const descriptors: McpToolDescriptor[] = [];
    for (const entry of this.#entries) {
      if (entry.state !== "ready") continue;
      for (const tool of entry.tools) {
        descriptors.push({
          server: entry.config.name,
          name: tool.name,
          namespacedName: namespaceTool(entry.config.name, tool.name),
          description: tool.description ?? `MCP tool ${tool.name} from ${entry.config.name}`,
          inputSchema: tool.inputSchema,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
    }
    return descriptors;
  }

  createTools(): Tool[] {
    const tools: Tool[] = [];
    for (const entry of this.#entries) {
      if (entry.state !== "ready") continue;
      for (const info of entry.tools) {
        tools.push(createMcpTool(entry, info));
      }
    }
    return tools;
  }

  async refresh(): Promise<void> {
    for (const entry of this.#entries) {
      if (entry.state === "ready") await this.#refresh(entry);
    }
  }

  async reconnect(serverName: string): Promise<boolean> {
    if (this.#closed) return false;
    const entry = this.#entries.find((candidate) => candidate.config.name === serverName);
    if (entry === undefined || !isServerTrusted(entry.config, this.#trusted)) return false;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.connection !== undefined) {
      const connection = entry.connection;
      entry.connection = undefined;
      await connection.close().catch(() => undefined);
    }
    entry.attempts = 0;
    entry.tools = [];
    entry.state = "unavailable";
    return this.#connect(entry);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      this.#entries.map(async (entry) => {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
        entry.state = "stopped";
        entry.tools = [];
        const connection = entry.connection;
        entry.connection = undefined;
        await connection?.close().catch(() => undefined);
      }),
    );
  }

  async #connect(entry: ServerEntry): Promise<boolean> {
    if (entry.connecting !== undefined) return entry.connecting;
    const attempt = this.#doConnect(entry);
    entry.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (entry.connecting === attempt) entry.connecting = undefined;
    }
  }

  async #doConnect(entry: ServerEntry): Promise<boolean> {
    if (this.#closed) return false;
    entry.state = "starting";
    entry.error = undefined;
    let connection: McpConnection | undefined;
    try {
      connection = await withTimeout(
        this.#factory({
          server: entry.config,
          sourceEnv: this.#sourceEnv,
          deniedEnvNames: this.#deniedEnvNames,
          ...(this.#oauthProvider === undefined ? {} : { oauthProvider: this.#oauthProvider }),
        }),
        this.#connectTimeoutMs,
        `MCP server ${entry.config.name} did not start in time`,
      );
      if (this.#closed) {
        await connection.close().catch(() => undefined);
        return false;
      }
      entry.connection = connection;
      const client = connection.client;
      client.onclose = () => {
        if (entry.connection === connection) this.#disconnect(entry, "connection closed");
      };
      client.onerror = (error) => {
        if (entry.connection === connection) this.#disconnect(entry, error.message);
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.#refresh(entry));
      entry.tools = filterExposed(entry.config, await listAllTools(client));
      entry.state = "ready";
      entry.attempts = 0;
      return true;
    } catch (error) {
      if (connection !== undefined && entry.connection === connection) {
        entry.connection = undefined;
        await connection.close().catch(() => undefined);
      }
      entry.state = "unavailable";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.tools = [];
      this.#scheduleReconnect(entry);
      return false;
    }
  }

  #disconnect(entry: ServerEntry, reason: string): void {
    if (this.#closed || entry.state === "stopped") return;
    const connection = entry.connection;
    entry.connection = undefined;
    entry.tools = [];
    entry.state = "unavailable";
    entry.error = reason;
    void connection?.close().catch(() => undefined);
    this.#scheduleReconnect(entry);
  }

  #scheduleReconnect(entry: ServerEntry): void {
    if (!this.#reconnect.enabled || this.#closed || entry.timer !== undefined) return;
    if (!isServerTrusted(entry.config, this.#trusted)) return;
    entry.attempts += 1;
    const delay = Math.min(
      this.#reconnect.maxDelayMs,
      this.#reconnect.initialDelayMs * this.#reconnect.factor ** (entry.attempts - 1),
    );
    const timer = setTimeout(() => {
      entry.timer = undefined;
      void this.#connect(entry);
    }, delay);
    timer.unref?.();
    entry.timer = timer;
  }

  async #refresh(entry: ServerEntry): Promise<void> {
    const connection = entry.connection;
    if (connection === undefined) return;
    try {
      entry.tools = filterExposed(entry.config, await listAllTools(connection.client));
      entry.state = "ready";
      entry.error = undefined;
    } catch (error) {
      this.#disconnect(
        entry,
        `failed to list tools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function createMcpTool(entry: ServerEntry, info: McpToolInfo): Tool {
  return {
    name: namespaceTool(entry.config.name, info.name),
    description: info.description ?? `MCP tool ${info.name} from ${entry.config.name}`,
    schema: z.record(z.string(), z.unknown()),
    parameters: info.inputSchema,
    sandbox: {
      // Unknown side effects are treated as writes so untrusted sessions ask first.
      write: info.annotations?.readOnlyHint !== true,
      arbitraryProcess: false,
    },
    async execute(context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const connection = entry.connection;
      if (connection === undefined || entry.state !== "ready") {
        return errorOutput(`MCP server ${entry.config.name} is unavailable`);
      }
      if (context.signal.aborted) {
        return errorOutput("MCP tool call aborted");
      }
      try {
        const args =
          typeof rawArgs === "object" && rawArgs !== null
            ? (rawArgs as Record<string, unknown>)
            : {};
        const result = await connection.client.callTool(
          { name: info.name, arguments: args },
          undefined,
          { signal: context.signal },
        );
        return {
          content: toContentParts(result.content ?? [], result.structuredContent, info.name),
          isError: result.isError === true,
          details: {
            server: entry.config.name,
            tool: info.name,
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent }),
          },
        };
      } catch (error) {
        return errorOutput(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function filterExposed(config: McpServerConfig, tools: McpToolInfo[]): McpToolInfo[] {
  return tools.filter((tool) => isToolExposed(tool.name, config, config.name));
}

async function listAllTools(client: McpClientLike): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor });
    for (const tool of result.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
    if (result.nextCursor === undefined) break;
    cursor = result.nextCursor;
  }
  return tools;
}

function toContentParts(
  content: unknown[],
  structuredContent: Record<string, unknown> | undefined,
  toolName: string,
): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string") {
      parts.push({
        type: "image",
        mediaType: typeof part.mimeType === "string" ? part.mimeType : "image/png",
        data: part.data,
      });
    } else if (part.type === "resource" && typeof part.resource === "object") {
      const resource = part.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        parts.push({ type: "text", text: resource.text });
      } else if (typeof resource.uri === "string") {
        parts.push({ type: "text", text: `resource ${resource.uri}` });
      }
    } else if (part.type === "resource_link" && typeof part.uri === "string") {
      const name = typeof part.name === "string" ? part.name : part.uri;
      parts.push({ type: "text", text: `${name}: ${part.uri}` });
    } else {
      parts.push({ type: "text", text: JSON.stringify(part) });
    }
  }
  if (parts.length === 0) {
    parts.push({
      type: "text",
      text:
        structuredContent === undefined
          ? `MCP tool ${toolName} returned no content`
          : JSON.stringify(structuredContent),
    });
  }
  return parts;
}

function errorOutput(message: string): ToolOutput {
  return {
    content: [{ type: "error", message, code: "mcp_error" }],
    isError: true,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
