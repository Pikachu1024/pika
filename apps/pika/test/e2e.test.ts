import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const entry = path.resolve(import.meta.dir, "../src/bin.ts");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("pika launcher", () => {
  it("runs one prompt through a bundled local server and exits cleanly", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pika-e2e-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const proc = Bun.spawn({
      cmd: [process.execPath, entry, "--prompt", "e2e hello"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? tmpdir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        PIKA_SESSION_DIR: dir,
        PIKA_CONFIG_DIR: path.join(dir, "config"),
        PIKA_SANDBOX_BACKEND: "none",
      },
    });
    cleanups.push(async () => {
      proc.kill();
      await proc.exited;
    });

    const [code, stdout, stderr] = await Promise.all([
      withTimeout(proc.exited, 20_000, "launcher exit"),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain("echo: e2e hello");
    expect(code).toBe(0);
  }, 30_000);

  it("reports a configuration migration warning without aborting the run", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pika-e2e-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const legacy = path.join(home, ".config", "pika", "models.json");
    await mkdir(legacy, { recursive: true });

    const proc = Bun.spawn({
      cmd: [process.execPath, entry, "--prompt", "migrate hello"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        PIKA_SESSION_DIR: path.join(home, "sessions"),
        PIKA_SANDBOX_BACKEND: "none",
      },
    });
    cleanups.push(async () => {
      proc.kill();
      await proc.exited;
    });

    const [code, stdout, stderr] = await Promise.all([
      withTimeout(proc.exited, 20_000, "launcher exit"),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(stderr).toContain(`[config] failed to migrate ${legacy}`);
    expect(stdout).toContain("echo: migrate hello");
    expect(code).toBe(0);
  }, 30_000);

  it("stores sessions under PIKA_HOME when no session directory is set", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "pika-e2e-pika-home-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const pikaHome = path.join(home, "pika-home");

    const proc = Bun.spawn({
      cmd: [process.execPath, entry, "--prompt", "home hello"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        PIKA_HOME: pikaHome,
        PIKA_SANDBOX_BACKEND: "none",
      },
    });
    cleanups.push(async () => {
      proc.kill();
      await proc.exited;
    });

    const [code, stdout, stderr] = await Promise.all([
      withTimeout(proc.exited, 20_000, "launcher exit"),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("echo: home hello");
    expect(stderr).toBe("");
    const sessions = await readdir(path.join(pikaHome, "sessions"));
    expect(sessions.length).toBe(1);
  }, 30_000);
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`timed out waiting for ${label}`);
    }),
  ]);
}
