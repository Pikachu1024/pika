import type { Usage } from "@pika-harness/schema";
import type { ContextProjector, ProjectionInput, ProjectionResult } from "../context.js";
import type { LlmMessage } from "../provider.js";
import { hashPrompt } from "./hash.js";
import { createContextProjector } from "./projection.js";
import { createTokenEstimator, estimateMessages } from "./token-estimator.js";

export interface ProjectionPipelineInput extends ProjectionInput {
  /** Ephemeral reminders injected into the last user message without touching the log. */
  reminders?: string[];
  /** Provider-specific conversion applied after reminders and before hashing. */
  convert?: (messages: LlmMessage[]) => LlmMessage[];
  /** Provider-reported usage for this request, including cache reads and writes. */
  usage?: Usage;
}

export interface ProjectionPipelineResult extends ProjectionResult {
  estimatedTokens: number;
  cache: {
    readTokens: number;
    writeTokens: number;
  };
}

export interface ProjectionPipeline {
  project(input: ProjectionPipelineInput): ProjectionPipelineResult;
}

export interface ProjectionPipelineOptions {
  projector?: ContextProjector;
}

function injectReminders(messages: LlmMessage[], reminders: string[]): LlmMessage[] {
  if (reminders.length === 0) {
    return messages;
  }
  const text = reminders
    .map((reminder) => `<system-reminder>\n${reminder}\n</system-reminder>`)
    .join("\n");
  const result = messages.map((message) => ({ ...message }));
  let lastUser = -1;
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) {
    result.push({ role: "user", content: [{ type: "text", text }] });
    return result;
  }
  const target = result[lastUser];
  if (target !== undefined && target.role === "user") {
    result[lastUser] = { role: "user", content: [...target.content, { type: "text", text }] };
  }
  return result;
}

/** Creates the cache-aware projection pipeline used before a provider request. */
export function createProjectionPipeline(
  options: ProjectionPipelineOptions = {},
): ProjectionPipeline {
  const projector = options.projector ?? createContextProjector();
  const estimator = createTokenEstimator();

  return {
    project(input: ProjectionPipelineInput): ProjectionPipelineResult {
      const base = projector.project(input);
      const reminded = injectReminders(base.messages, input.reminders ?? []);
      const messages = input.convert === undefined ? reminded : input.convert(reminded);
      return {
        messages,
        promptHash:
          messages === base.messages
            ? base.promptHash
            : hashPrompt({ system: input.system, messages, tools: input.tools }),
        estimatedTokens: estimateMessages(messages, estimator),
        cache: {
          readTokens: input.usage?.cacheReadTokens ?? 0,
          writeTokens: input.usage?.cacheWriteTokens ?? 0,
        },
      };
    },
  };
}
