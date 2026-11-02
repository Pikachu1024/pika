import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LlmEvent, LlmRequest, ModelInfo, Provider } from "@pika-harness/core";

export interface RawCaptureProviderOptions {
  sessionId: string;
  directory: string;
  now?: () => Date;
}

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length === 0 ? "session" : sanitized;
}

/** Wraps a provider and writes raw requests and response events to a sidecar directory. */
export class RawCaptureProvider implements Provider {
  readonly #inner: Provider;
  readonly #sessionId: string;
  readonly #directory: string;
  readonly #now: () => Date;
  #step = 0;

  constructor(inner: Provider, options: RawCaptureProviderOptions) {
    this.#inner = inner;
    this.#sessionId = options.sessionId;
    this.#directory = resolve(options.directory, safeSegment(options.sessionId));
    this.#now = options.now ?? (() => new Date());
  }

  models(): ModelInfo[] {
    return this.#inner.models();
  }

  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    return this.#capture(request, signal);
  }

  async *#capture(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.#step += 1;
    const prefix = `${this.#now().toISOString()}-step-${String(this.#step).padStart(4, "0")}`;
    await mkdir(this.#directory, { recursive: true });
    await writeFile(
      join(this.#directory, `${prefix}-request.json`),
      `${JSON.stringify(request, null, 2)}\n`,
      "utf8",
    );

    const events: LlmEvent[] = [];
    try {
      for await (const event of this.#inner.stream(request, signal)) {
        events.push(event);
        yield event;
      }
    } finally {
      const body = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      await writeFile(join(this.#directory, `${prefix}-response.jsonl`), body, "utf8");
    }
  }
}
