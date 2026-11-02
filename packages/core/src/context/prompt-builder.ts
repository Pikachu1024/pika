import type {
  PromptBuilder,
  PromptSection,
  SystemPromptDocument,
  SystemPromptInput,
} from "../context.js";

function renderEnvironment(environment: Record<string, string>): string {
  return Object.entries(environment)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function buildSections(input: SystemPromptInput): PromptSection[] {
  const sections: PromptSection[] = [];

  if (input.identity !== undefined && input.identity.trim().length > 0) {
    sections.push({ name: "identity", content: input.identity });
  }

  if (input.environment !== undefined) {
    const content = renderEnvironment(input.environment);
    if (content.length > 0) {
      sections.push({ name: "environment", content });
    }
  }

  const instructions = input.projectInstructions?.filter((text) => text.trim().length > 0) ?? [];
  if (instructions.length > 0) {
    sections.push({ name: "projectInstructions", content: instructions.join("\n\n") });
  }

  const skills = input.skillIndex ?? [];
  if (skills.length > 0) {
    const content = skills.map(({ name, description }) => `- ${name}: ${description}`).join("\n");
    sections.push({ name: "skillIndex", content });
  }

  if (input.toolGuidance !== undefined && input.toolGuidance.trim().length > 0) {
    sections.push({ name: "toolGuidance", content: input.toolGuidance });
  }

  if (input.mode !== undefined) {
    sections.push({ name: "mode", content: input.mode });
  }

  return sections;
}

function renderDocument(document: SystemPromptDocument): string {
  if (document.sections.length === 0) {
    return "";
  }

  const body = document.sections
    .map((section) => `## ${section.name}\n${section.content}`)
    .join("\n\n");
  return `${body}\n`;
}

/** Creates the deterministic sectioned system prompt builder. */
export function createPromptBuilder(): PromptBuilder {
  return {
    build(input: SystemPromptInput): SystemPromptDocument {
      return {
        sections: buildSections(input),
        toolsAdded: input.toolsAdded ?? [],
        toolsRemoved: input.toolsRemoved ?? [],
      };
    },
    render(document: SystemPromptDocument): string {
      return renderDocument(document);
    },
  };
}
