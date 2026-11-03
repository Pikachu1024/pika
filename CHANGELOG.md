# Changelog

## [0.1.0] - 2026-11-03

### Added

- `pika` single entrypoint that starts and supervises a local session server, with one-shot `--prompt` and interactive TUI modes.
- Built-in file and shell tools (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`) executed through the sandbox executor.
- In-TUI LLM configuration (`/connect`), per-session OpenAI-compatible endpoints, masked API-key input, and a `0600` credentials store.
- Pika home directory (`PIKA_HOME`, default `~/.pika`): sessions under `$PIKA_HOME/sessions`, user catalogs and credentials directly under it, with non-destructive migration from `~/.config/pika`.
- `scripts/install.sh` and `bun run install:local` for building and installing the standalone binary to `~/.local/bin`.
- GitHub Actions release workflow publishing macOS arm64/x64 and Linux x64/arm64 binaries with `SHA256SUMS`.

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

### Changed

- Migrated the toolchain to Bun 1.4: Bun workspaces and `bun.lock` replace pnpm, `bun:test` replaces Vitest, and `bun build --compile` replaces the Node SEA pipeline.
- **BREAKING**: sessions now default to `$PIKA_HOME/sessions` instead of `<cwd>/.pika/sessions`; `PIKA_SESSION_DIR` and `--dir` still override.
- **BREAKING**: user-level model catalogs and credentials now default to `~/.pika` instead of `~/.config/pika`; `PIKA_CONFIG_DIR` still overrides.
