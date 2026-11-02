# Pika Harness

A learning-first TypeScript agent harness. The goal is to understand harness engineering by building the core loop, context pipeline, tool system, sandbox, session store, and protocol, while reusing proven libraries for providers and terminal UI.

Status: foundation. Implemented and tested: the normalized event schema, single-writer turn loop, faux provider, in-memory and JSONL session stores, sandbox policy and path policy, prompt builder with `AGENTS.md` discovery, context projection, token estimation and compaction planning, and the tool registry and batch executor. Provider adapters, real sandbox executors, protocol, SDK/CLI, and skills/MCP remain.

## Layout

```
apps/cli/            pi-tui terminal client
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
```

## Build

```bash
bun run build          # per-package dist plus standalone binaries
bun run build:js       # per-package dist only
bun run build:binary   # standalone binaries only
```

The binary build uses `bun build --compile`, which embeds the Bun runtime and all dependencies, so the result does not need `node_modules`:

```bash
./dist/bin/pika-server --port 7331
./dist/bin/pika --prompt "hello"
```

To run from a global install instead of the standalone binaries:

```bash
bun run link:global
pika --help
pika-server --help
```

`bun link` installs the shims into `~/.bun/bin`, which the Bun installer adds to `PATH`.

See [Providers](docs/providers.md) for configuring an OpenAI-compatible LLM endpoint.

## Interactive client

`pika` connects to `pika-server` over WebSocket and dispatches slash commands locally:

```text
/help /models /model /config /status /usage /context
/new /sessions /resume /fork /handoff /sandbox
/compact /btw /approve /deny /quit
```

Model presets load from `.pika/models.json` or `PIKA_MODELS_FILE`; API keys are referenced by environment variable name only. `/model` and `/handoff` fork the current session instead of changing it in place. See [CLI](docs/cli.md) for the catalog format, precedence rules, and command semantics.

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
