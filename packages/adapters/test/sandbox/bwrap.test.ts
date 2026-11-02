import { createBwrapExecutor } from "../../src/sandbox/bwrap-executor.js";
import { defineExecutorConformance } from "./conformance.js";

const executor = process.platform === "linux" ? createBwrapExecutor() : undefined;
if (process.env.PIKA_REQUIRE_SANDBOX_BACKENDS === "1" && process.platform === "linux") {
  if (executor === undefined) {
    throw new Error("PIKA_REQUIRE_SANDBOX_BACKENDS=1 but bubblewrap is not installed");
  }
}

defineExecutorConformance({
  name: "bubblewrap",
  createExecutor: () => executor,
});
