# Proposal

## Why

The interactive CLI recognizes only `/quit`, `/approve`, and `/deny`; every other slash input is sent to the model as a prompt. A user typing `/models` sees `echo: /models` instead of a model list. There is also no slash-command completion, no status line, no way to switch or configure models interactively, and no protocol entry point for manual compaction, side questions, or model-changing forks.

## What Changes

- Add a CLI slash-command registry with autocomplete, argument parsing, `/help`, and a status line that shows session, model, sandbox mode, and token usage.
- Add a client-side model catalog loaded from `.pika/models.json` (overridable with `PIKA_MODELS_FILE`), with API keys referenced by environment-variable name only, and commands `/models`, `/model <alias>`, and read-only `/config`.
- Add session commands `/new`, `/sessions`, `/resume <id>`, `/fork [entryId]`, and `/handoff <alias>`; `/model` and `/handoff` fork at the current head into a new session instead of mutating the running session.
- Add context commands `/context`, `/usage`, and `/compact`, plus `/btw <question>` for a settled-state side question that is not written to the session log and has tools disabled.
- Extend `session.fork` with optional `model`, `llm`, and `cwd` overrides, add `session.compact` and `session.btw` protocol methods, and add matching client SDK methods.
- **BREAKING** Session forks may now carry model and working-directory overrides; store implementations and the `SessionStore` port must accept them.
- Update CLI, protocol, provider, session, and architecture documentation.

Out of scope:

- Editing the model catalog from inside the TUI; `/config` is read-only and users edit the JSON file.
- Streaming side-question output; `/btw` returns one completed answer.
- Hot-swapping a model or provider inside a running session; model changes always create a fork.
- Handing off to an external harness or process, or exporting context in another tool's format.
- New secret storage; API keys remain environment-only.
- A generic plugin command system or user-defined slash commands.

## Capabilities

### New Capabilities

- `cli-commands`: slash-command dispatch, autocomplete, status display, model catalog resolution, session switching, and side-question/compaction command behavior in the interactive client.

### Modified Capabilities

- `client-protocol`: new `session.compact` and `session.btw` methods, and `session.fork` model/LLM/working-directory overrides.
- `agent-runtime`: manual compaction when idle, and a serialized side-question path that does not mutate history or emit persisted session events.
- `context-pipeline`: manual compaction preserves recent turns and records the same token counts and replacement range as threshold compaction.
- `session-store`: forked sessions accept model and working-directory overrides while retaining the parent session and fork entry.

## Impact

- `apps/cli`: command registry, TUI autocomplete, status line, config loader integration, session switching, and command handlers.
- `packages/schema`: model catalog schema, fork params, and new protocol method contracts.
- `packages/core`: runtime manual compaction, side-question API, fork override port, and store contract updates.
- `packages/server`: dispatch for `session.compact` and `session.btw`, and fork overrides.
- `packages/client`: typed SDK methods for compaction, side questions, and fork overrides.
- `packages/adapters`: in-memory and JSONL store fork overrides.
- `docs`: CLI command reference, model catalog format, protocol methods, and architecture notes.
- No new runtime dependencies; pi-tui's existing autocomplete and select-list components are reused.
