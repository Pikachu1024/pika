import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDirectory } from "./home.js";

/** Per-alias API keys stored outside catalogs and session logs. */
export type Credentials = Record<string, string>;

export const CREDENTIALS_FILE = "credentials.json";

/** A credentials file could not be read, validated, or written. */
export class CredentialsError extends Error {
  readonly credentialsPath: string;

  constructor(credentialsPath: string, reason: string) {
    super(`credentials error at ${credentialsPath}: ${reason}`);
    this.name = "CredentialsError";
    this.credentialsPath = credentialsPath;
  }
}

export function credentialsPath(env: Record<string, string | undefined>): string {
  return path.join(configDirectory(env), CREDENTIALS_FILE);
}

/** Reads the credentials file; a missing file is an empty store. */
export async function loadCredentials(
  env: Record<string, string | undefined>,
): Promise<Credentials> {
  const file = credentialsPath(env);
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new CredentialsError(file, describeFileError(error));
  }

  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new CredentialsError(file, "invalid JSON");
  }
  if (!isCredentials(document)) {
    throw new CredentialsError(file, "expected an object mapping aliases to non-empty strings");
  }
  return document;
}

interface CredentialsIo {
  chmod: typeof chmod;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

const defaultIo: CredentialsIo = { chmod, mkdir, readFile, rename, rm, writeFile };

/**
 * Saves one alias' key by replacing the credentials file atomically. The
 * directory and file are forced to 0700/0600; a failed replace leaves the
 * previous file untouched.
 */
export async function saveCredential(
  env: Record<string, string | undefined>,
  alias: string,
  apiKey: string,
  overrides: Partial<CredentialsIo> = {},
): Promise<void> {
  if (alias.length === 0) throw new Error("credential alias must not be empty");
  if (apiKey.length === 0) throw new Error("credential value must not be empty");
  const io: CredentialsIo = { ...defaultIo, ...overrides };
  const file = credentialsPath(env);
  const directory = path.dirname(file);
  const existing = await loadCredentials(env).catch((error: unknown) => {
    throw error instanceof CredentialsError
      ? error
      : new CredentialsError(file, describeFileError(error));
  });
  const next: Credentials = { ...existing, [alias]: apiKey };
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    await io.chmod(directory, 0o700);
    await io.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await io.rename(temporary, file);
  } catch (error) {
    await io.rm(temporary, { force: true }).catch(() => undefined);
    throw new CredentialsError(file, describeFileError(error));
  }
}

function isCredentials(value: unknown): value is Credentials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string" && entry.length > 0);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function describeFileError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
