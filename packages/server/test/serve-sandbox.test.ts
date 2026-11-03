import { describe, expect, it } from "bun:test";
import type { Executor } from "@pika-harness/core";
import type { SandboxBackend } from "@pika-harness/schema";
import { createServeSandbox } from "../src/index.js";

function fakeExecutor(backend: SandboxBackend): Executor {
  return {
    backend,
    async exec() {
      throw new Error("executor is not invoked in this test");
    },
    async probe() {
      return {
        backend,
        filesystemIsolation: backend !== "none",
        networkIsolation: backend !== "none",
        processIsolation: backend !== "none",
      };
    },
  };
}

describe("serve sandbox selection", () => {
  it("uses the unisolated node executor only when none is explicit", async () => {
    const executor = fakeExecutor("none");
    const resolved = await createServeSandbox("none", { nodeExecutor: () => executor });

    expect(resolved).toEqual({ executor, backend: "none" });
  });

  it("selects seatbelt when it is available", async () => {
    const executor = fakeExecutor("seatbelt");
    const resolved = await createServeSandbox("seatbelt", {
      seatbeltAvailable: async () => true,
      seatbeltExecutor: () => executor,
    });

    expect(resolved).toEqual({ executor, backend: "seatbelt" });
  });

  it("fails startup when an explicit seatbelt backend is unavailable", async () => {
    await expect(
      createServeSandbox("seatbelt", { seatbeltAvailable: async () => false }),
    ).rejects.toThrow(/seatbelt.*sandbox-exec/);
  });

  it("selects bwrap when it is available", async () => {
    const executor = fakeExecutor("bwrap");
    const resolved = await createServeSandbox("bwrap", { bwrapExecutor: () => executor });

    expect(resolved).toEqual({ executor, backend: "bwrap" });
  });

  it("fails startup when an explicit bwrap backend is unavailable", async () => {
    await expect(createServeSandbox("bwrap", { bwrapExecutor: () => undefined })).rejects.toThrow(
      /bwrap.*bubblewrap/,
    );
  });

  it("selects docker when it is available", async () => {
    const executor = fakeExecutor("docker");
    const resolved = await createServeSandbox("docker", { dockerExecutor: () => executor });

    expect(resolved).toEqual({ executor, backend: "docker" });
  });

  it("fails startup when an explicit docker backend is unavailable", async () => {
    await expect(createServeSandbox("docker", { dockerExecutor: () => undefined })).rejects.toThrow(
      /docker.*daemon/,
    );
  });

  it("auto-selects seatbelt on macOS", async () => {
    const executor = fakeExecutor("seatbelt");
    const resolved = await createServeSandbox("auto", {
      platform: "darwin",
      seatbeltAvailable: async () => true,
      seatbeltExecutor: () => executor,
      bwrapExecutor: () => undefined,
    });

    expect(resolved).toEqual({ executor, backend: "seatbelt" });
  });

  it("auto-selects bwrap on Linux", async () => {
    const executor = fakeExecutor("bwrap");
    const resolved = await createServeSandbox("auto", {
      platform: "linux",
      seatbeltAvailable: async () => false,
      bwrapExecutor: () => executor,
    });

    expect(resolved).toEqual({ executor, backend: "bwrap" });
  });

  it("fails auto selection when seatbelt is unavailable on macOS", async () => {
    await expect(
      createServeSandbox("auto", {
        platform: "darwin",
        seatbeltAvailable: async () => false,
      }),
    ).rejects.toThrow(/--sandbox-backend none/);
  });

  it("fails auto selection when bwrap is unavailable on Linux", async () => {
    await expect(
      createServeSandbox("auto", {
        platform: "linux",
        bwrapExecutor: () => undefined,
      }),
    ).rejects.toThrow(/--sandbox-backend none/);
  });

  it("fails auto selection on an unsupported platform and names the choices", async () => {
    await expect(createServeSandbox("auto", { platform: "win32" })).rejects.toThrow(
      /seatbelt.*bwrap.*docker.*--sandbox-backend none/,
    );
  });
});
