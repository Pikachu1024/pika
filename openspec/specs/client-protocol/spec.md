# client-protocol Specification

## Purpose

Defines the protocol, transports, typed SDK, and CLI boundary so that every surface consumes the same session, turn, approval, and sandbox semantics.

## Requirements

### Requirement: Session and turn protocol

The harness SHALL expose a JSON-RPC-style protocol supporting initialization, session start, resume, fork, list, compact, and side questions, turn start, steer, follow-up, and interrupt, approval response, subscription management, and event notifications.

#### Scenario: Multiple subscribers

- **WHEN** two clients subscribe to the same session
- **THEN** both receive the same ordered event notifications

#### Scenario: Unsubscribe

- **WHEN** a client unsubscribes from a session
- **THEN** it stops receiving events while other subscribers continue

### Requirement: Transport equivalence

The stdio JSONL, WebSocket, and in-process transports SHALL carry identical message semantics and preserve event ordering.

#### Scenario: Same turn over two transports

- **WHEN** the same turn is executed over stdio and in-process transports
- **THEN** both produce the same event sequence and final result

### Requirement: CLI as protocol client

The CLI SHALL consume the protocol and MUST NOT import core packages directly.

#### Scenario: Dependency boundary

- **WHEN** the dependency graph is checked
- **THEN** no CLI module imports a core runtime or storage module directly

### Requirement: Sandbox and approval control

The protocol SHALL expose sandbox mode selection and approval decisions, the server SHALL enforce the effective policy, and clients MUST NOT bypass the executor.

#### Scenario: Client selects a mode

- **WHEN** a client requests a sandbox mode for a session
- **THEN** the server applies the resolved policy, records the decision, and reports the effective mode

#### Scenario: Client cannot bypass enforcement

- **WHEN** a client sends a command that conflicts with the effective policy
- **THEN** the server denies it through the same sandbox path used for agent-initiated commands

### Requirement: Typed SDK

The harness SHALL provide a typed SDK exposing session creation, prompt, steer, interrupt, event subscription, and approval response.

#### Scenario: SDK-driven session

- **WHEN** an SDK consumer creates a session, sends a prompt, and listens for events
- **THEN** it receives typed events and can complete an approval without using the CLI

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

### Requirement: Authenticated local WebSocket connections

A local server started by `pika` SHALL authenticate WebSocket connections during the upgrade with the per-run token, SHALL reject connections that omit or mismatch the token before accepting any protocol frame, and SHALL leave stdio and in-process transport semantics unchanged.

#### Scenario: Authenticated connection

- **WHEN** the client connects to its local server with the current run token
- **THEN** the upgrade succeeds and JSON-RPC requests and notifications flow normally

#### Scenario: Missing or wrong token

- **WHEN** a WebSocket client connects without a token or with an outdated token
- **THEN** the server rejects the upgrade and sends no protocol frames to that client

#### Scenario: Other transports unaffected

- **WHEN** the same turn runs over stdio or in-process transports
- **THEN** the token requirement does not apply and the event sequence matches the unauthenticated behavior
