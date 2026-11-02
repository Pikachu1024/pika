# client-protocol Specification

## Purpose

Defines the protocol, transports, typed SDK, and CLI boundary so that every surface consumes the same session, turn, approval, and sandbox semantics.

## Requirements

### Requirement: Session and turn protocol

The harness SHALL expose a JSON-RPC-style protocol supporting initialization, session start, resume, fork, and list, turn start, steer, and interrupt, approval response, subscription management, and event notifications.

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
