import { describe, expect, it } from "bun:test";
import * as adapters from "@pika-harness/adapters";
import * as cli from "@pika-harness/cli";
import * as client from "@pika-harness/client";
import * as core from "@pika-harness/core";
import * as pika from "@pika-harness/pika";
import * as schema from "@pika-harness/schema";
import * as server from "@pika-harness/server";

const workspace = {
  adapters,
  cli,
  client,
  core,
  pika,
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
