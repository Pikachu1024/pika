# Tasks

## 1. Endpoint and preset schema

- [x] 1.1 Add optional `tools` to `LlmEndpointSchema` and `ModelPresetSchema`; verify `packages/schema` tests cover omitted (defaults to enabled), `true`, and `false`.
- [x] 1.2 Update `docs/protocol.md` and `docs/providers.md` with the `tools` field and its default; verify the documented field names match the schemas.

## 2. Per-session tool registration

- [x] 2.1 Make the serve tooling factory return no provider tools and an executor with an empty registry when `context.llm?.tools === false`; verify a server test with the faux provider asserts the first request declares zero tools and emits no tool events.
- [x] 2.2 Cover resume and fork behavior: fork inherits the source endpoint and its flag, resume uses the client-supplied endpoint; verify controller/server tests assert the effective tool capability.

## 3. User-level catalog and credentials

- [x] 3.1 Resolve the config directory (`PIKA_CONFIG_DIR`, then `XDG_CONFIG_HOME`, then `~/.config`) and load the user catalog alongside the project catalog; verify catalog tests cover merge-by-alias, project override, startup precedence, and one invalid file leaving the other loaded.
- [x] 3.2 Implement the credentials store with directory mode `0700`, file mode `0600`, and atomic replace; verify tests cover key precedence (`apiKeyEnv` then credentials), a missing required key, and a failed write leaving previous files intact.
- [x] 3.3 Extend `/models` with preset sources and `/config` with both catalog paths plus credential presence; verify command tests assert source markers and that no key value appears, and update `docs/providers.md`.

## 4. In-TUI `/connect` flow

- [x] 4.1 Add `promptText` and `promptSecret` to `ControllerUi` and implement a masked single-line input component; verify interactive tests confirm mask rendering and that submitted plaintext never reaches the transcript.
- [x] 4.2 Register `/connect`, collect provider type, alias, base URL, model, key, optional limits, and the tool-calling choice, and reject the command while a turn is running; verify command tests cover a successful save and a missing base URL or model.
- [x] 4.3 Reload the catalogs after a save, start a new session with the endpoint (including `tools`), and offer the optional no-tool `/btw ping` check; verify controller tests cover reload, the new session's model, and a failed check keeping the preset.
- [x] 4.4 Show the `/connect` hint when no preset and no `PIKA_LLM_*` values exist at startup; verify the interactive test asserts the hint appears and commands still work.
- [x] 4.5 Update `docs/cli.md` with `/connect`, config locations, merge and key precedence, and apply semantics; verify the documented flow matches the command tests.

## 5. Integration

- [x] 5.1 Run `bun run check` and verify typecheck, lint, boundary checks, and all tests pass.
- [x] 5.2 Exercise `/connect` against a local fake OpenAI-compatible endpoint with tool calling disabled; verify a chat turn succeeds, the session JSONL contains no key, and `/config` reports presence only.
