# Proposal

## Why

We are starting a greenfield agent harness and want to learn harness engineering by building the core ourselves. Existing open-source harnesses are poor starting points for that goal: OpenCode, Kimi Code, and DeepSeek Harness are product-first and tightly coupled to their own runtimes; Codex is Rust and OpenAI-centric; Pi is the closest component library but has no built-in permission or sandbox boundary. We need a coherent architecture and a staged scope before writing code, so that the loop, context pipeline, tool system, sandbox, session records, and client protocol share one event and storage model instead of growing into separate code paths.

## What Changes

- Introduce a TypeScript monorepo with a one-way dependency direction: `schema -> core/protocol -> server`, with CLI and SDK as protocol clients only.
- Build a small agent runtime and event-driven turn loop with steering, follow-up, and interrupt semantics.
- Build a context pipeline: sectioned system prompt, per-request projection, cache-aware prompt ordering, and compaction as a recorded event.
- Build a tool system: registry, schema validation, approval-aware execution, output truncation, and lifecycle events.
- Introduce **sandbox as a first-class subsystem**, separate from approval: sandbox policy, platform executors (macOS Seatbelt first; bubblewrap/Docker later), environment scrubbing, path confinement, network policy, and auditable sandbox decisions. Approval decides whether a command runs; the sandbox bounds what it can touch.
- Build an append-only session store with a parent/child tree, deterministic replay, resume/fork, and a rebuildable SQLite index.
- Define a JSON-RPC-style protocol with stdio, WebSocket, and in-process transports; provide a typed SDK and a `pi-tui` CLI that consumes the protocol.
- Reuse `pi-ai` for providers, `pi-tui` for the terminal UI, and the official MCP SDK; use Codex, OpenCode, Kimi Code, DeepSeek Harness, and Pi as reference implementations rather than forks.
- No breaking changes; this is a greenfield foundation.

## Capabilities

### New Capabilities

- `agent-runtime`: Provider boundary, normalized streaming events, agent loop, turn/steering/follow-up/interrupt semantics, and runtime lifecycle events.
- `context-pipeline`: Sectioned system prompt assembly, deterministic per-request context projection, prompt-cache discipline, token estimation, and compaction policy.
- `tool-system`: Tool registry, schema validation, parallel-aware execution, result normalization, truncation, and tool lifecycle events.
- `sandbox`: Sandbox policy model, platform executors, filesystem and network confinement, environment scrubbing, approval integration, and sandbox decision audit events.
- `extensions`: Agent Skills discovery and lazy loading, MCP server lifecycle, OAuth, tool exposure filtering, and project trust gating.
- `session-store`: Append-only JSONL event log with a parent/child tree, deterministic replay, resume/fork, compaction records, and a rebuildable SQLite index.
- `client-protocol`: JSON-RPC-style protocol for sessions, turns, approvals, and sandbox control; typed SDK; CLI as the first protocol client.

### Modified Capabilities

- None. The project has no existing specs.

## Impact

- New monorepo and packages: `schema`, `core`, `server`, `client`, `adapters`, and `cli`.
- New dependencies: `pi-ai`, `pi-tui`, `@modelcontextprotocol/sdk`, `zod`, `tree-sitter-bash`, `better-sqlite3`.
- Platform support: macOS 15+ first (Seatbelt executor); Linux via bubblewrap or Docker; Windows deferred.
- Security posture: in-process approval is treated as UX, not a security boundary; the sandbox executor is the enforcement point.
- No data, API, or user migration is required.
