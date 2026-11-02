# cli-commands Specification

## Purpose
Defines how the interactive client dispatches slash commands, resolves model presets, switches sessions, and exposes status, compaction, and side-question controls without becoming a second runtime.

## Requirements

### Requirement: Slash-command dispatch

The interactive client SHALL resolve registered slash commands before sending input to the model and SHALL reject unknown commands locally instead of forwarding them as prompts.

#### Scenario: Unknown command

- **WHEN** the user submits `/nope`
- **THEN** the client reports an unknown command and sends no prompt

#### Scenario: Command completion

- **WHEN** the user types `/` at the start of the input
- **THEN** the client lists registered commands with descriptions and completes the selected command

### Requirement: Model catalog

The client SHALL load model presets from `.pika/models.json` or the path in `PIKA_MODELS_FILE`, SHALL reject duplicate names or invalid presets with the file path and reason, and SHALL resolve each preset's API key only from its named environment variable.

#### Scenario: Presets loaded

- **WHEN** the catalog defines multiple presets
- **THEN** `/models` lists each preset and marks the active session's model

#### Scenario: Missing API key

- **WHEN** the selected preset names an environment variable that is unset
- **THEN** the command fails naming that variable and no session is created

#### Scenario: No catalog file

- **WHEN** no catalog file exists and `PIKA_LLM_*` variables are set
- **THEN** the client exposes one implicit preset named by `PIKA_LLM_MODEL`

#### Scenario: Invalid catalog

- **WHEN** the catalog is malformed or a preset is invalid
- **THEN** the client reports the file and validation error and keeps the current session running

### Requirement: Model switching by fork

`/model <alias>` SHALL fork the current session at its head into a new session using the preset endpoint and SHALL leave the source session unchanged.

#### Scenario: Switch model

- **WHEN** the user runs `/model` with a valid alias while settled
- **THEN** the client moves to a new session whose model is the preset model and whose history matches the source head

#### Scenario: Unknown alias

- **WHEN** the alias is not in the catalog
- **THEN** the client reports the missing alias and does not create a session

#### Scenario: Busy turn

- **WHEN** a turn is still running
- **THEN** the client rejects the switch and keeps the current session

### Requirement: Session navigation

The client SHALL start a new session with `/new`, list sessions with `/sessions`, and resume a listed session with `/resume`, replacing the active subscription and transcript on success.

#### Scenario: Resume session

- **WHEN** the user resumes a listed session
- **THEN** the client subscribes to that session and subsequent prompts are recorded there

#### Scenario: Unknown session

- **WHEN** the requested session id does not exist
- **THEN** the client reports the error and keeps the current session active

### Requirement: Fork and handoff

`/fork [entryId]` SHALL fork at the given entry or the current head, and `/handoff <alias> [--cwd <path>] [--sandbox <mode>] [--network <policy>]` SHALL fork at the head with the preset model plus the requested environment overrides.

#### Scenario: Fork at head

- **WHEN** the user runs `/fork` while settled
- **THEN** a new session records the source as parent and the fork entry, and the source remains unchanged

#### Scenario: Handoff changes environment

- **WHEN** the user runs `/handoff` with a preset and `--cwd`
- **THEN** the new session uses the preset model and the requested working directory, and the client moves to it

### Requirement: Status and usage display

The client SHALL show the active session, model, sandbox mode and network, and working directory in `/status` and in a persistent status line, and SHALL report aggregated usage and the latest context projection on `/usage` and `/context`.

#### Scenario: Status after sandbox change

- **WHEN** the user changes the sandbox mode
- **THEN** the status output and status line reflect the effective mode and network

#### Scenario: Context after a model step

- **WHEN** the client receives a context projection event
- **THEN** `/context` reports the projected message count and estimated tokens

### Requirement: Manual compaction command

`/compact` SHALL request manual compaction only when the session is settled and SHALL report the token counts from the compaction result or state that nothing was compacted.

#### Scenario: Compaction succeeds

- **WHEN** the user runs `/compact` on a settled session with compactable history
- **THEN** the client reports tokens before and after and the transcript shows a compaction marker

#### Scenario: Nothing to compact

- **WHEN** the session has no compactable cut point
- **THEN** the client reports that nothing was compacted and the history is unchanged

### Requirement: Side question

`/btw <question>` SHALL request a side answer that is displayed outside the main conversation, is not written to the session log, and runs with no tools.

#### Scenario: Side question isolated

- **WHEN** the user runs `/btw` on a settled session
- **THEN** the answer is displayed in a marked side block and the session's last entry and usage summary are unchanged

#### Scenario: Side question during a turn

- **WHEN** a turn is still running
- **THEN** the client reports that side questions require a settled session and calls no model

### Requirement: Configuration inspection

`/config` SHALL report the catalog path, default preset, preset names, and whether each referenced API key variable is set, and SHALL NOT print key values.

#### Scenario: Masked keys

- **WHEN** the user runs `/config`
- **THEN** the output shows variable names and presence, never the secret values
