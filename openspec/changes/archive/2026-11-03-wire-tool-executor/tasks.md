# Tasks

## 1. Per-session tooling API

- [x] 1.1 Replace `SessionServerOptions.tools` and `.toolExecutor` with `tooling?: SessionTooling | ((context: SessionContext, policy: SandboxPolicy) => SessionTooling)`, resolve it once in `#createRuntime`, and export the new types; update `test/helpers.ts` and `packages/server/test/session-server.test.ts` to build `tooling` from their registry, then verify `bun test packages/server/test/session-server.test.ts` passes.
- [x] 1.2 Add a server test proving that a provider declaration and its executor come from the same tooling pair and that a server without `tooling` still returns the explicit not-configured result; verify the new assertions pass in `bun test packages/server/test/session-server.test.ts`.

## 2. Built-in session tooling

- [x] 2.1 Implement `createServeTooling({ sessionsDir, executor })` in `packages/server/src/serve-tooling.ts`, registering `read_file`, `write_file`, `edit_file`, `glob`, `grep`, and `bash` with a per-session `PathPolicy` and `ToolBatchExecutor`; verify a new `packages/server/test/serve-tooling.test.ts` asserts the six provider declarations and a successful `read_file` call.
- [x] 2.2 Root the output store at `<sessionsDir>/<sessionId>/outputs` and add a test that configures a small `maxOutputBytes` through `ServerSandboxOptions`, produces an oversized result, and asserts the returned reference path is inside that directory; verify `bun test packages/server/test/serve-tooling.test.ts` passes.
- [x] 2.3 Add isolation tests for two sessions with different workspaces, including a forked session with a new `cwd`, and a write attempt escaping the workspace; verify the tests pass and no cross-session path is used.
- [x] 2.4 Reject a session id containing path separators or `..` before building the output directory, reusing the JSONL store's rules, and add a test that the factory rejects `../escape` without creating a directory; verify the test passes.

## 3. Effective policy in path checks

- [x] 3.1 Pass `context.sandboxPolicy` to `PathPolicy.resolve` in `glob` and `grep`, matching `read_file`, `write_file`, and `edit_file`; verify `bun test packages/core/test/tool/shell-tools.test.ts` passes.
- [x] 3.2 Add a test where the bound policy is `workspace-write` but the call policy is `danger-full-access`, proving the widened policy authorizes a path outside the workspace and the executor receives it; verify the test passes.

## 4. Sandbox backend selection

- [x] 4.1 Implement `createServeSandbox(selection, deps?)` in `packages/server/src/serve-sandbox.ts` for `none`, `seatbelt`, `bwrap`, `docker`, and `auto`, with injectable factories; verify a new unit test covers every success and failure branch, including auto on macOS, auto on Linux, and an unavailable explicit backend.
- [x] 4.2 Add `sandboxBackend` to `ServeOptions` and parse `PIKA_SANDBOX_BACKEND` and `--sandbox-backend` in `parseServeArgs`, rejecting unknown values with the accepted list; verify new cases in `packages/server/test/serve.test.ts` for the default, the environment value, the flag override, and an invalid value.
- [x] 4.3 Update `serveUsage` with the backend values, auto order, and the explicit `none` caveat; verify `serveUsage` contains every accepted value and `parseServeArgs(["--help"]).help` remains true.

## 5. Serve wiring

- [x] 5.1 Resolve the backend in `startServe`, pass the executor into `createServeTooling`, and pass the resolved backend into `ServerSandboxOptions`; verify a `startServe` test with `sandboxBackend: "none"` returns `sandbox.backend === "none"` from `session.start`, and an unavailable explicit backend rejects before a listener URL is returned.
- [x] 5.2 Pin `sandboxBackend: "none"` in the existing `startServe` tests and set `PIKA_SANDBOX_BACKEND=none` in the spawned serve-entry test; verify `bun test packages/server/test/serve.test.ts` passes on a host without isolation binaries.
- [x] 5.3 Add an end-to-end server test that drives a `read_file` and a `write_file` tool call through the protocol using `createServeTooling` and the `none` executor, then verify the tool results, the file contents, and the `tool_execution_*` events.

## 6. Documentation

- [x] 6.1 Update `docs/cli.md` with the built-in tool set, `--sandbox-backend` values and auto order, the `none` caveat, and the fact that local TUI mode selects the backend through `PIKA_SANDBOX_BACKEND` while `pika serve` also accepts the flag; verify the documented command and flag names match `serveUsage`.
- [x] 6.2 Update `docs/architecture.md` where it describes the executor boundary to state that serve selects one executor at startup and binds tools per session; verify the description matches the implemented configuration surface.
- [x] 6.3 Update `apps/pika/src/usage.ts` so `pika --help` lists `--sandbox-backend` on the serve line and `PIKA_SANDBOX_BACKEND` in the environment list; verify `bun apps/pika/src/bin.ts --help` prints both.

## 7. Integration verification

- [ ] 7.1 Run `bun run check` and confirm typecheck, lint, boundary checks, and all tests pass.
- [x] 7.2 Run the interactive TUI against a local fake OpenAI-compatible endpoint and confirm a model tool call reads and writes a workspace file, a sandbox denial can be denied from the TUI, and `/status` still reports the session normally; record the observed transcript and file contents.
- [x] 7.3 Run `bun run build:binary` and repeat one tool-execution turn through the standalone binary to confirm the composition works outside the source runner.

## Workflow follow-up

- Archive the change after review and verification.
