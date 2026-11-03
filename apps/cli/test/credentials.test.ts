import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CredentialsError,
  credentialsPath,
  loadCredentials,
  saveCredential,
} from "../src/credentials.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pika-cli-credentials-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("credentials store", () => {
  it("returns an empty store when no file exists", async () => {
    const config = await tempDir();
    expect(await loadCredentials({ PIKA_CONFIG_DIR: config })).toEqual({});
  });

  it("writes a 0600 file in a 0700 directory and merges aliases", async () => {
    const config = await tempDir();
    const env = { PIKA_CONFIG_DIR: config };

    await saveCredential(env, "alpha", "secret-alpha");
    await saveCredential(env, "beta", "secret-beta");

    const file = credentialsPath(env);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(config)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      alpha: "secret-alpha",
      beta: "secret-beta",
    });
    expect(await loadCredentials(env)).toEqual({
      alpha: "secret-alpha",
      beta: "secret-beta",
    });
  });

  it("rejects malformed credentials files", async () => {
    const config = await tempDir();
    const file = credentialsPath({ PIKA_CONFIG_DIR: config });
    await writeFile(file, "{ not json", "utf8");
    await expect(loadCredentials({ PIKA_CONFIG_DIR: config })).rejects.toBeInstanceOf(
      CredentialsError,
    );

    await writeFile(file, JSON.stringify(["alpha"]), "utf8");
    await expect(loadCredentials({ PIKA_CONFIG_DIR: config })).rejects.toThrow(/aliases/);

    await writeFile(file, JSON.stringify({ alpha: 42 }), "utf8");
    await expect(loadCredentials({ PIKA_CONFIG_DIR: config })).rejects.toThrow(/aliases/);
  });

  it("defaults to the Pika home directory and honors PIKA_HOME", async () => {
    const home = await tempDir();
    expect(credentialsPath({ HOME: home })).toBe(path.join(home, ".pika", "credentials.json"));

    const pikaHome = path.join(home, "custom-home");
    expect(credentialsPath({ HOME: home, PIKA_HOME: pikaHome })).toBe(
      path.join(pikaHome, "credentials.json"),
    );
  });

  it("leaves the previous file intact when the replace fails", async () => {
    const config = await tempDir();
    const env = { PIKA_CONFIG_DIR: config };
    await saveCredential(env, "alpha", "secret-alpha");
    const file = credentialsPath(env);
    const before = await readFile(file, "utf8");

    await expect(
      saveCredential(env, "beta", "secret-beta", {
        rename: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toBeInstanceOf(CredentialsError);

    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(config)).toEqual(["credentials.json"]);
  });
});
