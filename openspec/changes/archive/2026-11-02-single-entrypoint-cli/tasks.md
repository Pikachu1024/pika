# Tasks

## 1. Server Startup and Authentication

- [x] 1.1 Extract reusable server startup (`parseServeArgs`, `runServer`, provider/compaction wiring) from `packages/server/src/bin.ts` into a server module that both the dev entry and the new launcher can call; verify existing server tests pass and `bun packages/server/src/bin.ts --port 0` still prints a listening URL.
- [x] 1.2 Add optional token verification to `startWebSocketServer` using a constant-time comparison, rejecting missing or mismatched tokens with 401 before any JSON-RPC frame is read; verify tests connect a `ws` client with the correct token (protocol works), without a token, and with a stale token (both rejected, zero frames received).
- [x] 1.3 Add the ready line and an `--exit-on-parent-stdin-close` option to the server entry; verify a spawned server prints the actual ephemeral-port URL, exits when stdin closes, and leaves no listener behind.
- [x] 1.4 Document the server-side token and parent-close behavior in `docs/architecture.md`; verify the described flags match `parseServeArgs` and the documented commands run as written.

## 2. Client Transport and Callable CLI

- [x] 2.1 Accept an optional per-run token in `createWebSocketClientTransport` and append it as an encoded query parameter; verify unit tests cover token present, token absent, and special characters, and that stdio/in-process transports are untouched.
- [x] 2.2 Export `runClient(argv)` from `apps/cli` and reduce `main()` to a `process.argv` wrapper; verify existing CLI tests still pass and `bun apps/cli/src/cli.ts --help` works.
- [x] 2.3 Add a unified usage text to the launcher covering client flags, `--url` remote mode, `serve` mode, and environment variables; verify `pika --help` prints it without starting a server or spawning a child.

## 3. Launcher Lifecycle

- [x] 3.1 Create the `apps/pika` workspace package with strict tsconfig, `bin: { "pika": "./dist/bin.js" }`, and the launcher entry; verify `bun run typecheck` covers it and `bun apps/pika/src/bin.ts --help` runs.
- [x] 3.2 Implement mode dispatch: `serve` runs the server directly, while client mode starts no server when `--url` or `PIKA_SERVER_URL` is set; verify an integration test proves remote mode spawns nothing while local mode spawns exactly one child.
- [x] 3.3 Implement local startup: generate a 32-byte token, spawn the same executable in serve mode with the explicit environment allowlist and inherited cwd, parse the listening URL with a 10 second timeout, and inject `--url` into `runClient`; verify tests cover success, early child exit, malformed output, and timeout, each exiting non-zero without entering the UI.
- [x] 3.4 Implement teardown for normal exit, one-shot completion, SIGINT, SIGTERM, and startup failure (SIGTERM then SIGKILL after a grace period); verify a test runs a one-shot prompt and asserts the child exited and no listener remains on the negotiated port.
- [x] 3.5 Ensure `pika serve` keeps the existing server flags and prints the listening URL; verify `pika serve --help`, `pika serve --port 0`, and `PIKA_SESSION_DIR` override behavior.
- [x] 3.6 Document local lifecycle, `--url` remote mode, and `pika serve` in `docs/cli.md` and `README.md`; verify the documented one-command quickstart runs against the echo provider.

## 4. Packaging and Boundaries

- [x] 4.1 Switch `scripts/build-binaries.ts` to the single `pika` target, move the bin field from `apps/cli` to `apps/pika`, remove the `pika-server` bin, and update root `cli`/`server`/`link:global` scripts; verify `bun run build:binary` emits only `dist/bin/pika` and `./dist/bin/pika --help` works after copying it outside the repository.
- [x] 4.2 Update `scripts/check-boundaries.mjs` and `AGENTS.md` to describe `apps/pika` as the composition root that may import every workspace package, while keeping `apps/cli` protocol-only and keeping `node:child_process` banned outside the sandbox adapter; verify `bun run boundary` passes and a deliberate CLI-to-server import fails it.
- [x] 4.3 Update the repository layout and command documentation in `README.md` and `AGENTS.md` for the new app and removed binary; verify every documented command exists in the relevant `package.json`.

## 5. Integration Verification

- [x] 5.1 Add an end-to-end test that runs the real launcher (not a stub) with `--prompt`, talks to the echo provider through the local server, and asserts output plus clean exit; verify `bun test` passes.
- [x] 5.2 Run a scripted pty session against the launcher with no `--url`, send a prompt, a slash command, and quit; verify the transcript renders the echo reply, the exit code is 0, and no process listens on the negotiated port afterward.
- [x] 5.3 Run `bun run check` and fix all typecheck, lint, boundary, and test failures.

## Workflow follow-up

- Archive this change after the project's review requirements are satisfied.
- Verify the archived change removed the `pika-server` packaging and that the recorded capability deltas match the shipped behavior.
