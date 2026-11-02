# Changelog

## [Unreleased]

### Added

- Initial npm workspace with `schema`, `core`, `server`, `client`, `adapters`, and CLI projects.
- TypeScript strict configuration, Biome, Vitest, and CI scripts.
- Package-boundary and child-process checks.
- Architecture documentation and project agent instructions.
- Schema contracts for events, turns, sessions, approvals, sandbox policies, and decisions.
- `Provider`/`LlmEvent` boundary, faux provider, and single-writer runtime with prompt, steer, follow-up, interrupt, and settled semantics.
- In-memory and append-only JSONL session stores sharing one contract suite.
- Sandbox policy resolution and monotonic clamping, path policy with symlink checks, and a rejecting no-op executor.
- Sectioned prompt builder, `AGENTS.md` discovery, deterministic context projection with prompt hashing, token estimation, and compaction planning.
- Tool registry with JSON Schema conversion and a batch executor with validation, concurrency keys, ordered results, and abort handling.
- Event contract documentation and replayable event fixtures.
