# Pika Harness

A learning-first TypeScript agent harness. The goal is to understand harness engineering by building the core loop, context pipeline, tool system, sandbox, session store, and protocol, while reusing proven libraries for providers and terminal UI.

Status: foundation. Implemented and tested: the normalized event schema, single-writer turn loop, faux provider, in-memory and JSONL session stores, sandbox policy and path policy, prompt builder with `AGENTS.md` discovery, context projection, token estimation and compaction planning, and the tool registry and batch executor. Provider adapters, real sandbox executors, protocol, SDK/CLI, and skills/MCP remain.

## Layout

```
apps/pika/           single `pika` entrypoint; starts a bundled local server
apps/cli/            pi-tui terminal client (protocol-only)
packages/schema/     protocol and event schemas
packages/core/       runtime, context, prompt, tools, sandbox policy, session ports
packages/server/     session manager, transports, approvals
packages/client/     typed protocol client
packages/adapters/   pi-ai providers, MCP, sandbox executors, storage
docs/                architecture and subsystem docs
openspec/            proposals, specs, designs, and task tracking
```

## Quickstart

Requires Bun 1.4 or newer.

```bash
bun install
bun run check
bun apps/pika/src/bin.ts --prompt "hello"   # starts and stops a local server
```

`pika` starts a server on `127.0.0.1` with an ephemeral port and a per-run token, then stops it when the client exits. Run `pika serve` if you want to keep a server running and connect later with `pika --url <ws://...>`.

## Build

```bash
bun run build          # per-package dist plus the standalone binary
bun run build:js       # per-package dist only
bun run build:binary   # standalone binary only
```

The binary build uses `bun build --compile`, which embeds the Bun runtime and all dependencies, so the result does not need `node_modules`:

```bash
./dist/bin/pika --prompt "hello"
./dist/bin/pika --help
```

Tagged releases (`v*`) run `.github/workflows/release.yml`, which publishes standalone binaries for macOS (arm64/x64) and Linux (x64/arm64) plus `SHA256SUMS` on GitHub Releases.

To install the standalone binary on your `PATH`:

```bash
bun run install:local          # builds and installs to ~/.local/bin
PIKA_INSTALL_DIR=/usr/local/bin bun run install:local
pika --help
```

The installer rebuilds with `bun run build:binary`, copies the result as `pika` with mode `0755`, and leaves an existing install untouched if the build fails. It prints the installed path and a `PATH` note only when the destination is not already on `PATH`.

To run from a global Bun install instead of the standalone binary:

```bash
bun run link:global
pika --help
```

`bun link` installs the shim into `~/.bun/bin`, which the Bun installer adds to `PATH`.

See [Providers](docs/providers.md) for configuring an OpenAI-compatible LLM endpoint.

## Interactive client

`pika` connects to a local server over WebSocket and dispatches slash commands locally:

```text
/help /models /model /config /status /usage /context
/new /sessions /resume /fork /handoff /sandbox
/compact /btw /approve /deny /quit
```

User state lives in the Pika home directory: `$PIKA_HOME`, defaulting to `~/.pika`. Sessions go to `$PIKA_HOME/sessions`, while user model presets and credentials live in `$PIKA_HOME/models.json` and `$PIKA_HOME/credentials.json`; `PIKA_SESSION_DIR`/`--dir` and `PIKA_CONFIG_DIR` override the individual paths. On first start, `models.json` and `credentials.json` are copied from the legacy `~/.config/pika` location when the new files are absent; existing files are never overwritten.

Model presets load from the Pika home and `.pika/models.json` (or `PIKA_MODELS_FILE`); API keys are referenced by environment variable name only. `/model` and `/handoff` fork the current session instead of changing it in place. See [CLI](docs/cli.md) for the local lifecycle, remote mode, catalog format, precedence rules, and command semantics.

## Commands

```bash
bun run typecheck
bun run lint
bun run boundary
bun run test
bun run check   # all of the above
```

## Documentation

- [Overall design](docs/design.md)
- [Framework selection](docs/framework-selection.md)
- [Architecture](docs/architecture.md)
- [Event contract](docs/events.md)
- [Providers](docs/providers.md)
- [CLI](docs/cli.md)
- [Tools](docs/tools.md)
- [Foundation proposal](openspec/changes/archive/2026-11-02-agent-harness-foundation/proposal.md)
- [Foundation design](openspec/changes/archive/2026-11-02-agent-harness-foundation/design.md)
- [Implementation tasks](openspec/changes/archive/2026-11-02-agent-harness-foundation/tasks.md)

## Security posture

Approval is a UX layer; the sandbox executor is the enforcement boundary. The default sandbox mode has no network access, child processes receive only an allowlisted environment, and in-process file tools enforce the same path policy as subprocess execution. See the design document for the threat model and backend plan.

## License

Not selected yet.
