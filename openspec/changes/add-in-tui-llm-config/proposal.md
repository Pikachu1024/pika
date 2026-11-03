# Proposal

## Why

Configuring a model currently requires editing `.pika/models.json`, exporting `PIKA_LLM_*` variables, or passing `--llm-*` flags before the TUI starts. The previous command-surface change explicitly deferred both in-TUI catalog editing and secret storage. Users of self-hosted OpenAI-compatible endpoints must leave the TUI, edit JSON or shell state, and restart, and some of those endpoints reject the `tools` field that the harness advertises on every session.

## What Changes

- Add `/connect`, an interactive TUI command that collects provider type, alias, base URL, model id, API key, optional context-window and max-token values, and a tool-calling toggle.
- Persist personal presets in a user-level catalog at `$XDG_CONFIG_HOME/pika/models.json` (default `~/.config/pika/models.json`), overridable with `PIKA_CONFIG_DIR`.
- Persist API keys in a separate user-level `credentials.json` with mode `0600`; keys are never written to the project catalog, the session log, or command output.
- Resolve presets by merging the project `.pika/models.json` over the user-level catalog by alias; flags and `PIKA_LLM_*` still win at startup. Resolve a preset key from its `apiKeyEnv` variable first, then from the credentials file.
- Apply a saved preset by starting a new session with its endpoint, because a provider is bound when a session is created. `/connect` may offer a no-tool `/btw ping` connectivity check.
- Keep `/config` read-only and extend `/models` to show which catalog each preset came from.
- Add an optional `tools` flag to `LlmEndpoint` and the stored preset; when false, the server registers no built-in tools for that session and advertises none to the provider.
- Add a masked single-line input component in the CLI because pi-tui's `Input` renders typed characters in clear text.
- Update CLI, provider, protocol, and architecture documentation.

Out of scope:

- OS keychain and OAuth login flows; credentials are a `0600` JSON file.
- Hot-swapping the provider of a running session; configuration changes always start a new session.
- Editing the server's default provider or the sandbox from `/connect`.
- Wire APIs other than OpenAI chat completions.
- Reworking the existing project catalog format; it still stores `apiKeyEnv` names only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli-commands`: new `/connect` command, user-level catalog and credential storage, catalog merge and key-resolution precedence, masked secret entry, and session-apply behavior.
- `client-protocol`: `LlmEndpoint` gains an optional `tools` capability flag carried by session start, resume, and fork.
- `tool-system`: built-in tools are exposed to every session unless that session's endpoint explicitly disables tool calling.

## Impact

- `apps/cli`: command registry, `SessionController` catalog refresh, interactive input helpers, masked input component, and catalog/credential persistence.
- `packages/schema`: `LlmEndpoint` and model-catalog schema additions.
- `packages/server`: per-session tool registration honors the endpoint's `tools` flag.
- `packages/client`: no new methods; existing typed session calls carry the extended endpoint.
- `docs`: CLI, provider, and protocol documentation.
- No new runtime dependencies; pi-tui components are reused except for the masked input wrapper.
