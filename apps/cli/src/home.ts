import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Environment variable that overrides the Pika home directory. */
export const PIKA_HOME_ENV = "PIKA_HOME";

/** Directory name used under the user's home when `PIKA_HOME` is unset. */
export const PIKA_HOME_DIRECTORY = ".pika";

const LEGACY_CONFIG_FILES = ["models.json", "credentials.json"];

/** Resolves the Pika home directory: `PIKA_HOME`, then `~/.pika`. */
export function pikaHomeDirectory(env: Record<string, string | undefined>): string {
  const explicit = env[PIKA_HOME_ENV];
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  return path.join(userHomeDirectory(env), PIKA_HOME_DIRECTORY);
}

/** Resolves the user config directory: `PIKA_CONFIG_DIR`, then the Pika home directory. */
export function configDirectory(env: Record<string, string | undefined>): string {
  const explicit = env.PIKA_CONFIG_DIR;
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  return pikaHomeDirectory(env);
}

/**
 * Copies catalogs and credentials from the legacy XDG config directory into the
 * Pika home directory. Existing targets and the legacy files are left untouched.
 * Returns human-readable warnings for files that could not be migrated.
 */
export async function migrateLegacyConfig(
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const explicitConfig = env.PIKA_CONFIG_DIR;
  if (explicitConfig !== undefined && explicitConfig.length > 0) return [];
  const target = pikaHomeDirectory(env);
  const legacy = legacyConfigDirectory(env);
  if (path.resolve(legacy) === path.resolve(target)) return [];

  const warnings: string[] = [];
  for (const name of LEGACY_CONFIG_FILES) {
    const source = path.join(legacy, name);
    const destination = path.join(target, name);
    if (!(await exists(source)) || (await exists(destination))) continue;
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      if (name === "credentials.json") await chmod(destination, 0o600);
    } catch (error) {
      warnings.push(`failed to migrate ${source} to ${destination}: ${errorMessage(error)}`);
    }
  }
  return warnings;
}

function legacyConfigDirectory(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0) return path.join(path.resolve(xdg), "pika");
  return path.join(userHomeDirectory(env), ".config", "pika");
}

function userHomeDirectory(env: Record<string, string | undefined>): string {
  return env.HOME === undefined || env.HOME.length === 0 ? homedir() : env.HOME;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
