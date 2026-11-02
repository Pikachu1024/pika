import { describe, expect, it } from "bun:test";
import { createPromptBuilder, renderPromptSections } from "../../src/context/prompt-builder.js";

describe("createPromptBuilder", () => {
  it("emits sections in the fixed order", () => {
    const builder = createPromptBuilder();
    const document = builder.build({
      mode: "execute",
      toolGuidance: "Prefer tools.",
      skillIndex: [
        { name: "beta", description: "Second" },
        { name: "alpha", description: "First" },
      ],
      projectInstructions: ["Root rule.", "Leaf rule."],
      environment: { shell: "bash", cwd: "/workspace" },
      identity: "You are Pika.",
    });

    expect(document.sections.map((section) => section.name)).toEqual([
      "identity",
      "environment",
      "projectInstructions",
      "skillIndex",
      "toolGuidance",
      "mode",
    ]);
  });

  it("sorts environment keys and renders key/value lines", () => {
    const builder = createPromptBuilder();
    const document = builder.build({ environment: { shell: "zsh", cwd: "/work", alpha: "1" } });

    expect(document.sections).toEqual([
      { name: "environment", content: "alpha: 1\ncwd: /work\nshell: zsh" },
    ]);
  });

  it("renders the skill index in input order", () => {
    const builder = createPromptBuilder();
    const document = builder.build({
      skillIndex: [
        { name: "zeta", description: "Last" },
        { name: "alpha", description: "First" },
      ],
    });

    expect(document.sections).toEqual([
      { name: "skillIndex", content: "- zeta: Last\n- alpha: First" },
    ]);
  });

  it("omits empty sections", () => {
    const builder = createPromptBuilder();
    const document = builder.build({
      identity: "",
      environment: {},
      projectInstructions: [],
      skillIndex: [],
      toolGuidance: "",
    });

    expect(document.sections).toEqual([]);
    expect(builder.render(document)).toBe("");
  });

  it("carries tool changes and defaults them to empty arrays", () => {
    const builder = createPromptBuilder();
    const withTools = builder.build({
      identity: "x",
      toolsAdded: ["read"],
      toolsRemoved: ["write"],
    });
    const withDefaults = builder.build({});

    expect(withTools.toolsAdded).toEqual(["read"]);
    expect(withTools.toolsRemoved).toEqual(["write"]);
    expect(withDefaults.toolsAdded).toEqual([]);
    expect(withDefaults.toolsRemoved).toEqual([]);
  });

  it("renders deterministically with a trailing newline", () => {
    const builder = createPromptBuilder();
    const input = {
      identity: "You are Pika.",
      environment: { shell: "bash", cwd: "/workspace" },
      projectInstructions: ["Root rule.", "Leaf rule."],
      skillIndex: [
        { name: "beta", description: "Second" },
        { name: "alpha", description: "First" },
      ],
      toolGuidance: "Prefer tools.",
      mode: "execute" as const,
    };
    const expected = [
      "## identity\nYou are Pika.",
      "## environment\ncwd: /workspace\nshell: bash",
      "## projectInstructions\nRoot rule.\n\nLeaf rule.",
      "## skillIndex\n- beta: Second\n- alpha: First",
      "## toolGuidance\nPrefer tools.",
      "## mode\nexecute",
    ].join("\n\n");

    const first = builder.render(builder.build(input));
    const second = builder.render(builder.build(input));

    expect(first).toBe(second);
    expect(first).toBe(`${expected}\n`);
  });

  it("rebuilds the recorded system prompt from persisted sections", () => {
    const builder = createPromptBuilder();
    const document = builder.build({
      identity: "You are Pika.",
      projectInstructions: ["Root rule."],
      toolGuidance: "Prefer tools.",
    });
    const system = builder.render(document);

    // context_projected records sections; resume must reproduce the system prompt exactly.
    const restored = renderPromptSections(document.sections.map((section) => ({ ...section })));

    expect(restored).toBe(system);
  });
});
