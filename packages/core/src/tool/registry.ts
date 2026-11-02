import { z } from "zod";
import type { ProviderTool } from "../provider.js";
import type { Tool } from "../tools.js";

/** Holds the tools available to a session and exposes them to the provider. */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  /** Registers a tool and rejects duplicate names. */
  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  /** Returns the tool registered under the given name, if any. */
  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  /** Returns every registered tool in registration order. */
  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /** Converts registered tools into provider-facing declarations. */
  toProviderTools(): ProviderTool[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema),
    }));
  }
}
