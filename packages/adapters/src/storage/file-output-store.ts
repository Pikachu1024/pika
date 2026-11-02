import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolOutputStore } from "@pika-harness/core";

/** Persists truncated tool output as files so the model can cite a stable path. */
export class FileToolOutputStore implements ToolOutputStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
  }

  async write(toolCallId: string, content: string): Promise<string> {
    await mkdir(this.#directory, { recursive: true });
    const target = path.join(this.#directory, `${fileNameFor(toolCallId)}.txt`);
    await writeFile(target, content, "utf8");
    return target;
  }
}

// The readable prefix keeps the file recognizable while the digest prevents a
// sanitized collision from overwriting another call's output.
function fileNameFor(toolCallId: string): string {
  const readable = toolCallId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "output";
  const digest = createHash("sha256").update(toolCallId).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}
