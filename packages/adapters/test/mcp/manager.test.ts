import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as SdkTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpClientLike, McpConnectionFactory, McpServerConfig } from "../../src/index.js";
import { createMcpManager } from "../../src/index.js";

interface FakeServer {
  client: Client;
  setTools(tools: SdkTool[]): void;
  notify(): Promise<void>;
  close(): Promise<void>;
}

const instances: FakeServer[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    await instance.close().catch(() => undefined);
  }
});

async function spawnFakeServer(tools: SdkTool[]): Promise<FakeServer> {
  const server = new Server(
    { name: "fake", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  let current = tools;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: current }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: "text",
        text: `echo ${request.params.name} ${JSON.stringify(request.params.arguments ?? {})}`,
      },
    ],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "pika-test", version: "1.0.0" });
  await client.connect(clientTransport);
  const fake: FakeServer = {
    client,
    setTools: (next) => {
      current = next;
    },
    notify: () => server.sendToolListChanged(),
    close: () => client.close(),
  };
  instances.push(fake);
  return fake;
}

function tool(name: string, properties: Record<string, object> = {}): SdkTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties },
  };
}

function factory(spawn: () => Promise<FakeServer>, calls: string[] = []): McpConnectionFactory {
  return async (context) => {
    calls.push(context.server.name);
    const fake = await spawn();
    return {
      client: fake.client as unknown as McpClientLike,
      close: () => fake.client.close(),
    };
  };
}

function stdio(name: string): McpServerConfig {
  return { name, scope: "user", transport: "stdio", command: "fake-mcp" };
}

const context = { signal: new AbortController().signal } as never;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("MCP manager", () => {
  it("namespaces tools, applies allow and deny rules, and blocks untrusted project servers", async () => {
    const calls: string[] = [];
    const fake = await spawnFakeServer([
      tool("read_file", { path: { type: "string" } }),
      tool("read_secret"),
      tool("write_file"),
    ]);
    const manager = createMcpManager({
      servers: [
        {
          name: "alpha",
          scope: "user",
          transport: "stdio",
          command: "fake-mcp",
          allow: ["read_*"],
          deny: ["read_secret"],
        },
        { name: "beta", scope: "project", transport: "http", url: "https://example.test/mcp" },
      ],
      projectTrusted: false,
      connectionFactory: factory(async () => fake, calls),
      reconnect: { enabled: false },
    });

    await manager.start();

    expect(calls).toEqual(["alpha"]);
    expect(manager.statuses()).toEqual([
      { name: "alpha", scope: "user", state: "ready", toolCount: 1 },
      {
        name: "beta",
        scope: "project",
        state: "blocked",
        toolCount: 0,
        error: "project is not trusted",
      },
    ]);
    expect(manager.tools().map((entry) => entry.namespacedName)).toEqual(["mcp__alpha__read_file"]);

    const tools = manager.createTools();
    const readFile = tools[0];
    expect(readFile?.name).toBe("mcp__alpha__read_file");
    expect(readFile?.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });

    const result = await readFile?.execute(context, { path: "a.txt" });
    expect(result?.isError).toBe(false);
    expect(result?.content).toEqual([{ type: "text", text: 'echo read_file {"path":"a.txt"}' }]);

    await manager.close();
    expect(manager.statuses().every((status) => status.state === "stopped")).toBe(true);
  });

  it("marks tools unavailable on a crash and rediscovers them after reconnect", async () => {
    let spawnCount = 0;
    const manager = createMcpManager({
      servers: [stdio("demo")],
      connectionFactory: factory(async () => {
        spawnCount += 1;
        return spawnFakeServer([tool(spawnCount === 1 ? "old_tool" : "new_tool")]);
      }),
      reconnect: { enabled: false },
    });

    await manager.start();
    expect(manager.tools()[0]?.namespacedName).toBe("mcp__demo__old_tool");
    const oldTool = manager.createTools()[0];

    await instances[0]?.close();
    await waitFor(() => manager.statuses()[0]?.state === "unavailable");

    expect(manager.tools()).toEqual([]);
    const failed = await oldTool?.execute(context, {});
    expect(failed?.isError).toBe(true);
    expect(failed?.content[0]).toMatchObject({ type: "error" });

    await expect(manager.reconnect("demo")).resolves.toBe(true);
    expect(manager.statuses()[0]?.state).toBe("ready");
    expect(manager.tools()[0]?.namespacedName).toBe("mcp__demo__new_tool");

    await manager.close();
  });

  it("reconnects automatically after a crash without restarting the manager", async () => {
    let spawnCount = 0;
    const manager = createMcpManager({
      servers: [stdio("demo")],
      connectionFactory: factory(async () => {
        spawnCount += 1;
        return spawnFakeServer([tool(spawnCount === 1 ? "first_tool" : "second_tool")]);
      }),
      reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 20 },
    });

    await manager.start();
    expect(spawnCount).toBe(1);

    await instances[0]?.close();
    await waitFor(
      () =>
        manager.statuses()[0]?.state === "ready" &&
        manager.tools()[0]?.namespacedName === "mcp__demo__second_tool",
    );
    expect(spawnCount).toBe(2);

    await manager.close();
  });

  it("refreshes tools after a tool-list-changed notification", async () => {
    const fake = await spawnFakeServer([tool("first")]);
    const manager = createMcpManager({
      servers: [stdio("demo")],
      connectionFactory: factory(async () => fake),
      reconnect: { enabled: false },
    });

    await manager.start();
    expect(manager.tools().map((entry) => entry.namespacedName)).toEqual(["mcp__demo__first"]);

    fake.setTools([tool("first"), tool("second")]);
    await fake.notify();
    await waitFor(() => manager.tools().length === 2);

    expect(manager.tools().map((entry) => entry.namespacedName)).toEqual([
      "mcp__demo__first",
      "mcp__demo__second",
    ]);

    await manager.close();
  });

  it("closes a connection that resolves after the connect timeout", async () => {
    let closed = false;
    const manager = createMcpManager({
      servers: [stdio("slow")],
      connectTimeoutMs: 5,
      reconnect: { enabled: false },
      connectionFactory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          client: {
            listTools: async () => ({ tools: [] }),
            callTool: async () => ({ content: [] }),
          } as unknown as McpClientLike,
          close: async () => {
            closed = true;
          },
        };
      },
    });

    await manager.start();
    expect(manager.statuses()[0]?.state).toBe("unavailable");

    await waitFor(() => closed);
    expect(manager.statuses()[0]?.state).toBe("unavailable");

    await manager.close();
  });

  it("does not start a project server unless the project is trusted", async () => {
    const calls: string[] = [];
    const fake = await spawnFakeServer([tool("run")]);
    const manager = createMcpManager({
      servers: [{ name: "project", scope: "project", transport: "stdio", command: "fake-mcp" }],
      projectTrusted: true,
      connectionFactory: factory(async () => fake, calls),
      reconnect: { enabled: false },
    });

    await manager.start();

    expect(calls).toEqual(["project"]);
    expect(manager.statuses()[0]).toMatchObject({ state: "ready", toolCount: 1 });
    expect(manager.tools()[0]?.namespacedName).toBe("mcp__project__run");

    await manager.close();
  });
});
