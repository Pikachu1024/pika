import type { Tool, ToolContext, ToolOutput } from "@pika-harness/core";
import { z } from "zod";
import type { SkillCatalog } from "./discovery.js";

export const LOAD_SKILL_TOOL_NAME = "load_skill";

export const LoadSkillArgsSchema = z.object({
  name: z.string().min(1),
});

export type LoadSkillArgs = z.infer<typeof LoadSkillArgsSchema>;

/** Creates the tool the model calls to pull a selected skill body into context. */
export function createLoadSkillTool(catalog: SkillCatalog): Tool {
  return {
    name: LOAD_SKILL_TOOL_NAME,
    description:
      "Load the full instructions of a skill listed in the skill index. Call this only when the skill is relevant to the current task.",
    schema: LoadSkillArgsSchema,
    async execute(_context: ToolContext, rawArgs: unknown): Promise<ToolOutput> {
      const args = rawArgs as LoadSkillArgs;
      const descriptor = catalog.list().find((skill) => skill.name === args.name);
      if (descriptor === undefined) {
        return {
          content: [{ type: "text", text: `unknown skill: ${args.name}` }],
          isError: true,
        };
      }
      try {
        const body = await catalog.load(args.name);
        return {
          content: [{ type: "text", text: body }],
          isError: false,
          details: { name: descriptor.name, scope: descriptor.scope },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `failed to load skill ${args.name}: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
