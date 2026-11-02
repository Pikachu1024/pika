# Tasks

## 1. Schema and Protocol Contracts

- [x] 1.1 Add `ModelPresetSchema` and `ModelCatalogSchema` in `packages/schema/src/models.ts`, export them from the package index, and verify unit tests reject duplicate names, unknown defaults, and invalid limits while accepting the documented catalog.
- [x] 1.2 Extend `SessionForkParamsSchema` with `model`, `llm`, and `cwd`, and add `session.compact` and `session.btw` params/results to `PROTOCOL_METHODS`; verify round-trip schema tests and the method-registry sync test pass.

## 2. Core Runtime and Stores

- [x] 2.1 Extend `SessionStore.fork` with optional model and working-directory overrides and implement them in the memory and JSONL stores; verify the shared store contract covers overrides, parent/fork-entry linkage, and an unchanged source session.
- [x] 2.2 Add `AgentRuntime.isSettled`, `compact()`, and a typed not-settled error, and refactor the compaction path to return token counts; verify tests for below-threshold forced compaction, no-cut-point no-op, and busy-session rejection.
- [x] 2.3 Add `AgentRuntime.askSideQuestion` using an empty tool list with no store writes or history mutation; verify tests that entries, usage, and history are unchanged and that a prompt submitted during a side question runs after it.

## 3. Server and Compaction Wiring

- [x] 3.1 Dispatch `session.compact` and `session.btw`, pass fork overrides into the store and new runtime, map not-settled errors to code 1002, and reject busy forks; verify session-server tests for each success and error case.
- [x] 3.2 Add the compaction option factory to `SessionServerOptions` and wire an OpenAI-compatible summarizer in `packages/server/src/bin.ts`; verify an integration test with a faux provider that manual and threshold compaction emit the expected events, and update `docs/protocol.md` for the new methods and fork fields.
- [x] 3.3 Resolve a handoff working-directory override through the existing sandbox policy path without widening it; verify a server test that a handoff into a clamped read-only or denied-network policy reports the effective values.

## 4. Client SDK

- [x] 4.1 Add `compactSession`, `askSideQuestion`, and fork override support to `PikaClient`; verify client tests against an in-process server for each method and confirm existing session calls are unchanged.

## 5. CLI Catalog, Commands, and TUI

- [x] 5.1 Implement catalog loading and preset resolution from `PIKA_MODELS_FILE` or `.pika/models.json`, including the implicit `env` preset and precedence rules; verify tests for precedence, missing API key variables, invalid catalogs, and the no-catalog fallback, and document the format in `docs/cli.md`.
- [x] 5.2 Implement the command registry, quote-aware tokenizer, unknown-command rejection, and pi-tui autocomplete definitions; verify parser, tokenizer, and completion tests.
- [x] 5.3 Implement `/help`, `/models`, `/config`, `/status`, `/usage`, and `/context` handlers; verify handler tests for masked key output and active-model marking, and update the `README.md` command list.
- [x] 5.4 Implement the session controller for `/new`, `/sessions`, `/resume`, `/fork`, `/model`, and `/handoff` with clean unsubscribe/subscribe and busy guards; verify tests that a switch replaces the subscription and leaves the source session intact.
- [x] 5.5 Implement `/sandbox`, `/compact`, and `/btw` handlers; verify tests for settled-only behavior, compaction token reporting, a marked side-answer block, and unchanged session history.
- [x] 5.6 Wire the controller into `runInteractive` with the autocomplete provider, persistent status line, select lists, and compaction/side-question transcript markers; verify a scripted interactive session covers `/models`, `/model`, `/btw`, and `/quit`.

## 6. Integration Verification

- [x] 6.1 Add an end-to-end test over a real transport that exercises a model-changing fork, manual compaction, and a side question in one run; verify `bun test` passes.
- [x] 6.2 Run `bun run check` and fix any failures; verify typecheck, lint, boundary, and tests all exit 0.
- [x] 6.3 Run `bun run build` and exercise the standalone binaries against a local OpenAI-compatible endpoint; verify `/models`, `/model`, `/btw`, `/compact`, and a normal turn in the interactive client.

## Workflow follow-up

- Archive this change after review requirements are satisfied.
- Archive the completed `migrate-toolchain-to-bun` change if it is still active.
