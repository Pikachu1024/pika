# Tasks

## 1. Workspace and schema foundation

- [x] 1.1 Create the pnpm workspace with `packages/schema`, `packages/core`, `packages/server`, `packages/client`, `packages/adapters`, and `apps/cli`, configure TypeScript strict, vitest, lint, and CI scripts; verify `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass on the empty workspace.
- [x] 1.2 Define schema types for events, sessions, turns, approvals, sandbox policies, and sandbox decisions; verify schema tests accept valid fixtures and reject invalid payloads.
- [x] 1.3 Add a package-boundary check that rejects CLI-to-core imports and direct `child_process` usage in tools, and document package responsibilities and dependency rules in `docs/architecture.md`; verify the check fails on a temporary violation, passes on the baseline, and the document matches the actual package graph.

## 2. Runtime and provider boundary

- [x] 2.1 Implement the `Provider` interface, `LlmEvent` normalization, and a faux provider with scripted streams; verify deterministic streaming tests cover text, reasoning, tool-call chunks, usage, and errors.
- [x] 2.2 Implement a `pi-ai` adapter for one OpenAI-compatible endpoint; verify adapter tests with a mocked transport and document an optional live smoke test.
- [ ] 2.3 Implement the single-writer runtime state machine and serialized command queue; verify transition tests cover idle, streaming, tool-calling, compacting, and aborted states.
- [x] 2.4 Implement the turn loop with lifecycle events, steering, follow-up, interrupt, and settled; verify event-order tests for a tool turn, a steered turn, a queued follow-up, and an interrupt.
- [x] 2.5 Implement error normalization so provider and tool failures become events or tool results, document the event contract in `docs/events.md`, and add fixtures; verify a failed request leaves the session idle, a later prompt succeeds, and fixtures match emitted events.

## 3. Session store and replay

- [x] 3.1 Implement the append-only JSONL store with `id`/`parentId` tree entries and an in-memory implementation of the same interface; verify both pass the same contract test suite.
- [ ] 3.2 Implement timeline folding and deterministic projection from an active branch; verify replay of a recorded turn produces the recorded prompt hash.
- [ ] 3.3 Implement resume, fork at a chosen entry, session listing, and the SQLite index for listing, token totals, and search; verify fork leaves the original branch unchanged, resume continues from the last settled state, and deleting then rebuilding the index yields identical results.
- [ ] 3.4 Implement raw provider payload capture in a sidecar directory and document the session format in `docs/session-format.md` with a sample log; verify replay succeeds after the sidecar is removed and the sample replays with its recorded hash.

## 4. Context pipeline and prompt

- [ ] 4.1 Implement the sectioned system prompt builder with named sections, `toolsAdded`/`toolsRemoved`, and `AGENTS.md` discovery with root-to-leaf merging; verify snapshot tests, resume reconstruction, nested-directory ordering, and a missing-file case.
- [ ] 4.2 Implement the projection pipeline with compaction application, reminder injection, tool-pair repair, provider-specific conversion, token estimation, and cache usage recording; verify orphan-call, purity, estimator, and `cache_read`/`cache_write` tests.
- [ ] 4.3 Implement compaction policy with threshold, reserve, branch summarization, and overflow retry; verify each path records a compaction event with before and after token counts.
- [ ] 4.4 Document prompt sections, projection, cache rules, and compaction in `docs/context.md`; verify the documented examples match test fixtures.

## 5. Sandbox

- [x] 5.1 Define `SandboxPolicy`, `Executor`, `NoopExecutor`, and `PathPolicy`; verify policy resolution and path tests cover read-only, workspace-write, outside-workspace writes, `..` traversal, and symlink escapes.
- [x] 5.2 Implement child process construction with an explicit environment allowlist, no login shell, a detached process group, timeout, and output cap; verify environment scrubbing, startup-file isolation, and orphan cleanup tests.
- [ ] 5.3 Implement sandbox decision events and the audit trail; verify decisions appear in the session log and in replay with the same outcome and reason.
- [ ] 5.4 Implement approval integration and the escalation flow; verify deny, accept-for-session, decline, and retry paths.
- [ ] 5.5 Implement the macOS Seatbelt executor with generated profiles; verify the conformance suite for filesystem, environment, child-process inheritance, and orphan cleanup on macOS.
- [ ] 5.6 Implement the bubblewrap executor and a Docker executor; verify the same conformance suite in Linux CI and Docker.
- [ ] 5.7 Implement network `none` enforcement, the proxy-mode interface, and policy monotonicity for child tasks; verify denied connections are recorded, an allowlisted proxy path succeeds, and a read-only parent rejects or clamps a workspace-write child request.
- [ ] 5.8 Document the sandbox threat model, policy model, backend matrix, and escalation flow in `docs/sandbox.md`; verify the documented commands match the conformance suite.

## 6. Tool system

- [x] 6.1 Implement the tool registry, schema validation, unknown-tool handling, and validation-error results; verify invalid input produces an error result and no side effect.
- [x] 6.2 Implement the executor with preflight, parallel independent calls, serialized write conflicts, and result ordering; verify a mixed read/write batch test.
- [x] 6.3 Implement `read_file`, `write_file`, and `edit_file` behind `PathPolicy`; verify outside-workspace, symlink, and nonexistent-path tests.
- [x] 6.4 Implement `bash`, `grep`, and `glob` behind `Executor`, including truncation, persisted full output, and start/update/end events; verify oversized-output, exit-code, and long-running command tests.
- [x] 6.5 Document the tool contract and v0 tool set in `docs/tools.md`; verify the documented examples pass as tests.

## 7. Protocol, SDK, and CLI

- [ ] 7.1 Define JSON-RPC methods and schemas for initialize, session, turn, approval, subscription, and sandbox mode; verify schema and error-shape tests.
- [ ] 7.2 Implement the stdio JSONL transport and the in-process transport; verify identical event sequences for the same turn over both.
- [ ] 7.3 Implement the WebSocket transport with subscription handling; verify two subscribers receive the same events and unsubscribe stops delivery.
- [ ] 7.4 Implement the server session manager, approval routing, and sandbox mode resolution; verify a client cannot bypass the executor.
- [ ] 7.5 Implement the typed SDK client with session creation, prompt, steer, interrupt, event subscription, and approval response; verify an SDK-driven end-to-end test.
- [ ] 7.6 Implement the `pi-tui` CLI as a protocol client; verify a manual smoke test and the package-boundary check showing no CLI-to-core imports.
- [ ] 7.7 Document the protocol and SDK in `docs/protocol.md`; verify the documented request and response examples against the schema tests.

## 8. Skills and MCP

- [ ] 8.1 Implement Agent Skills discovery across builtin, user, project, and plugin scopes with a prompt index and lazy body loading; verify scope and selection tests.
- [ ] 8.2 Implement stdio and streamable HTTP MCP lifecycle, OAuth, namespacing, exposure filters, crash/reconnect handling, and project trust gating; verify crash, reconnection, untrusted-project, and namespaced-tool tests.
- [ ] 8.3 Document skills and MCP configuration in `docs/extensions.md`; verify documented configurations load in tests.

## 9. Integration checks

- [ ] 9.1 Run an end-to-end faux-provider session through the CLI protocol covering prompt, tool call, approval, tool result, and final message; verify the session log and replay.
- [ ] 9.2 Run the sandbox conformance suite against every available backend; verify all required cases pass or are explicitly marked unsupported.
- [ ] 9.3 Run replay determinism across a process restart and after index deletion, then run typecheck, lint, boundary check, and the full test suite; verify prompt hashes and session listings match and all checks pass.
- [ ] 9.4 Run a long-session performance smoke with compaction; verify the session remains responsive and compaction records expected token reductions.

## Workflow follow-up

- Archive the change after review and verification.
- Verify the archived specs contain the planned capabilities and no placeholder purposes.
