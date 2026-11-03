# Spec Delta

## REMOVED Requirements

### Requirement: Local session storage location

**Reason**: Sessions now default to the Pika home directory so stored state is independent of the launch directory.

**Migration**: Set `PIKA_SESSION_DIR` or `pika serve --dir` to keep a working-directory store; otherwise sessions move to `$PIKA_HOME/sessions` (`~/.pika/sessions` by default).

## ADDED Requirements

### Requirement: Pika home session storage

An auto-started local server SHALL store sessions under `$PIKA_HOME/sessions`, defaulting to `~/.pika/sessions`, and SHALL store them under `PIKA_SESSION_DIR` or `pika serve --dir` when either is set.

#### Scenario: Sessions follow the Pika home directory

- **WHEN** the client starts a local server without `PIKA_SESSION_DIR` or `--dir`
- **THEN** sessions for that run are stored under `$PIKA_HOME/sessions`, defaulting to `~/.pika/sessions`

#### Scenario: Explicit session directory

- **WHEN** `PIKA_SESSION_DIR` or `pika serve --dir` names a directory
- **THEN** sessions for that run are stored under the named directory instead of the Pika home directory

#### Scenario: Custom Pika home

- **WHEN** `PIKA_HOME` names a directory and no explicit session directory is set
- **THEN** sessions for that run are stored under `<PIKA_HOME>/sessions`
