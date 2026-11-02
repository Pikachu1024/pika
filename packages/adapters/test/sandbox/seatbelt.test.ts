import { existsSync } from "node:fs";
import { SeatbeltExecutor } from "../../src/sandbox/seatbelt-executor.js";
import { defineExecutorConformance } from "./conformance.js";

const available = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
if (process.env.PIKA_REQUIRE_SANDBOX_BACKENDS === "1" && process.platform === "darwin") {
  if (!available) {
    throw new Error("PIKA_REQUIRE_SANDBOX_BACKENDS=1 but /usr/bin/sandbox-exec is unavailable");
  }
}

defineExecutorConformance({
  name: "seatbelt",
  createExecutor: () => (available ? new SeatbeltExecutor() : undefined),
});
