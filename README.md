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

Requires Node 24 and pnpm 10.

```bash
pnpm install
pnpm check
```

## Commands

```bash
pnpm typecheck
pnpm lint
pnpm boundary
pnpm test
pnpm check   # all of the above
```

## Documentation

- [Overall design](docs/design.md)
- [Framework selection](docs/framework-selection.md)
- [Architecture](docs/architecture.md)
- [Event contract](docs/events.md)
- [Providers](docs/providers.md)
- [Tools](docs/tools.md)
- [Foundation proposal](openspec/changes/agent-harness-foundation/proposal.md)
- [Foundation design](openspec/changes/agent-harness-foundation/design.md)
- [Implementation tasks](openspec/changes/agent-harness-foundation/tasks.md)

## Security posture

Approval is a UX layer; the sandbox executor is the enforcement boundary. The default sandbox mode has no network access, child processes receive only an allowlisted environment, and in-process file tools enforce the same path policy as subprocess execution. See the design document for the threat model and backend plan.

## License

Not selected yet.
