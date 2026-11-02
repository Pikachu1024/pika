import { describe, expect, it } from "bun:test";
import {
  createDefaultMcpConnectionFactory,
  isServerTrusted,
  isToolExposed,
  parseMcpConfig,
} from "../../src/index.js";

const documentedConfig = {
  servers: [
    {
      name: "filesystem",
      scope: "user",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      envAllowlist: ["PATH", "HOME"],
      allow: ["read_*"],
      deny: ["write_*"],
    },
    {
      name: "github",
      scope: "project",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      oauth: true,
      headers: { "X-Trace": "pika" },
    },
  ],
};

describe("MCP configuration", () => {
  it("loads the documented configuration", () => {
    const config = parseMcpConfig(documentedConfig);

    expect(config.servers).toHaveLength(2);
    expect(config.servers[0]).toMatchObject({
      name: "filesystem",
      scope: "user",
      transport: "stdio",
      command: "npx",
      allow: ["read_*"],
      deny: ["write_*"],
    });
    expect(config.servers[1]).toMatchObject({
      name: "github",
      scope: "project",
      transport: "http",
      oauth: true,
    });
  });

  it("defaults scope to user and rejects invalid server names", () => {
    const config = parseMcpConfig({
      servers: [{ name: "local", transport: "stdio", command: "server" }],
    });
    expect(config.servers[0]?.scope).toBe("user");

    expect(() =>
      parseMcpConfig({
        servers: [{ name: "bad name", transport: "stdio", command: "server" }],
      }),
    ).toThrow();
  });

  it("applies allow and deny glob rules to raw and namespaced names", () => {
    expect(isToolExposed("read_file", { allow: ["read_*"] })).toBe(true);
    expect(isToolExposed("write_file", { allow: ["read_*"] })).toBe(false);
    expect(isToolExposed("read_file", {}, "docs")).toBe(true);
    expect(isToolExposed("read_file", { allow: ["mcp__docs__read_????"] }, "docs")).toBe(true);
    expect(isToolExposed("read_file", { deny: ["read_*"] })).toBe(false);
    expect(isToolExposed("read_file", { allow: ["read_*"], deny: ["read_*"] })).toBe(false);
  });

  it("requires project trust only for project-scoped servers", () => {
    expect(
      isServerTrusted({ name: "u", scope: "user", transport: "stdio", command: "x" }, false),
    ).toBe(true);
    expect(
      isServerTrusted({ name: "p", scope: "project", transport: "stdio", command: "x" }, false),
    ).toBe(false);
    expect(
      isServerTrusted({ name: "p", scope: "project", transport: "stdio", command: "x" }, true),
    ).toBe(true);
  });

  it("fails closed when OAuth is required without a provider", async () => {
    const factory = createDefaultMcpConnectionFactory();
    await expect(
      factory({
        server: {
          name: "remote",
          scope: "user",
          transport: "http",
          url: "https://example.test/mcp",
          oauth: true,
        },
        sourceEnv: {},
        deniedEnvNames: [],
      }),
    ).rejects.toThrow(/requires OAuth/);
  });
});
