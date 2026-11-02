# Pika Harness

Pika Harness is a learning-first TypeScript agent harness. The core runtime, context pipeline, tool system, sandbox, session store, and protocol are built in this repository. `pi-ai`, `pi-tui`, and the official MCP SDK are reused as libraries.

## Read first

- `openspec/changes/archive/2026-11-02-agent-harness-foundation/proposal.md`
- `openspec/changes/archive/2026-11-02-agent-harness-foundation/design.md`
- `openspec/changes/archive/2026-11-02-agent-harness-foundation/tasks.md`
- `docs/architecture.md`

The OpenSpec change is the source of truth for scope. If code and the change disagree, update the change before changing the code.

## Repository layout

```
apps/pika/           single `pika` entrypoint; composition root + local server launcher
apps/cli/            pi-tui client; protocol-only
packages/schema/     protocol and event schemas
packages/core/       runtime, context, prompt, tools, sandbox policy, session ports
packages/server/     session manager, transports, approvals
packages/client/     typed protocol client
packages/adapters/   pi-ai, MCP, sandbox executors, JSONL/SQLite
docs/                architecture and subsystem documentation
openspec/            proposals, specs, designs, and task tracking
scripts/             repository checks
```

## Dependency rules

- `schema` depends on no workspace package.
- `core` may depend on `schema`. It must not import `server`, `client`, `adapters`, or `cli`.
- `adapters` may depend on `schema` and `core` port types. It must not import `server`, `client`, or `cli`.
- `server` may depend on `schema`, `core`, and `adapters`.
- `client` may depend only on `schema`.
- `cli` may depend on `schema` and `client`. It must not import `core`, `server`, or `adapters`.
- `pika` (`apps/pika`) is the composition root and may import every workspace package. No package may import `pika`.
- All subprocess execution goes through the sandbox executor. Only `packages/adapters/src/sandbox/` may import `node:child_process`.
- The launcher supervises its own server process with the global `Bun.spawn`; this is process lifecycle management, not tool execution, and still must not import `node:child_process`.
- Run `bun run boundary` to verify these rules.

## Commands

Use Bun 1.4 or newer (`bun.lock`, Bun workspaces). Install dependencies with `bun install`. Type checking stays on `tsc`; lint and format stay on Biome.

- `bun run check`: typecheck, lint, boundary check, and tests
- `bun run typecheck`
- `bun run test`
- `bun run lint`
- `bun run format`
- `bun run boundary`
- `bun run build:binary`: single standalone `pika` binary via `bun build --compile`
- `bun run cli`: run the single entrypoint (launcher + local server) from source
- `bun run server`: run `pika serve` from source

Do not run tests against live providers. Use the faux provider for deterministic tests. Live smoke tests are opt-in and require explicit credentials.

## Coding rules

- TypeScript strict. Avoid `any`; if it is unavoidable, explain why in a comment.
- Use erasable TypeScript syntax only: no `enum`, `namespace`, parameter properties, or `import =`.
- Top-level imports only. Do not use dynamic `import()` or `require()` in source.
- Use `.js` extensions in relative imports because the packages are ESM with `NodeNext` resolution.
- One concept per file. Exported functions get a one-line doc comment.
- Comments explain a non-obvious why, not what the next line does.
- Do not add backwards-compatibility shims or unused exports.
- Read a file fully before editing it.
- Never weaken the sandbox, path policy, environment filtering, or approval checks to make a test pass.

## Testing

- Bun's test runner (`bun:test`). Place tests in `packages/<name>/test` or `apps/<name>/test`.
- Use the faux provider for deterministic loop and replay tests.
- Every bug fix gets a regression test.
- Sandbox changes must pass the conformance suite for every affected backend.

## Security

- Approval is UX; the sandbox is the enforcement boundary.
- Never log credentials, tokens, or raw environment dumps.
- Child processes receive an explicit environment allowlist. Never inherit `process.env`.
- Do not source login shell startup files.
- File tools must resolve symlinks and enforce the path policy, including in-process writes.
- Do not disable or skip sandbox conformance tests.

## OpenSpec workflow

- One change at a time. Create or update the proposal, specs, design, and tasks before code.
- Keep task checkboxes current. Mark a task `[x]` only when the verification in that task passes.
- If implementation reveals a design issue, update the change instead of silently diverging.
- Archive a change only after verification.

## Git

- Only commit when the user asks.
- Stage explicit paths. Never use `git add -A` or `git add .`.
- Do not run destructive commands such as `git reset --hard`, `git checkout .`, or `git clean -fd`.
- Commit messages: `feat|fix|docs(scope): summary`.

## Communication

- Be concise and technical.
- No emojis in code, commits, issues, or PR comments.
- Answer the question before making changes.
- If user instructions conflict with this file, ask before overriding.
