import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configDirectory, migrateLegacyConfig, pikaHomeDirectory } from "../src/home.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pika-cli-home-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("Pika home resolution", () => {
  it("uses PIKA_HOME when set and ~/.pika otherwise", async () => {
    const home = await tempDir();
    expect(pikaHomeDirectory({ HOME: home })).toBe(path.join(home, ".pika"));
    expect(pikaHomeDirectory({ HOME: home, PIKA_HOME: "/srv/pika" })).toBe("/srv/pika");
    expect(pikaHomeDirectory({ HOME: home, PIKA_HOME: "relative" })).toBe(path.resolve("relative"));
  });

  it("routes the config directory through PIKA_CONFIG_DIR, then the Pika home", async () => {
    const home = await tempDir();
    expect(configDirectory({ HOME: home })).toBe(path.join(home, ".pika"));
    expect(configDirectory({ HOME: home, PIKA_HOME: "/srv/pika" })).toBe("/srv/pika");
    expect(
      configDirectory({ HOME: home, PIKA_HOME: "/srv/pika", PIKA_CONFIG_DIR: "/etc/pika" }),
    ).toBe("/etc/pika");
  });
});

describe("legacy configuration migration", () => {
  it("copies catalogs and credentials into the Pika home", async () => {
    const home = await tempDir();
    const legacy = path.join(home, ".config", "pika");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "models.json"), '{"models":[]}\n');
    await writeFile(path.join(legacy, "credentials.json"), '{"alpha":"secret"}\n');

    const warnings = await migrateLegacyConfig({ HOME: home });

    expect(warnings).toEqual([]);
    const target = path.join(home, ".pika");
    expect(await readFile(path.join(target, "models.json"), "utf8")).toBe('{"models":[]}\n');
    expect(await readFile(path.join(target, "credentials.json"), "utf8")).toBe(
      '{"alpha":"secret"}\n',
    );
    expect((await stat(path.join(target, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(legacy, "models.json"), "utf8")).toBe('{"models":[]}\n');
  });

  it("honors XDG_CONFIG_HOME and leaves an existing target untouched", async () => {
    const home = await tempDir();
    const legacy = path.join(home, "xdg", "pika");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "models.json"), "legacy");
    const target = path.join(home, "pika-home");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "models.json"), "current");

    const warnings = await migrateLegacyConfig({
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "xdg"),
      PIKA_HOME: target,
    });

    expect(warnings).toEqual([]);
    expect(await readFile(path.join(target, "models.json"), "utf8")).toBe("current");
  });

  it("does nothing when the legacy directory or files are absent", async () => {
    const home = await tempDir();
    expect(await migrateLegacyConfig({ HOME: home })).toEqual([]);
    expect(await migrateLegacyConfig({ HOME: home, PIKA_HOME: home })).toEqual([]);
  });

  it("skips migration when PIKA_CONFIG_DIR is set", async () => {
    const home = await tempDir();
    const legacy = path.join(home, ".config", "pika");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "models.json"), "legacy");

    expect(
      await migrateLegacyConfig({
        HOME: home,
        PIKA_CONFIG_DIR: path.join(home, "explicit"),
      }),
    ).toEqual([]);
    await expect(readFile(path.join(home, ".pika", "models.json"), "utf8")).rejects.toThrow();
  });

  it("reports a warning instead of throwing when a file cannot be copied", async () => {
    const home = await tempDir();
    const legacy = path.join(home, ".config", "pika");
    await mkdir(path.join(legacy, "models.json"), { recursive: true });

    const warnings = await migrateLegacyConfig({ HOME: home });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path.join(legacy, "models.json"));
    expect(warnings[0]).toContain(path.join(home, ".pika", "models.json"));
  });
});
