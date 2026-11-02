import { z } from "zod";

export const McpServerNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "server names may contain letters, digits, '_' and '-'");

const BaseServerFields = {
  name: McpServerNameSchema,
  /** Project servers require project trust before they can start. */
  scope: z.enum(["user", "project"]).default("user"),
  /** Glob patterns; when present only matching tools are exposed. */
  allow: z.array(z.string().min(1)).optional(),
  /** Glob patterns; matching tools are always hidden. */
  deny: z.array(z.string().min(1)).optional(),
};

export const StdioMcpServerSchema = z.object({
  ...BaseServerFields,
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  /** Explicit values; never inherited from the parent process. */
  env: z.record(z.string(), z.string()).optional(),
  /** Names forwarded from the harness environment through the allowlist. */
  envAllowlist: z.array(z.string().min(1)).optional(),
});

export const HttpMcpServerSchema = z.object({
  ...BaseServerFields,
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Set to true to require an injected OAuth provider before connecting. */
  oauth: z.boolean().optional(),
});

export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  StdioMcpServerSchema,
  HttpMcpServerSchema,
]);

export const McpConfigSchema = z.object({
  servers: z.array(McpServerConfigSchema),
});

export type StdioMcpServerConfig = z.infer<typeof StdioMcpServerSchema>;
export type HttpMcpServerConfig = z.infer<typeof HttpMcpServerSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** Parses and validates a project or user MCP configuration document. */
export function parseMcpConfig(input: unknown): McpConfig {
  return McpConfigSchema.parse(input);
}

/** Namespaces a server tool so two servers cannot collide. */
export function namespaceTool(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Returns true when a tool passes the server's allow and deny rules. */
export function isToolExposed(
  toolName: string,
  rule: { allow?: readonly string[] | undefined; deny?: readonly string[] | undefined },
  serverName?: string,
): boolean {
  const names =
    serverName === undefined ? [toolName] : [toolName, namespaceTool(serverName, toolName)];
  if (rule.deny?.some((pattern) => names.some((name) => globMatches(pattern, name))) === true) {
    return false;
  }
  if (rule.allow === undefined || rule.allow.length === 0) {
    return true;
  }
  return rule.allow.some((pattern) => names.some((name) => globMatches(pattern, name)));
}

/** Project-scoped servers stay stopped until the project is trusted. */
export function isServerTrusted(config: McpServerConfig, projectTrusted: boolean): boolean {
  return config.scope !== "project" || projectTrusted;
}

function globMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .split("")
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${expression}$`).test(value);
}
