import {
  createBwrapExecutor,
  createDockerExecutor,
  NodeProcessExecutor,
  SeatbeltExecutor,
  seatbeltAvailable,
} from "@pika-harness/adapters";
import type { Executor } from "@pika-harness/core";
import type { SandboxBackend } from "@pika-harness/schema";

/** Backend setting accepted by serve; `auto` picks one for the host platform. */
export type ServeSandboxSelection = SandboxBackend | "auto";

export const SERVE_SANDBOX_SELECTIONS: readonly ServeSandboxSelection[] = [
  "auto",
  "none",
  "seatbelt",
  "bwrap",
  "docker",
];

export interface ServeSandboxDependencies {
  platform?: NodeJS.Platform;
  nodeExecutor?: () => Executor;
  seatbeltAvailable?: () => Promise<boolean>;
  seatbeltExecutor?: () => Executor;
  bwrapExecutor?: () => Executor | undefined;
  dockerExecutor?: () => Executor | undefined;
}

export interface ResolvedServeSandbox {
  executor: Executor;
  backend: SandboxBackend;
}

/** Returns true when the value names a backend serve accepts. */
export function isServeSandboxSelection(value: string): value is ServeSandboxSelection {
  return (SERVE_SANDBOX_SELECTIONS as readonly string[]).includes(value);
}

/** Resolves the configured backend once, failing when an isolation backend is unavailable. */
export async function createServeSandbox(
  selection: ServeSandboxSelection,
  dependencies: ServeSandboxDependencies = {},
): Promise<ResolvedServeSandbox> {
  const platform = dependencies.platform ?? process.platform;
  const createNode = dependencies.nodeExecutor ?? (() => new NodeProcessExecutor());
  const isSeatbeltAvailable = dependencies.seatbeltAvailable ?? seatbeltAvailable;
  const createSeatbelt = dependencies.seatbeltExecutor ?? (() => new SeatbeltExecutor());
  const createBwrap = dependencies.bwrapExecutor ?? createBwrapExecutor;
  const createDocker = dependencies.dockerExecutor ?? createDockerExecutor;

  if (selection === "none") {
    return { executor: createNode(), backend: "none" };
  }

  if (selection === "seatbelt" || (selection === "auto" && platform === "darwin")) {
    if (!(await isSeatbeltAvailable())) {
      throw new Error(
        unavailable("seatbelt", "the sandbox-exec binary was not found", selection, platform),
      );
    }
    return { executor: createSeatbelt(), backend: "seatbelt" };
  }

  if (selection === "bwrap" || (selection === "auto" && platform === "linux")) {
    const executor = createBwrap();
    if (executor === undefined) {
      throw new Error(
        unavailable("bwrap", "bubblewrap (bwrap) was not found", selection, platform),
      );
    }
    return { executor, backend: "bwrap" };
  }

  if (selection === "docker") {
    const executor = createDocker();
    if (executor === undefined) {
      throw new Error(
        unavailable(
          "docker",
          "the Docker CLI and daemon socket were not found",
          selection,
          platform,
        ),
      );
    }
    return { executor, backend: "docker" };
  }

  throw new Error(
    `No isolation sandbox is available on platform "${platform}". ` +
      `Supported backends: seatbelt (macOS), bwrap (Linux), docker. ` +
      "Pass --sandbox-backend none to run without OS isolation.",
  );
}

function unavailable(
  backend: SandboxBackend,
  reason: string,
  selection: ServeSandboxSelection,
  platform: NodeJS.Platform,
): string {
  const message = `Sandbox backend "${backend}" is unavailable: ${reason}.`;
  if (selection !== "auto") return message;
  return (
    `${message} No isolation backend is available on platform "${platform}". ` +
    "Pass --sandbox-backend none to run without OS isolation."
  );
}
