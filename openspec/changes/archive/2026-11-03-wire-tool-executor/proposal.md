# Proposal

## Why

`pika serve`, and therefore the default local mode used by the TUI, builds a session server without a tool executor. Every model tool call fails with `no tool executor is configured`, so the interactive client cannot read, edit, or run anything even though the core registry, path policy, sandbox executors, and approval flow already exist and are tested. The missing piece is composition: the server never selects a sandbox backend, builds the built-in tools for a session, or passes an executor and provider declarations into the runtime.

## What Changes

- Expose a built-in tool set (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`) to every session started, resumed, or forked by the locally started server.
- Bind tools per session: file tools use a `PathPolicy` rooted at the session workspace, and shell-based tools run with that workspace as their working directory, so forked sessions with a different `cwd` do not inherit another session's root.
- Replace the separate `tools` and `toolExecutor` server options with a per-session tooling factory that returns matching provider declarations and executor, so the two can never diverge and the runtime policy is known when tools are built.
- Select a sandbox executor at server startup from `--sandbox-backend` / `PIKA_SANDBOX_BACKEND` (default `auto`): Seatbelt on macOS and bubblewrap on Linux, with Docker and `none` available only when explicitly requested. An unavailable explicit backend fails startup instead of silently degrading; `none` is an explicit opt-in with no OS isolation.
- Pass each call's effective policy into the path policy for `glob` and `grep`, matching the behaviour of the file tools and `bash`, so a session-wide sandbox change applies consistently.
- Persist oversized tool output under `<sessionsDir>/<sessionId>/outputs` and return the stored path to the model.
- Reuse the existing approval protocol and TUI `/approve` and `/deny` commands; no protocol or schema change is required.
- Update `pika serve --help`, `pika --help`, and `docs/cli.md` with the new backend option and the tool-execution behaviour.

Out of scope: MCP or Agent Skills tools, a network proxy, per-tool allowlists or enablement configuration, new approval UI, Windows support, automatic Docker fallback, and changes to the WebSocket protocol.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-system`: adds requirements for the server-provided built-in tool set and for per-session workspace binding of those tools.
- `sandbox`: adds a requirement for server startup executor selection, backend reporting, and fail-fast behaviour when a requested backend is unavailable.

## Impact

- `packages/server`: `SessionServerOptions` gains a per-session tooling factory; `session-server.ts` resolves it when creating a runtime; `serve.ts` selects the backend and composes the built-in tooling; new tooling module and tests.
- `packages/core`: `glob` and `grep` pass the effective sandbox policy to `PathPolicy`; no public type changes.
- `packages/adapters`: reuses `NodeProcessExecutor`, `SeatbeltExecutor`, `createBwrapExecutor`, `createDockerExecutor`, `seatbeltAvailable`, and `FileToolOutputStore`; no adapter changes expected.
- `apps/pika`: no code change required because the launcher already forwards `PIKA_*` to the server child; `PIKA_SANDBOX_BACKEND` therefore works in local mode.
- Tests: server/helper fixtures move to the tooling factory; serve tests pin `sandboxBackend: "none"` for platform independence; new integration coverage exercises real file and shell tools through the server.
- No database, protocol, or session-record migration. Existing sessions resume with tools available.
