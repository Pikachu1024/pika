# Architecture

## Package graph

```
packages/schema
   ^            ^
   |            |
packages/core  packages/client
   ^              ^
   |              |
packages/adapters  apps/cli
   ^
   |
packages/server
```

Arrows point from a dependent to its dependency. `adapters` and `server` also import `schema` directly, and `server` imports `core` directly.

The dependency direction is one-way:

```
schema <-- core <-- adapters <-- server
   ^
   +------ client <-- cli
```

## Responsibilities

| Workspace           | Responsibility                                                                                | Allowed workspace imports    |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| `packages/schema`   | Protocol messages, events, session records, approvals, sandbox policies                       | None                         |
| `packages/core`     | Runtime loop, context pipeline, prompt assembly, tool registry, sandbox policy, session ports | `schema`                     |
| `packages/adapters` | `pi-ai` providers, MCP, sandbox executors, JSONL/SQLite storage                               | `schema`, `core` port types  |
| `packages/server`   | Session manager, subscriptions, approval routing, transports                                  | `schema`, `core`, `adapters` |
| `packages/client`   | Typed protocol client                                                                         | `schema`                     |
| `apps/cli`          | `pi-tui` terminal client                                                                      | `schema`, `client`           |

## Boundaries

### Protocol boundary

The runtime and the session store are not imported by clients. Every client, including the CLI, talks through `packages/schema` messages and the protocol implementation. This prevents the CLI from becoming a second runtime.

### Sandbox boundary

All subprocess execution goes through the sandbox executor. Only `packages/adapters/src/sandbox/` may import `node:child_process`. Approval decides whether a command runs; the executor bounds what it can touch. In-process file tools use the same path policy as subprocess execution.

### Session boundary

The append-only session log is the source of truth. Context projection, prompt hashes, and indexes are derived views. Replay folds the log and must not mutate it.

## Enforcement

`pnpm boundary` runs `scripts/check-boundaries.mjs`. It checks:

- forbidden workspace imports per package,
- direct `node:child_process` imports outside the sandbox adapter,
- dynamic `import()` and `require()` in source.

The check is part of `pnpm check` and CI.

## Current state

This is the foundation scaffold. The agent runtime, schemas, sandbox executors, session store, and protocol are specified in `openspec/changes/agent-harness-foundation/` and implemented in later tasks. When the package graph changes, update this document and the boundary rules together.
