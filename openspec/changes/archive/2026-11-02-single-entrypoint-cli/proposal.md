# Proposal

## Why

Today a user must start `pika-server` in one terminal and `pika` in another, and the build emits two binaries. Every comparable terminal agent exposes one command that starts what it needs and cleans up after itself; requiring two processes is an onboarding and packaging burden with no user-visible benefit.

## What Changes

- **BREAKING** Ship one executable, `pika`. The TUI, one-shot mode, and the session server all live behind that entrypoint; the standalone `pika-server` binary is removed.
- Add a hidden `pika serve` mode that runs the JSON-RPC session server for remote or multi-client use.
- By default `pika` starts a bundled local server on `127.0.0.1` with an ephemeral port and a per-run random token, connects the client to it, and shuts it down when the client exits, including on SIGINT/SIGTERM and failed startup.
- Keep `--url` (and `PIKA_SERVER_URL`) as the remote mode: when set, `pika` connects to that endpoint and starts no local server.
- Authenticate local WebSocket connections with the per-run token; the server rejects connections without it. The token is never printed, logged, or written to session data.
- Provide a startup handshake so the client learns the actual port before connecting, and make the local server exit if its parent disappears.
- Pass session storage through unchanged: an auto-started server stores sessions under `<cwd>/.pika/sessions` unless `PIKA_SESSION_DIR` is set.
- Update the build script, boundary checks, README, and architecture/CLI docs to describe the single-entrypoint model.

Out of scope:

- Daemonizing, sharing one local server between independent `pika` invocations, or auto-restart supervision.
- Remote authentication beyond the per-run token (TLS termination, user accounts, and authorization policy stay outside this change).
- Changing the protocol methods, sandbox enforcement, approval flow, or session storage format.
- Windows-specific service integration; the launcher targets macOS/Linux process lifecycle.
- A user-facing configuration file for local server settings beyond the existing `PIKA_*` environment variables.

## Capabilities

### New Capabilities

- `local-server-lifecycle`: how the single `pika` entrypoint starts, authenticates, connects to, and tears down its bundled local server, and how `--url` and `pika serve` expose the remote mode.

### Modified Capabilities

- `client-protocol`: the WebSocket transport gains per-run token authentication for local connections, while stdio and in-process transports keep their current semantics.

## Impact

- `apps/pika`: new composition-root launcher that dispatches between client and `serve` modes, spawns and supervises the local server, and reuses the existing CLI entry.
- `apps/cli`: expose a callable client entry that accepts an explicit URL and argv instead of only reading `process.argv`; no protocol or TUI logic moves into the launcher.
- `packages/server`: extract reusable server startup from `bin.ts`, add token verification and exit-on-parent-stdin-close, and keep `createSessionServer` and `startWebSocketServer` as the composition surface.
- `packages/client`: accept an optional token when creating a WebSocket transport.
- `packages/schema`: no wire-message changes; the token rides on the WebSocket handshake, not on JSON-RPC frames.
- `scripts/build-binaries.ts`: emit only the `pika` target.
- `scripts/check-boundaries.mjs` and `AGENTS.md`: record that the launcher is the composition root allowed to import client, CLI, server, and adapters, while the CLI itself stays protocol-only.
- `README.md`, `docs/cli.md`, `docs/architecture.md`: one-command quickstart, `pika serve` for remote mode, and local lifecycle behavior.
