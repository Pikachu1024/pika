# Design

## Context

See `proposal.md` for motivation and the spec deltas for observable behavior.

Current constraints:

- The CLI is a protocol-only client and must not import `core`, `server`, or `adapters`.
- `Prompt`, `steer`, `followUp`, and `interrupt` already serialize through the runtime's single agent loop; the runtime holds `model` and `provider` as readonly values.
- `session.start` and `session.resume` already accept a per-session `LlmEndpoint`; `session.fork` does not.
- The server never configures `RuntimeCompactionOptions`, so threshold compaction is currently inert in the real server.
- `context_projected` events already carry `messageCount` and `estimatedTokens`.
- `pi-tui` 0.73.1 ships `CombinedAutocompleteProvider`, `SlashCommand`, and `SelectList`; no new dependency is needed.

## Goals / Non-Goals

**Goals:**

- Make the command surface explicit and discoverable instead of guessing whether `/foo` is a prompt.
- Keep model selection client-side so API keys never need to live on a remote server.
- Preserve append-only session semantics: model and environment changes create a fork instead of rewriting a log.
- Serialize compaction and side questions through the existing single-writer runtime.
- Keep every new command testable through pure parsers, runtime unit tests, and protocol-level integration tests.

**Non-Goals:**

- Hot-swapping a model inside a running session.
- Streaming `/btw` output or persisting side-question transcripts.
- Editing the model catalog from the TUI.
- Remote or server-managed model catalogs.
- User-defined commands or a plugin command loader.
- Changing sandbox enforcement; all execution continues through the existing policy and executor.

## Decisions

### D1. The model catalog is a client-side contract in `schema`

The catalog lives at `<cwd>/.pika/models.json`, overridable with `PIKA_MODELS_FILE`. `packages/schema/src/models.ts` defines and exports `ModelPresetSchema`, `ModelCatalogSchema`, and their types so the CLI can validate with the same contract a future SDK would use.

```json
{
  "default": "jiuwei",
  "models": [
    {
      "name": "jiuwei",
      "model": "jiuwei-tcm",
      "baseUrl": "http://192.168.56.39:59000/v1",
      "apiKeyEnv": "PIKA_LLM_API_KEY",
      "contextWindow": 32768,
      "maxTokens": 4096
    }
  ]
}
```

Validation rules: unique non-empty names, non-empty `baseUrl` and `model`, positive integer limits, and a `default` that names an existing preset when present.

Initial preset precedence:

1. Explicit `--llm-*` flags or `PIKA_LLM_*` environment values, exposed as an implicit `env` preset.
2. `default` from the catalog.
3. The first catalog preset.

If neither a catalog nor an LLM endpoint is available, the client keeps the current behavior: the server's default provider is used, and `/models` shows only the active model from the session summary.

`apiKeyEnv` names an environment variable; the value is resolved at session creation and placed in the existing `LlmEndpoint`. It is never written to the catalog, logs, session entries, or `/config` output.

Alternatives:

- Server-side catalog. Rejected: a remote server would need every user's credentials, and the protocol already supports client-supplied endpoints.
- Environment-only configuration. Rejected: `/models` would always contain one entry, so the command would not justify itself.
- A global `~/.config/pika/models.json` fallback. Deferred; project-local plus `PIKA_MODELS_FILE` covers the current use case without adding precedence rules.

### D2. Model switching and handoff use fork with overrides

`session.fork` gains optional `model`, `llm`, and `cwd` fields. The server passes them to `SessionStore.fork` and builds the new runtime from the overridden context. `/model <alias>` is the model-only case; `/handoff` adds working-directory and sandbox overrides. Sandbox changes reuse `sandbox.mode` after the fork, so no new sandbox protocol surface is introduced.

The source session remains settled and listed. The client moves its subscription and transcript to the new session.

Busy sessions: the server rejects a fork while the source runtime is not settled, and the client checks locally before issuing the request. Forking mid-turn would otherwise copy a partial tool-call chain.

Alternatives:

- `runtime.setModel`/`setProvider` hot swap. Rejected: model is part of session metadata, environment rendering, usage attribution, and replay; mutating it mid-log makes replay ambiguous and breaks the single-writer invariant.
- A separate `session.handoff` method. Rejected: it duplicates `session.fork` with the same entry-chain semantics.

### D3. Manual compaction is a runtime command with a maintenance turn id

Add `AgentRuntime.compact()` returning `{ compacted, tokensBefore, tokensAfter }`. It runs only when settled, sets the runtime to `compacting`, and blocks concurrent prompts until it finishes. It forces compaction below the threshold when a cut point exists.

`compaction_start`/`compaction_end` are turn-scoped events. Manual compaction generates a maintenance turn id but does not emit `turn_start`, `turn_end`, or a user message, so the log does not gain an empty turn. When no cut point exists, it emits nothing and returns `compacted: false`.

The server currently never supplies `RuntimeCompactionOptions`. Add `SessionServerOptions.compaction?: (context, provider) => RuntimeCompactionOptions | undefined` and wire it in `packages/server/src/bin.ts` using the resolved LLM context window and a summarizer that calls the same provider with no tools. This also enables the threshold compaction already required by the context-pipeline spec.

Alternatives:

- Client-triggered summarization. Rejected: history lives in the runtime and store.
- Emitting a full synthetic turn. Rejected: it pollutes replay and session listings.
- Making compaction events session-scoped. Rejected: it changes the existing event contract for one command.

### D4. Side questions run in the runtime but outside the session record

Add `AgentRuntime.askSideQuestion(text)` returning `{ text, usage? }`. It requires a settled runtime, uses the current model, system prompt, and history, sends an empty tool list, and calls the provider directly. It does not emit session events, write store entries, change history, or update turn/usage counters.

Serialization: the runtime sets its running flag for the duration, so prompts arriving during a side question are queued and start after it finishes. `interrupt` does not abort a side question in this version.

The response is non-streaming. The CLI prints it as a marked `[btw]` block; because it is not a session entry, it never enters later projections.

Alternatives:

- A temporary in-memory session. Rejected: it duplicates projection and prompt setup and could race the main runtime.
- Streaming via a new notification channel. Rejected for v1; it adds protocol surface and ephemeral event semantics that the current store and subscription model do not have.
- Allowing side questions during a turn. Rejected: the runtime is single-writer.

### D5. Slash commands are a registry with pure parsing

`apps/cli/src/commands/` defines a `Command` record (name, description, argument hint, handler, optional argument completions) and a small tokenizer that supports double-quoted arguments. The editor receives a `CombinedAutocompleteProvider` built from the registry, so `/` completion and per-command argument completion come from pi-tui.

Unknown commands are reported locally. The existing `/approve`, `/deny`, and `/quit` behavior is preserved.

### D6. Interactive state moves into a session controller

`runInteractive` currently closes over immutable `client` and `sessionId` values. Introduce a controller that owns the current session id, subscription, preset alias, sandbox state, latest context projection, and busy flag. Switching sessions unsubscribes the old subscription, starts/resumes/forks, subscribes to the new session, resets the transcript, and updates the status line.

The status line is a `Text` component above the editor. Session lists and model selection use `SelectList` when interactive; command output falls back to plain transcript lines when no selection is needed.

### D7. Protocol additions stay additive

New methods and optional fork fields are additive, so `PROTOCOL_VERSION` remains `1`. A client talking to an older server receives `methodNotFound`; the CLI reports that the server is too old for the command instead of retrying.

### D8. Error mapping and safety boundaries

- Runtime `NotSettledError` becomes JSON-RPC `sessionNotSettled` (1002) for `session.compact`, `session.btw`, and busy forks.
- Missing API key variables and unknown aliases are client errors; they never reach the server.
- `/handoff --cwd` is resolved by the server against its default working directory, and the resulting sandbox policy is resolved exactly as for `session.start`. The client cannot bypass policy by handing off.
- Side questions and summarization use the `Provider` interface with no tools, so they cannot execute subprocesses or touch the sandbox. All real execution still goes through the sandbox executor.
- `/config` prints variable names and presence only. Catalog validation errors include the file path and field reason, never file contents or secrets.

## Risks / Trade-offs

- **Wiring compaction enables threshold compaction for the first time in the real server** -> Test both manual and threshold paths with a faux summarizer, and document the new behavior.
- **Summarizer failures can surface during a turn** -> The runtime already records `compaction_failed` and falls back to a placeholder summary; add coverage.
- **`/btw` blocks queued prompts until the provider finishes** -> Document it; a future version can add an abort path.
- **Fork-with-overrides requires both store implementations to agree** -> Extend the shared store contract test before changing either implementation.
- **Session switching can leak subscriptions or events from the old session** -> Centralize unsubscribe/subscribe in the controller and test a switch sequence with a fake client.
- **Protocol version stays 1 despite new methods** -> Treat `methodNotFound` as a compatibility error with a clear message; avoid silently degrading.
- **Model catalog is local to the client** -> `/models` may show fewer models than a server could support; this is an accepted trade-off for keeping keys client-side.
- **Refactoring the interactive loop can regress approvals or history** -> Keep handlers pure and add parser/handler tests before moving TUI state.

## Migration Plan

1. Add schema types and protocol methods; existing clients ignore them.
2. Add runtime and store capabilities with unit and contract tests.
3. Wire server dispatch and compaction configuration.
4. Add client SDK methods.
5. Add catalog loading and the CLI command/TUI layer.
6. Update docs and run `bun run check` plus binary smoke tests.

Rollback: revert the change. No session data migration is required; fork overrides affect only newly created sessions, and existing logs replay unchanged.

## Open Questions

- Should a later version stream `/btw` deltas through a dedicated ephemeral notification channel?
- Should a user-level `~/.config/pika/models.json` be layered under the project catalog?
