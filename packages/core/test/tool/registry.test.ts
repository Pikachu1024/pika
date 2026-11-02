import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/tool/registry.js";
import type { Tool, ToolOutput } from "../../src/tools.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({ path: z.string().describe("file path") }),
    async execute(): Promise<ToolOutput> {
      return { content: [{ type: "text", text: name }], isError: false };
    },
  };
}

describe("ToolRegistry", () => {
  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("read_file"));

    expect(() => registry.register(makeTool("read_file"))).toThrow(/already registered/);
    expect(registry.list()).toHaveLength(1);
  });

  it("gets tools by name and lists them in registration order", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("write_file"));
    registry.register(makeTool("read_file"));
    registry.register(makeTool("grep"));

    expect(registry.list().map((tool) => tool.name)).toEqual(["write_file", "read_file", "grep"]);
    expect(registry.get("read_file")?.name).toBe("read_file");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("converts tools into provider declarations with JSON schema parameters", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("read_file"));

    const providerTools = registry.toProviderTools();

    expect(providerTools).toHaveLength(1);
    expect(providerTools[0]).toMatchObject({
      name: "read_file",
      description: "read_file tool",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "file path" } },
        required: ["path"],
      },
    });
  });
});
