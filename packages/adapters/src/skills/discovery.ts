import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Where a skill was discovered; later scopes override earlier ones by name. */
export type SkillScope = "builtin" | "plugin" | "user" | "project";

const SCOPE_ORDER: readonly SkillScope[] = ["builtin", "plugin", "user", "project"];
const SKILL_FILE = "SKILL.md";

/** A discovered skill without its body; bodies load on selection. */
export interface SkillDescriptor {
  name: string;
  description: string;
  scope: SkillScope;
  /** Absolute path to the skill file. */
  path: string;
}

/** Name and description exposed in the system prompt. */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

/** Resolves skill bodies on demand so unused skills never reach the model. */
export interface SkillCatalog {
  list(): readonly SkillDescriptor[];
  /** Returns the prompt index entries sorted by name. */
  index(): SkillIndexEntry[];
  /** Loads a skill body, rejecting unknown names. */
  load(name: string): Promise<string>;
}

export interface SkillRoots {
  builtin?: readonly string[];
  plugin?: readonly string[];
  user?: readonly string[];
  project?: readonly string[];
}

export interface FileSystemSkillCatalogOptions extends SkillRoots {}

/** Raised when a selected skill name is not part of the catalog. */
export class UnknownSkillError extends Error {
  constructor(name: string) {
    super(`unknown skill: ${name}`);
    this.name = "UnknownSkillError";
  }
}

/** Splits a `SKILL.md` document into frontmatter fields and the lazy body. */
export function parseSkillDocument(
  source: string,
  fallbackName: string,
): { name: string; description: string; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { name: fallbackName, description: "", body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { name: fallbackName, description: "", body: normalized };
  }
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+|\n+$/g, "");
  const fields = parseFrontmatter(frontmatter);
  return {
    name: fields.name ?? fallbackName,
    description: fields.description ?? "",
    body,
  };
}

/** Converts discovered skills into the prompt index; bodies are not included. */
export function renderSkillIndex(skills: readonly SkillDescriptor[]): SkillIndexEntry[] {
  return [...skills]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(({ name, description }) => ({ name, description }));
}

/** Discovers skills from configured roots, applying builtin < plugin < user < project precedence. */
export async function discoverSkills(roots: SkillRoots): Promise<SkillDescriptor[]> {
  const byName = new Map<string, SkillDescriptor>();
  for (const scope of SCOPE_ORDER) {
    for (const root of roots[scope] ?? []) {
      for (const skill of await scanRoot(path.resolve(root), scope)) {
        byName.set(skill.name, skill);
      }
    }
  }
  return [...byName.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

/** File-system backed catalog with lazy body loading. */
export class FileSystemSkillCatalog implements SkillCatalog {
  readonly #skills = new Map<string, SkillDescriptor>();

  private constructor(skills: readonly SkillDescriptor[]) {
    for (const skill of skills) {
      this.#skills.set(skill.name, skill);
    }
  }

  /** Scans the configured roots once and stores only descriptors. */
  static async create(options: FileSystemSkillCatalogOptions): Promise<FileSystemSkillCatalog> {
    return new FileSystemSkillCatalog(await discoverSkills(options));
  }

  list(): readonly SkillDescriptor[] {
    return [...this.#skills.values()];
  }

  index(): SkillIndexEntry[] {
    return renderSkillIndex(this.list());
  }

  async load(name: string): Promise<string> {
    const skill = this.#skills.get(name);
    if (skill === undefined) {
      throw new UnknownSkillError(name);
    }
    const source = await readFile(skill.path, "utf8");
    return parseSkillDocument(source, skill.name).body;
  }
}

async function scanRoot(root: string, scope: SkillScope): Promise<SkillDescriptor[]> {
  const skills: SkillDescriptor[] = [];
  const rootSkill = await readSkill(path.join(root, SKILL_FILE), path.basename(root), scope);
  if (rootSkill !== undefined) {
    skills.push(rootSkill);
  }

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(root, entry.name, SKILL_FILE);
    const skill = await readSkill(skillPath, entry.name, scope);
    if (skill !== undefined) skills.push(skill);
  }
  return skills;
}

async function readSkill(
  skillPath: string,
  fallbackName: string,
  scope: SkillScope,
): Promise<SkillDescriptor | undefined> {
  let source: string;
  try {
    source = await readFile(skillPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseSkillDocument(source, fallbackName);
  if (parsed.name.trim().length === 0) return undefined;
  return {
    name: parsed.name.trim(),
    description: parsed.description.trim(),
    scope,
    path: skillPath,
  };
}

function parseFrontmatter(source: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();
    if (value === "|" || value === ">") {
      const folded = value === ">";
      const collected: string[] = [];
      while (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1] ?? "")) {
        index += 1;
        collected.push((lines[index] ?? "").trim());
      }
      value = folded ? collected.join(" ") : collected.join("\n");
    }
    fields[key] = unquote(value);
  }
  return fields;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
