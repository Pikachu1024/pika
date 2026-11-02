#!/usr/bin/env bun
import { serveMain } from "./serve.js";

serveMain(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
