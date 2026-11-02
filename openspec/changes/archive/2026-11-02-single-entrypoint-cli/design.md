# Design

## Context

See `proposal.md` for motivation and the spec deltas for observable behavior.

Current constraints:

- `apps/cli` must not import `server`, `adapters`, or `core`; it is protocol-only and currently owns the `pika` bin.
- `packages/server/src/bin.ts` already contains all server wiring (JSONL store, provider factory, compaction, WebSocket listener) but is only reachable as a separate process.
- `startWebSocketServer` binds loopback by default and returns the actual URL, so an ephemeral port already works.
- `createWebSocketClientTransport` uses the runtime's global `WebSocket` and accepts any URL, so a token can ride on the query string without protocol changes.
- Only `packages/adapters/src/sandbox` may import `node:child_process`.
- The CLI targets Bun 1.4 and is shipped as a `bun build --compile` binary, so the launcher can rely on Bun's process APIs.

## Goals / Non-Goals

**Goals:**

- One `pika` binary and one user command for local use, while keeping the client protocol-only.
- Keep the server's wiring and lifecycle testable in isolation from the TUI.
- Fail closed: no unauthenticated local listener, no orphaned server, no startup that silently falls back to a wrong endpoint.
- Preserve remote mode exactly as it works today.

**Non-Goals:**

- Sharing one local server across multiple `pika` processes or reconnecting after a client crash.
- Service management (launchd/systemd), auto-update, or restart supervision.
- TLS, user accounts, or remote authorization policy.
- Moving tool execution, sandbox policy, or approvals into the client.

## Decisions

### D1. A new `apps/pika` composition root owns process startup

`apps/pika` is a thin launcher whose only jobs are: parse the top-level mode, start and supervise the local server, then call the existing CLI with an explicit URL. It imports `@pika-harness/cli`, `@pika-harness/server`, and `@pika-harness/adapters`; the CLI package stays protocol-only.

`apps/cli` exposes `runClient(argv: string[]): Promise<void>` (with `main()` reduced to a wrapper over `process.argv`). The launcher injects `--url <local url>` when no remote endpoint is configured.

Alternatives considered:

- Let `apps/cli` import the server and embed it. Rejected: breaks the documented dependency boundary and the "CLI is a protocol client" invariant, which the existing spec and boundary check enforce.
- Keep `pika` and `pika-server` and have `pika` exec a sibling binary. Rejected: breaks single-file distribution and requires brittle path discovery for copied binaries.
- Build one binary from a root-level script. Rejected: `apps/pika` stays inside the workspace conventions and gets typecheck, lint, and boundary coverage like any other app.

### D2. The launcher spawns the same executable in serve mode

`pika` re-executes itself with a hidden server mode (`pika serve` for humans, and the same dispatch path for the child). The launcher uses `Bun.spawn` and passes server arguments explicitly; it never spawns user-provided commands. This keeps `node:child_process` banned everywhere except the sandbox adapter and scopes the exception to self-execution for process lifecycle:

- Compiled binary: spawn `[process.execPath, "serve", ...]`.
- Development (`bun apps/pika/src/bin.ts`): spawn `[process.execPath, <entry>, "serve", ...]`.
- The launcher passes `cwd: process.cwd()` so the server's default session directory remains `<cwd>/.pika/sessions`.

The child receives an explicit environment allowlist rather than inheriting `process.env`: `PIKA_*`, `HOME`, `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ`, and the standard proxy/CA variables. Anything else is dropped, matching the repository's child-environment rule.

Alternatives considered:

- In-process server (pi-style single process). Rejected for this change: the user selected the opencode-style model, and crash isolation plus a real WebSocket hop keep the protocol boundary honest. It remains a valid later simplification because the server surface is unchanged.
- A supervisor with restart/backoff. Rejected: a local TUI that loses its server should exit, not silently restart.

### D3. Readiness uses the existing listening line

The server prints `pika-server listening on ws://host:port` after `startWebSocketServer` resolves. The parent reads the child's stdout until it sees that line (10 second timeout), extracts the URL, appends the token, and then calls `runClient`. Any early exit, timeout, or malformed line is reported with the child's stderr and exits non-zero. Nothing else from the child's stdout is forwarded into the TUI.

Alternatives considered: a ready file or a separate handshake channel. Rejected as unnecessary; the line already exists and stays useful for `pika serve`.

### D4. Per-run token on the WebSocket query string

The launcher generates 32 random bytes (`base64url`) per run and passes them to the child through `PIKA_SERVER_TOKEN` rather than argv, so the token does not appear in the process table listing. The client connects to `ws://127.0.0.1:<port>/?token=<token>`.

`startWebSocketServer` gains an optional token. When set, `ws`'s `verifyClient` compares the query token with a constant-time comparison and rejects missing or wrong tokens with 401 before any JSON-RPC frame is read. When unset (remote/standalone serve), behavior is unchanged.

Alternatives considered:

- In-band authentication after `initialize`. Rejected: the socket would already accept JSON-RPC frames and leaks error detail before authentication.
- `Sec-WebSocket-Protocol` token. Rejected: browser/global `WebSocket` subprotocol handling is stricter and buys nothing over loopback plus a short-lived query token.
- No token at all. Rejected: any local process could drive the session store and provider credentials on a predictable port. Ephemeral ports alone are not access control.

### D5. Teardown is bidirectional

- Parent to child: the launcher kills the child (`SIGTERM`, then `SIGKILL` after a short grace) on normal UI exit, one-shot completion, startup failure, and SIGINT/SIGTERM. The CLI's existing `process.exit(0)` path is preceded by an `exit` hook that best-effort kills the child.
- Child to parent: when spawned with `--exit-on-parent-stdin-close`, the server treats stdin EOF as a shutdown signal. If the client dies without cleanup, the closed pipe still stops the server.
- `pika serve` (human-run) does not enable the stdin guard; it shuts down on SIGINT/SIGTERM as today.

The server's shutdown closes the listener and the session server, so no listener or in-flight subscriber survives.

### D6. Single build target and package ownership

`scripts/build-binaries.ts` emits only `pika` from `apps/pika/src/bin.ts`. The `pika-server` bin entry and target are removed; `packages/server/src/bin.ts` remains a development entry. `apps/cli` becomes a library-style package without a `bin` field, and `apps/pika` owns `bin: { "pika": "./dist/bin.js" }`. Root scripts (`cli`, `server`) point at the new launcher so development matches the shipped binary.

`scripts/check-boundaries.mjs` records the launcher as the composition root: it may import every workspace package, while the existing rules for `cli`, `client`, `core`, `adapters`, `server`, and the `node:child_process` ban remain intact. `AGENTS.md` documents the self-exec/process-management exception.

### D7. One help surface

The launcher intercepts `--help`/`-h` before starting anything and prints the unified usage (client flags, `--url` semantics, `serve` mode, remote environment variables). `pika serve --help` delegates to the server usage. `pika --help` must never start a server.

## Risks / Trade-offs

- [Orphaned server if the client is SIGKILLed] → The stdin-close guard plus the parent `exit` hook; `pika serve` output includes the URL for manual recovery.
- [Token exposure through the child environment or socket URL] → Token is per-run, loopback-only, never printed or persisted; environment filtering keeps unrelated secrets out of the child.
- [Startup adds latency and a failure mode] → Ephemeral port plus a 10 second ceiling, and a clear non-zero exit rather than a TUI pointed at the wrong endpoint.
- [Re-exec path differs between `bun run` and the compiled binary] → One small `serverCommand()` helper with an integration test for both modes.
- [Removing `pika-server` breaks existing scripts] → Documented as a breaking change with `pika serve` as the replacement; the server CLI semantics (port, host, dir) stay the same.
- [Two entry surfaces can diverge] → The launcher owns all startup flags; the server keeps only server flags, and help text is generated from each side's parser.
- [Windows process semantics are untested] → Explicit non-goal; kill/EOF handling targets macOS and Linux.

## Migration Plan

1. Add the launcher and server extraction behind the existing CLI; keep both entrypoints working during development.
2. Switch root scripts, the bin field, and the binary build to `pika`; remove `pika-server` packaging.
3. Update README, `docs/cli.md`, `docs/architecture.md`, and `AGENTS.md`.
4. Update remote users to `pika serve` (or keep running a published server build) and local users to plain `pika`.

Rollback: restore the two-target build and the `pika-server` bin; the server and client code paths remain compatible because no wire messages changed.
