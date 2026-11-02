import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPromptBuilder } from "@pika-harness/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLoadSkillTool,
  discoverSkills,
  FileSystemSkillCatalog,
  parseSkillDocument,
  renderSkillIndex,
  UnknownSkillError,
} from "../../src/index.js";

const temporary: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pika-skills-"));
  temporary.push(root);
  return root;
}

async function writeSkill(
  root: string,
  directory: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = path.join(root, directory);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("skill discovery", () => {
  it("discovers builtin, plugin, user, and project scopes with later scopes winning", async () => {
    const builtin = await makeRoot();
    const plugin = await makeRoot();
    const user = await makeRoot();
    const project = await makeRoot();

    await writeSkill(builtin, "review", "review", "builtin review", "builtin body");
    await writeSkill(plugin, "format", "format", "plugin formatting", "format body");
    await writeSkill(user, "review", "review", "user review", "user body");
    await writeSkill(project, "deploy", "deploy", "project deploy", "deploy body");
    await writeSkill(project, "review", "review", "project review", "project body");

    const skills = await discoverSkills({
      builtin: [builtin],
      plugin: [plugin],
      user: [user],
      project: [project],
    });

    expect(skills.map((skill) => [skill.name, skill.scope, skill.description])).toEqual([
      ["deploy", "project", "project deploy"],
      ["format", "plugin", "plugin formatting"],
      ["review", "project", "project review"],
    ]);
    expect(skills.every((skill) => skill.path.endsWith("SKILL.md"))).toBe(true);
  });

  it("exposes only name and description in the prompt index and loads the body lazily", async () => {
    const project = await makeRoot();
    await writeSkill(project, "review", "review", "review code", "SECRET BODY CONTENT");

    const catalog = await FileSystemSkillCatalog.create({ project: [project] });
    const index = catalog.index();

    expect(index).toEqual([{ name: "review", description: "review code" }]);
    expect(JSON.stringify(index)).not.toContain("SECRET BODY CONTENT");

    const document = createPromptBuilder().build({ skillIndex: index });
    const rendered = document.sections.find((section) => section.name === "skillIndex");
    expect(rendered?.content).toBe("- review: review code");
    expect(JSON.stringify(document)).not.toContain("SECRET BODY CONTENT");

    await expect(catalog.load("review")).resolves.toContain("SECRET BODY CONTENT");
    await expect(catalog.load("missing")).rejects.toBeInstanceOf(UnknownSkillError);
  });

  it("parses quoted and folded frontmatter values", () => {
    const parsed = parseSkillDocument(
      '---\nname: "quoted"\ndescription: >\n  folded\n  description\n---\nBody',
      "fallback",
    );
    expect(parsed).toEqual({
      name: "quoted",
      description: "folded description",
      body: "Body",
    });
  });

  it("returns an empty catalog for missing roots and root-level skill files", async () => {
    const missing = path.join(await makeRoot(), "absent");
    const catalog = await FileSystemSkillCatalog.create({ user: [missing] });
    expect(catalog.list()).toEqual([]);
    expect(renderSkillIndex([])).toEqual([]);

    const root = await makeRoot();
    const named = path.join(root, "single");
    await mkdir(named, { recursive: true });
    await writeFile(
      path.join(named, "SKILL.md"),
      "---\ndescription: root skill\n---\nroot body",
      "utf8",
    );
    const single = await FileSystemSkillCatalog.create({ project: [named] });
    expect(single.index()).toEqual([{ name: "single", description: "root skill" }]);
    await expect(single.load("single")).resolves.toBe("root body");
  });
});

describe("load_skill tool", () => {
  it("returns the selected body and rejects unknown skills", async () => {
    const project = await makeRoot();
    await writeSkill(project, "review", "review", "review code", "review body");
    const catalog = await FileSystemSkillCatalog.create({ project: [project] });
    const tool = createLoadSkillTool(catalog);
    const context = { signal: new AbortController().signal } as never;

    const loaded = await tool.execute(context, { name: "review" });
    expect(loaded.isError).toBe(false);
    expect(loaded.content).toEqual([{ type: "text", text: "review body" }]);
    expect(loaded.details).toMatchObject({ name: "review", scope: "project" });

    const unknown = await tool.execute(context, { name: "missing" });
    expect(unknown.isError).toBe(true);
  });
});
