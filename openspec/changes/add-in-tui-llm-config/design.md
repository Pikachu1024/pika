# Design

## Context

See `proposal.md` for motivation. Current constraints that shape the approach:

- The client loads one catalog at startup (`apps/cli/src/catalog.ts`) and resolves keys only from `apiKeyEnv`; `SessionController` keeps that state for its lifetime.
- A provider is constructed by the server when a session is created (`packages/server/src/serve.ts`); fork inherits the in-memory source endpoint, while resume requires the client to send an endpoint again because keys are never persisted.
- pi-tui provides `Input`, `SelectList`, and `SettingsList`, but no masked-input component.
- The previous command-surface change explicitly deferred in-TUI catalog editing and secret storage; this change reverses both decisions.

## Goals / Non-Goals

**Goals:**

- Configure a personal OpenAI-compatible endpoint entirely inside the TUI.
- Keep API keys out of the repository, session logs, and command output.
- Reuse user-level presets across projects while letting a project override them.
- Support endpoints without OpenAI function calling without weakening the sandbox.

**Non-Goals:**

- Keychain/OAuth integration, provider discovery, or model listing from the endpoint.
- Hot-swapping the provider of a running session.
- Editing the server's default provider or the sandbox policy from `/connect`.
- Persisting API keys in session records or server configuration.

## Decisions

### User-level config and separate credentials

Personal presets live in `<config>/pika/models.json`, where `<config>` is `PIKA_CONFIG_DIR`, then `XDG_CONFIG_HOME`, then `~/.config`. Keys live in `<config>/pika/credentials.json` with mode `0600`.

Alternatives considered:

- **Project-only catalog**: rejected because `.pika/` is not ignored by Git and keys would be easy to commit; project-specific endpoints also force reconfiguration per directory.
- **OS keychain**: best UX but requires per-platform code and test infrastructure; deferred.
- **Key inline in the catalog**: rejected because catalogs are shareable and printable.

Writes are atomic (temporary file in the same directory, then rename) so a failed write never truncates an existing catalog or credentials file. The credentials file stores only `alias -> apiKey`; preset metadata stays in `models.json`.

### Catalog merge and resolution order

- Startup preset: `--llm-*` / `PIKA_LLM_*` implicit preset, then project catalog default, then user catalog default, then the first user preset.
- Presets merge by alias with the project definition overriding the user definition.
- Key for an alias: `apiKeyEnv` environment value, then credentials entry. A preset with neither is keyless and valid for unauthenticated local endpoints.

Alternatives considered:

- **Single active file** (`PIKA_MODELS_FILE` > project > user): simpler, but makes `/connect` writes silently ineffective whenever a project catalog exists.
- **Full three-way merge with explicit source config**: unnecessary for the current catalog shape.

`PIKA_MODELS_FILE` continues to mean "use this file instead of project discovery"; user presets still merge under it.

### `/connect` interaction and masking

`/connect` is a sequential prompt flow implemented on the existing `ControllerUi` abstraction: a new `promptText`/`promptSecret` method renders a one-line `Input`, and the secret variant applies a small component that renders one mask character per code point while preserving cursor movement and paste handling.

`/config` stays read-only. `/models` gains a source column (`env`, `project`, `user`) so overrides are visible. Alternatives: turning `/config` into an editable `SettingsList` (rejected: mixes inspection with state mutation and requires a larger UI rewrite), or a separate `pika config` subcommand (rejected: it is not in-TUI).

### Apply by new session

Saving a preset starts a new session with the resolved endpoint instead of mutating the current one, mirroring `/new`. The provider is bound at session creation, and forking across providers can replay tool calls a new endpoint does not understand. `/connect` therefore runs only on a settled session.

The connectivity check is an optional no-tool side question (`/btw ping`) on the new session: it reuses the existing protocol and records no entries. Alternatives: a new `llm.probe` protocol method (more surface for a one-off check), or no check (a saved but broken preset is only discovered on the first prompt).

### Tool capability flag

`LlmEndpoint` gains `tools?: boolean` (default true). The client sends the preset's value with session start, resume, and fork. The server's tooling factory returns an empty provider-tool list and no executor-bound tools for sessions with `tools: false`.

Alternatives considered:

- **Retry on a provider 400 that mentions tools**: fragile and hides real errors.
- **Probe `/v1/models` for capabilities**: not exposed by many compatible servers, including the target endpoint.
- **Server-startup global toggle**: cannot mix tool-capable and tool-less endpoints on one server.

This does not weaken the sandbox: it removes tool declarations, not enforcement. Any tools a future session enables still pass through the same executor, path policy, and approval checks. The adapter remains the only place that knows wire format; `tools` is a harness-level capability hint, not vendor syntax.

### Controller state refresh

After `/connect` writes files, the controller reloads both catalogs and replaces its in-memory state instead of requiring a restart. Reload failures are reported and keep the previous state. Resume includes the resolved preset endpoint (including `tools`) when the resumed model matches a preset; when no preset matches, the server defaults apply, which means tool calling is enabled for that resumed session.

## Risks / Trade-offs

- [Two catalogs cause alias confusion] -> `/models` and `/config` show sources and both paths; project always wins deterministically.
- [Secrets on disk can be copied by backups or sync tools] -> `0600` file, `0700` directory, no secrets in the repo or logs; users who need stronger storage can keep using `apiKeyEnv`.
- [Masked input is custom code] -> keep the component single-purpose and cover cursor/paste behavior with tests; the terminal may still capture input history, which is documented.
- [Concurrent writes to credentials] -> atomic replace with last-writer-wins; Pika is a single-user local tool.
- [A malformed catalog no longer disables every preset] -> define and test the new "load remaining catalogs" behavior so failures are predictable.
- [Tools disabled reduces agent capability] -> explicit toggle with a visible `/models` marker; default remains enabled.

## Migration Plan

- No data migration: existing project catalogs and `PIKA_LLM_*` setups keep working, and a missing user catalog is normal.
- `/config` output gains a second catalog path; update docs and tests.
- Rollback is removing the user-level files; project behavior is unchanged.
