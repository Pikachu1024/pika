# Spec Delta

## ADDED Requirements

### Requirement: In-TUI provider connection

The interactive client SHALL provide `/connect`, which collects a provider type, alias, base URL, model id, API key, optional context-window and max-token values, and a tool-calling choice, then persists the preset and starts a new session with that endpoint.

#### Scenario: Save and apply

- **WHEN** the user submits `/connect` with a base URL, model, and API key while the session is settled
- **THEN** the client saves the preset, starts a new session using the endpoint, and the status line shows the new model

#### Scenario: Incomplete endpoint

- **WHEN** the user omits the base URL or the model id
- **THEN** the command reports the missing field without saving a preset or starting a session

#### Scenario: Secret entry is masked

- **WHEN** the user types the API key
- **THEN** the input line renders mask characters and the transcript never shows the key

#### Scenario: Busy session

- **WHEN** a turn is still running
- **THEN** the command rejects `/connect` and keeps the current session

### Requirement: Connection check

After saving a preset, `/connect` SHALL offer a no-tool side question against the new session and SHALL report a failure without deleting the saved preset.

#### Scenario: Check succeeds

- **WHEN** the user accepts the connection check and the endpoint answers
- **THEN** the client reports success and keeps the new session active

#### Scenario: Check fails

- **WHEN** the endpoint returns an error
- **THEN** the client reports the error, keeps the saved preset, and leaves the new session settled

### Requirement: User-level configuration storage

The client SHALL store personal presets in a user-level catalog under the configuration directory, defaulting to `~/.config/pika` and overridable with `XDG_CONFIG_HOME` or `PIKA_CONFIG_DIR`, and SHALL store API keys in a separate `credentials.json` with mode `0600`.

#### Scenario: Restrictive credentials file

- **WHEN** `/connect` saves an API key
- **THEN** `credentials.json` is created with mode `0600` and contains no preset metadata

#### Scenario: Key never displayed

- **WHEN** the user runs `/config` or `/models` after saving a key
- **THEN** the output reports key presence only and never the key value

#### Scenario: Write failure

- **WHEN** the user catalog or credentials file cannot be written
- **THEN** the command reports the error and leaves the previous catalog and credentials unchanged

### Requirement: Catalog merge and key resolution

The client SHALL merge the project catalog over the user-level catalog by alias, SHALL prefer explicit flags and `PIKA_LLM_*` values at startup, and SHALL resolve a preset's key from its `apiKeyEnv` variable before the credentials file entry for its alias.

#### Scenario: Project override

- **WHEN** both catalogs define the same alias
- **THEN** the project preset wins and `/models` lists that alias once from the project source

#### Scenario: Environment key wins

- **WHEN** a preset names `apiKeyEnv` and that variable is set while a credentials entry also exists
- **THEN** the endpoint uses the environment value

#### Scenario: Credentials fallback

- **WHEN** a preset has no `apiKeyEnv`, or the named variable is unset, and a credentials entry exists for its alias
- **THEN** the endpoint uses the credentials value

#### Scenario: Missing required key

- **WHEN** a preset names `apiKeyEnv`, the variable is unset, and no credentials entry exists
- **THEN** the command fails naming the alias and the variable without starting a session

### Requirement: Unconfigured model guidance

When no preset and no `PIKA_LLM_*` values exist at startup, the client SHALL keep the server's default model active and SHALL tell the user to run `/connect`.

#### Scenario: No presets at startup

- **WHEN** the client starts with no catalog and no LLM environment values
- **THEN** the intro or status line points to `/connect` and commands remain usable

## MODIFIED Requirements

### Requirement: Model catalog

The client SHALL load presets from the project `.pika/models.json` or `PIKA_MODELS_FILE` path and from the user-level catalog, SHALL merge them by alias with the project definition winning, SHALL report duplicate names or invalid presets with the file path and reason, and SHALL resolve each preset's API key from its named environment variable or, when absent, from the user credentials file.

#### Scenario: Presets loaded

- **WHEN** the catalogs define multiple presets
- **THEN** `/models` lists each preset with its source and marks the active session's model

#### Scenario: Missing API key

- **WHEN** the selected preset names an unset environment variable and no credentials entry exists for its alias
- **THEN** the command fails naming the alias and variable and no session is created

#### Scenario: No catalog file

- **WHEN** no catalog file exists and `PIKA_LLM_*` variables are set
- **THEN** the client exposes one implicit preset named by `PIKA_LLM_MODEL`

#### Scenario: Invalid catalog

- **WHEN** one catalog file is malformed or a preset is invalid
- **THEN** the client reports that file and validation error, loads the remaining catalogs, and keeps the current session running

### Requirement: Configuration inspection

`/config` SHALL report each loaded catalog path, each preset's source and default, and whether its referenced API key variable or credentials entry is present, and SHALL NOT print key values.

#### Scenario: Masked keys

- **WHEN** the user runs `/config`
- **THEN** the output shows variable names and presence, never the secret values

#### Scenario: Two catalogs

- **WHEN** both project and user catalogs exist
- **THEN** `/config` reports both paths and marks the project preset as the override
