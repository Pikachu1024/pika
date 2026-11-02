import { createHash } from "node:crypto";
import type { LlmMessage, ProviderTool } from "../provider.js";

export interface PromptHashInput {
  system: string;
  messages: LlmMessage[];
  tools: ProviderTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Hashes a provider request shape so a recorded projection can be compared exactly. */
export function hashPrompt(input: PromptHashInput): string {
  const serialized = JSON.stringify(canonicalize(input));
  return createHash("sha256")
    .update(serialized ?? "")
    .digest("hex");
}
