import { accessSync, constants } from "node:fs";
import path from "node:path";

function candidates(name: string, envPath: string | undefined): string[] {
  if (name.includes("/")) {
    return [name];
  }
  const entries = (envPath ?? "").split(path.delimiter).filter((entry) => entry !== "");
  return entries.map((entry) => path.join(entry, name));
}

/** Finds an executable on PATH; returns undefined instead of throwing. */
export function findExecutable(
  name: string,
  envPath: string | undefined = process.env.PATH,
): string | undefined {
  for (const candidate of candidates(name, envPath)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/** Returns true when a command is executable on this host. */
export function executableExists(name: string): boolean {
  return findExecutable(name) !== undefined;
}
