# Spec Delta

## ADDED Requirements

### Requirement: Legacy configuration migration

When `PIKA_CONFIG_DIR` is unset, the client SHALL copy `models.json` and `credentials.json` from the legacy XDG configuration directory (`$XDG_CONFIG_HOME/pika` or `~/.config/pika`) into the Pika home directory at startup when the target file is absent, and SHALL leave the legacy files unchanged.

#### Scenario: Copy legacy files

- **WHEN** the Pika home directory lacks `models.json` and `credentials.json` and the legacy directory contains them
- **THEN** both files are copied into the Pika home directory and the legacy files remain in place

#### Scenario: Preserve existing files

- **WHEN** the Pika home directory already contains `models.json` or `credentials.json`
- **THEN** that existing file is not replaced by the legacy copy

#### Scenario: No legacy configuration

- **WHEN** the legacy configuration directory does not exist
- **THEN** startup proceeds without creating or changing any configuration file

## MODIFIED Requirements

### Requirement: User-level configuration storage

The client SHALL store personal presets in a user-level catalog under the Pika home directory, using `PIKA_HOME` when set and `~/.pika` otherwise, overridable with `PIKA_CONFIG_DIR`, and SHALL store API keys in a separate `credentials.json` with mode `0600`.

#### Scenario: Restrictive credentials file

- **WHEN** `/connect` saves an API key
- **THEN** `credentials.json` is created with mode `0600` and contains no preset metadata

#### Scenario: Key never displayed

- **WHEN** the user runs `/config` or `/models` after saving a key
- **THEN** the output reports key presence only and never the key value

#### Scenario: Write failure

- **WHEN** the user catalog or credentials file cannot be written
- **THEN** the command reports the error and leaves the previous catalog and credentials unchanged
