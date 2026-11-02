import { createDockerExecutor } from "../../src/sandbox/docker-executor.js";
import { defineExecutorConformance } from "./conformance.js";

const executor = createDockerExecutor();
if (process.env.PIKA_REQUIRE_SANDBOX_BACKENDS === "1" && executor === undefined) {
  throw new Error("PIKA_REQUIRE_SANDBOX_BACKENDS=1 but the Docker CLI or daemon is unavailable");
}

defineExecutorConformance({
  name: "docker",
  createExecutor: () => executor,
  support: {
    // Killing the docker client can leave the container running; cleanup is not yet automated.
    orphanCleanup: false,
  },
});
