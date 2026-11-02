import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface AgentsFileOptions {
  repoRoot: string;
  cwd: string;
  readFile?: (path: string) => Promise<string>;
}

type ReadTextFile = (path: string) => Promise<string>;

const defaultReadFile: ReadTextFile = (path) => readFile(path, "utf8");

const agentsFileName = "AGENTS.md";

function directoriesFromRoot(repoRoot: string, cwd: string): string[] {
  const root = resolve(repoRoot);
  const target = resolve(cwd);
  const relativePath = relative(root, target);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`cwd must be inside repoRoot: ${target} is not under ${root}`);
  }

  const directories = [root];
  if (relativePath === "") {
    return directories;
  }

  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    directories.push(current);
  }
  return directories;
}

async function tryRead(read: ReadTextFile, path: string): Promise<string | undefined> {
  try {
    return await read(path);
  } catch {
    return undefined;
  }
}

/** Finds existing AGENTS.md files from repository root to cwd, root first. */
export async function discoverAgentsFiles(options: AgentsFileOptions): Promise<string[]> {
  const read = options.readFile ?? defaultReadFile;
  const found: string[] = [];

  for (const directory of directoriesFromRoot(options.repoRoot, options.cwd)) {
    const candidate = join(directory, agentsFileName);
    const content = await tryRead(read, candidate);
    if (content !== undefined) {
      found.push(candidate);
    }
  }

  return found;
}

/** Loads AGENTS.md contents from repository root to cwd, skipping missing files. */
export async function loadAgentsInstructions(options: AgentsFileOptions): Promise<string[]> {
  const read = options.readFile ?? defaultReadFile;
  const instructions: string[] = [];

  for (const directory of directoriesFromRoot(options.repoRoot, options.cwd)) {
    const content = await tryRead(read, join(directory, agentsFileName));
    if (content !== undefined) {
      instructions.push(content);
    }
  }

  return instructions;
}
