# Pika Harness

A learning-first TypeScript agent harness. The goal is to understand harness engineering by building the core loop, context pipeline, tool system, sandbox, session store, and protocol, while reusing proven libraries for providers and terminal UI.

Status: foundation. The repository currently contains the workspace scaffold and the OpenSpec change that defines the architecture. Runtime code lands in later tasks.

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

- [Architecture](docs/architecture.md)
- [Foundation proposal](openspec/changes/agent-harness-foundation/proposal.md)
- [Foundation design](openspec/changes/agent-harness-foundation/design.md)
- [Implementation tasks](openspec/changes/agent-harness-foundation/tasks.md)

## Security posture

Approval is a UX layer; the sandbox executor is the enforcement boundary. The default sandbox mode has no network access, child processes receive only an allowlisted environment, and in-process file tools enforce the same path policy as subprocess execution. See the design document for the threat model and backend plan.

## License

Not selected yet.
