# Spec Delta

## ADDED Requirements

### Requirement: Fork overrides

`session.fork` SHALL accept optional `model`, `llm`, and `cwd` overrides and SHALL return the resulting session metadata.

#### Scenario: Override model and working directory

- **WHEN** a client forks a session with a model and working directory
- **THEN** the new session reports the override values and the source session is unchanged

#### Scenario: Inherit when omitted

- **WHEN** a client forks without overrides
- **THEN** the new session inherits the source model and working directory

### Requirement: Manual compaction method

The protocol SHALL expose `session.compact`, which accepts a session id and returns whether compaction occurred plus token counts before and after.

#### Scenario: Compaction requested

- **WHEN** a client sends `session.compact` for a settled session
- **THEN** the server compacts through the runtime and returns the token counts

#### Scenario: Active session

- **WHEN** a client sends `session.compact` while a turn is running
- **THEN** the server rejects the request with the session-not-settled error

### Requirement: Side-question method

The protocol SHALL expose `session.btw`, which accepts a session id and question, returns the answer text and optional usage, and records no session entries.

#### Scenario: Side answer returned

- **WHEN** a client sends `session.btw` for a settled session
- **THEN** the server returns the answer and the session listing's last entry is unchanged

#### Scenario: Active session

- **WHEN** a client sends `session.btw` while a turn is running
- **THEN** the server rejects the request with the session-not-settled error

## MODIFIED Requirements

### Requirement: Session and turn protocol

The harness SHALL expose a JSON-RPC-style protocol supporting initialization, session start, resume, fork, list, compact, and side questions, turn start, steer, follow-up, and interrupt, approval response, subscription management, and event notifications.

#### Scenario: Multiple subscribers

- **WHEN** two clients subscribe to the same session
- **THEN** both receive the same ordered event notifications

#### Scenario: Unsubscribe

- **WHEN** a client unsubscribes from a session
- **THEN** it stops receiving events while other subscribers continue
