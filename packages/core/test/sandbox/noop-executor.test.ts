import { describe, expect, it } from "bun:test";
import { NoopExecutor, SandboxExecutionError } from "../../src/sandbox/noop-executor.js";
import { resolveSandboxPolicy } from "../../src/sandbox/policy.js";

const request = { program: "echo", args: ["hello"], cwd: "/tmp" };

describe("NoopExecutor", () => {
  it("records backend none", () => {
    expect(new NoopExecutor().backend).toBe("none");
  });

  it("reports no isolation capabilities", async () => {
    const capabilities = await new NoopExecutor().probe();
    expect(capabilities).toEqual({
      backend: "none",
      filesystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    });
  });

  it("rejects exec instead of spawning a process", async () => {
    const policy = resolveSandboxPolicy({ mode: "read-only", workspaceRoot: "/tmp" });
    await expect(new NoopExecutor().exec(request, policy)).rejects.toBeInstanceOf(
      SandboxExecutionError,
    );
    await expect(new NoopExecutor().exec(request, policy)).rejects.toThrow(/no sandbox backend/);
  });
});
