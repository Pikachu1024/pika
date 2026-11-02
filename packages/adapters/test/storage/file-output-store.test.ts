import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileToolOutputStore } from "../../src/storage/file-output-store.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pika-output-store-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("FileToolOutputStore", () => {
  it("writes the complete output and returns an absolute path", async () => {
    const store = new FileToolOutputStore(directory);
    const reference = await store.write("call_1", "full output");
    expect(path.isAbsolute(reference)).toBe(true);
    await expect(readFile(reference, "utf8")).resolves.toBe("full output");
  });

  it("keeps traversal-shaped ids inside the output directory", async () => {
    const store = new FileToolOutputStore(path.join(directory, "nested"));
    const reference = await store.write("../../escape", "content");
    expect(path.dirname(reference)).toBe(path.resolve(directory, "nested"));
    await expect(readFile(reference, "utf8")).resolves.toBe("content");
  });

  it("gives different ids different files even after sanitization", async () => {
    const store = new FileToolOutputStore(directory);
    const first = await store.write("a/b", "first");
    const second = await store.write("a_b", "second");
    expect(first).not.toBe(second);
    await expect(readFile(first, "utf8")).resolves.toBe("first");
    await expect(readFile(second, "utf8")).resolves.toBe("second");
  });
});
