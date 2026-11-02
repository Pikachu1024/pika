import { describe, expect, it } from "bun:test";
import type { ExecRequest } from "@pika-harness/core";
import { resolveSandboxPolicy } from "@pika-harness/core";
import type { NetworkPolicy } from "@pika-harness/schema";
import { buildBwrapArgs } from "../../src/sandbox/bwrap-executor.js";
import { buildDockerArgs } from "../../src/sandbox/docker-executor.js";
import { renderSeatbeltProfile } from "../../src/sandbox/seatbelt-executor.js";

const request: ExecRequest = {
  program: "/bin/bash",
  args: ["-c", "true"],
  cwd: "/workspace",
};

function policy(network: NetworkPolicy) {
  return resolveSandboxPolicy({
    mode: "workspace-write",
    workspaceRoot: "/workspace",
    network,
  });
}

describe("network policy rendering", () => {
  it.each(["none", "proxy"] as const)("fails closed in bubblewrap for %s", async (network) => {
    const args = await buildBwrapArgs(request, policy(network));
    expect(args).toContain("--unshare-net");
  });

  it("exposes the host network to bubblewrap only for full access", async () => {
    const args = await buildBwrapArgs(request, policy("full"));
    expect(args).not.toContain("--unshare-net");
  });

  it.each(["none", "proxy"] as const)("fails closed in Docker for %s", (network) => {
    const args = buildDockerArgs(request, policy(network));
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });

  it("attaches Docker to the bridge network only for full access", () => {
    const args = buildDockerArgs(request, policy("full"));
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
  });

  it("denies all network traffic in the Seatbelt profile for none", () => {
    const profile = renderSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      deniedReads: [],
      network: "none",
    });
    expect(profile).toContain("(deny network*)");
  });

  it("limits Seatbelt proxy traffic to localhost", () => {
    const profile = renderSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ["/workspace"],
      deniedReads: [],
      network: "proxy",
    });
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).not.toContain("(allow network*)");
  });
});

describe("denied reads under full access", () => {
  const fullAccess = resolveSandboxPolicy({
    mode: "danger-full-access",
    workspaceRoot: "/workspace",
    deniedReads: ["/etc"],
  });

  it("keeps the Seatbelt deny list after allow-default", () => {
    const profile = renderSeatbeltProfile({
      mode: "danger-full-access",
      writableRoots: ["/"],
      deniedReads: ["/etc"],
      network: "full",
    });
    expect(profile).toContain("(allow default)");
    expect(profile).toContain('(deny file-read* (subpath "/etc"))');
  });

  it("masks the denied path in bubblewrap", async () => {
    const args = await buildBwrapArgs(request, fullAccess);
    expect(args.slice(0, 3)).toEqual(["--dev-bind", "/", "/"]);
    expect(args.join(" ")).toContain("--tmpfs /etc");
  });

  it("masks the denied path in Docker", () => {
    const args = buildDockerArgs(request, fullAccess);
    expect(args.join(" ")).toContain("--tmpfs /etc:ro");
  });
});
