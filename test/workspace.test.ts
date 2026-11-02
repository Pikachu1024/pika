import * as adapters from "@pika-harness/adapters";
import * as cli from "@pika-harness/cli";
import * as client from "@pika-harness/client";
import * as core from "@pika-harness/core";
import * as schema from "@pika-harness/schema";
import * as server from "@pika-harness/server";
import { describe, expect, it } from "vitest";

const workspace = {
  adapters,
  cli,
  client,
  core,
  schema,
  server,
};

describe("workspace", () => {
  it("resolves every workspace project", () => {
    for (const [name, entry] of Object.entries(workspace)) {
      expect(entry, `${name} should resolve`).toBeTypeOf("object");
    }
  });
});
