import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ExecRequest, ExecResult, SandboxCapabilities } from "@pika-harness/core";
import type { SandboxPolicy } from "@pika-harness/schema";
import { detectDenial } from "./denial.js";
import { findExecutable } from "./executables.js";
import { NodeProcessExecutor, type NodeProcessExecutorOptions } from "./node-executor.js";

export interface DockerExecutorOptions extends NodeProcessExecutorOptions {
  /** Image used for command execution; must contain the requested programs. */
  image?: string;
  dockerPath?: string;
  /** User inside the container; defaults to the current uid/gid on POSIX. */
  user?: string;
}

const DEFAULT_IMAGE = "debian:bookworm-slim";

/** Builds `docker run` arguments for the effective policy. */
export function buildDockerArgs(
  request: ExecRequest,
  policy: SandboxPolicy,
  options: DockerExecutorOptions = {},
): string[] {
  const args = ["run", "--rm", "-i", "--init"];
  args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
  // Proxy routing into the container is not implemented yet, so both restricted
  // modes fail closed instead of attaching the container to the bridge network.
  args.push("--network", policy.network === "full" ? "bridge" : "none");
  args.push("--tmpfs", "/tmp");

  if (policy.workspaceRoot !== "") {
    const access = policy.mode === "read-only" ? "ro" : "rw";
    args.push("-v", `${policy.workspaceRoot}:${policy.workspaceRoot}:${access}`);
  }
  for (const root of policy.writableRoots) {
    if (root !== policy.workspaceRoot) {
      args.push("-v", `${root}:${root}:rw`);
    }
  }
  for (const denied of policy.deniedReads) {
    args.push(...deniedMount(denied));
  }

  const user = options.user ?? currentUser();
  if (user !== undefined) {
    args.push("--user", user);
  }
  for (const name of policy.envAllowlist) {
    args.push("-e", name);
  }
  args.push("-w", request.cwd);
  args.push(options.image ?? DEFAULT_IMAGE);
  args.push(request.program, ...request.args);
  return args;
}

function currentUser(): string | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
}

// Masking works after the other mounts, so a denied path inside a mounted
// volume still reads as empty or unreadable.
function deniedMount(target: string): string[] {
  try {
    return statSync(target).isDirectory()
      ? ["--tmpfs", `${target}:ro`]
      : ["-v", `/dev/null:${target}:ro`];
  } catch {
    return [];
  }
}

/** Runs commands inside a Docker container with the workspace mounted. */
export class DockerExecutor extends NodeProcessExecutor {
  override readonly backend = "docker" as const;
  readonly #docker: string;
  readonly #options: DockerExecutorOptions;

  constructor(options: DockerExecutorOptions = {}) {
    super(options);
    const docker = options.dockerPath ?? findExecutable("docker");
    if (docker === undefined) {
      throw new Error("docker executable not found");
    }
    this.#docker = docker;
    this.#options = options;
  }

  override async probe(): Promise<SandboxCapabilities> {
    return {
      backend: "docker",
      filesystemIsolation: true,
      networkIsolation: true,
      processIsolation: true,
    };
  }

  override async exec(request: ExecRequest, policy: SandboxPolicy): Promise<ExecResult> {
    const args = buildDockerArgs(request, policy, this.#options);
    const result = await super.exec({ ...request, program: this.#docker, args }, policy);
    const denied = detectDenial(result, policy);
    return denied === undefined ? result : { ...result, denied };
  }
}

/** Creates a Docker executor when the CLI and daemon socket are available. */
export function createDockerExecutor(
  options: DockerExecutorOptions = {},
): DockerExecutor | undefined {
  const docker = findExecutable("docker");
  if (docker === undefined) {
    return undefined;
  }
  const socket =
    process.env.DOCKER_HOST !== undefined ||
    existsSync("/var/run/docker.sock") ||
    existsSync(path.join(process.env.HOME ?? "", ".docker", "run", "docker.sock"));
  return socket ? new DockerExecutor({ ...options, dockerPath: docker }) : undefined;
}
