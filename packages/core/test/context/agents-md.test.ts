import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { discoverAgentsFiles, loadAgentsInstructions } from "../../src/context/agents-md.js";

const repoRoot = "/repo";
const cwd = join(repoRoot, "packages", "core");

function reader(files: Record<string, string>): (path: string) => Promise<string> {
  return async (path) => {
    const content = files[path];
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  };
}

describe("discoverAgentsFiles", () => {
  it("returns AGENTS.md paths from repository root to cwd in order", async () => {
    const files = {
      [join(repoRoot, "AGENTS.md")]: "root",
      [join(repoRoot, "packages", "AGENTS.md")]: "packages",
      [join(repoRoot, "packages", "core", "AGENTS.md")]: "core",
    };

    const found = await discoverAgentsFiles({ repoRoot, cwd, readFile: reader(files) });

    expect(found).toEqual([
      join(repoRoot, "AGENTS.md"),
      join(repoRoot, "packages", "AGENTS.md"),
      join(repoRoot, "packages", "core", "AGENTS.md"),
    ]);
  });

  it("skips directories without AGENTS.md files", async () => {
    const files = {
      [join(repoRoot, "AGENTS.md")]: "root",
      [join(repoRoot, "packages", "core", "AGENTS.md")]: "core",
    };

    const found = await discoverAgentsFiles({ repoRoot, cwd, readFile: reader(files) });

    expect(found).toEqual([
      join(repoRoot, "AGENTS.md"),
      join(repoRoot, "packages", "core", "AGENTS.md"),
    ]);
  });

  it("includes the repository root when cwd equals repoRoot", async () => {
    const files = { [join(repoRoot, "AGENTS.md")]: "root" };

    const found = await discoverAgentsFiles({ repoRoot, cwd: repoRoot, readFile: reader(files) });

    expect(found).toEqual([join(repoRoot, "AGENTS.md")]);
  });

  it("throws when cwd is outside repoRoot", async () => {
    await expect(
      discoverAgentsFiles({ repoRoot, cwd: "/elsewhere", readFile: reader({}) }),
    ).rejects.toThrow(/inside repoRoot/);
  });
});

describe("loadAgentsInstructions", () => {
  it("returns contents in root-to-leaf order and skips missing files", async () => {
    const files = {
      [join(repoRoot, "AGENTS.md")]: "root instructions",
      [join(repoRoot, "packages", "core", "AGENTS.md")]: "core instructions",
    };

    const instructions = await loadAgentsInstructions({ repoRoot, cwd, readFile: reader(files) });

    expect(instructions).toEqual(["root instructions", "core instructions"]);
  });

  it("throws when cwd is outside repoRoot", async () => {
    await expect(
      loadAgentsInstructions({ repoRoot, cwd: "/elsewhere", readFile: reader({}) }),
    ).rejects.toThrow(/inside repoRoot/);
  });
});
