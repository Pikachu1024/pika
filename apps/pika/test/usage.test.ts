import { describe, expect, it } from "bun:test";
import { usage } from "../src/usage.js";

describe("pika usage text", () => {
  it("documents the Pika home config, credentials, and session defaults", () => {
    expect(usage).toContain("PIKA_HOME");
    expect(usage).toContain("$PIKA_HOME/models.json (~/.pika/models.json)");
    expect(usage).toContain("$PIKA_HOME/credentials.json");
    expect(usage).toContain("$PIKA_HOME/sessions (~/.pika/sessions)");
  });
});
