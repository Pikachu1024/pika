import type { SessionEntry } from "@pika-harness/schema";
import type { LlmMessage, ProviderTool } from "./provider.js";

export interface PromptSection {
  name: string;
  content: string;
}

export interface SystemPromptInput {
  identity?: string;
  environment?: Record<string, string>;
  projectInstructions?: string[];
  skillIndex?: Array<{ name: string; description: string }>;
  toolGuidance?: string;
  mode?: "plan" | "execute" | "review";
  toolsAdded?: string[];
  toolsRemoved?: string[];
}

export interface SystemPromptDocument {
  sections: PromptSection[];
  toolsAdded: string[];
  toolsRemoved: string[];
}

export interface PromptBuilder {
  build(input: SystemPromptInput): SystemPromptDocument;
  render(document: SystemPromptDocument): string;
}

export interface ProjectionInput {
  entries: SessionEntry[];
  system: string;
  tools: ProviderTool[];
}

export interface ProjectionResult {
  messages: LlmMessage[];
  promptHash: string;
}

export interface ContextProjector {
  project(input: ProjectionInput): ProjectionResult;
}

export interface TokenEstimator {
  estimate(text: string): number;
}

export interface CompactionPolicy {
  shouldCompact(tokens: number, contextWindow: number, reserveTokens: number): boolean;
}
