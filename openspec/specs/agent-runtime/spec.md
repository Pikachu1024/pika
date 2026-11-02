# agent-runtime Specification

## Purpose

Defines the provider-agnostic runtime, event contract, and turn lifecycle that every client and the session store observe.

## Requirements

### Requirement: Provider-agnostic streaming

The runtime SHALL consume provider streams as normalized events for text, reasoning, tool-call deltas, usage, completion, and errors, so the loop never depends on a provider-specific wire format.

#### Scenario: Tool call streamed in chunks

- **WHEN** a provider emits a tool call across multiple chunks
- **THEN** the runtime emits tool-call deltas with a stable call index and identifier, and a completion event with a stop reason

#### Scenario: Provider failure

- **WHEN** a provider request fails or the stream aborts
- **THEN** the runtime emits an error event and returns the agent to idle without terminating the session

### Requirement: Ordered turn lifecycle

The runtime SHALL emit ordered lifecycle events for agent start, turn start, message start/update/end, tool execution start/update/end, turn end, agent end, and a final settled event after all queues and executions are empty.

#### Scenario: Turn with a tool call

- **WHEN** a user prompt causes one model response and one tool execution
- **THEN** events are emitted in lifecycle order and settled is emitted only after the tool result is recorded and the queue is empty

#### Scenario: Follow-up queued

- **WHEN** a follow-up message is queued while a turn is running
- **THEN** the current turn ends first and a new turn starts for the follow-up before settled is emitted

### Requirement: Steering and interruption

The runtime SHALL inject steering messages at the next safe boundary, accept follow-up messages for the next turn, and interrupt the current turn without deleting the session or its recorded events.

#### Scenario: Steer during streaming

- **WHEN** the user steers while the model is streaming text
- **THEN** the runtime completes the current model step, records the steering message, and applies it at the next safe boundary

#### Scenario: Interrupt during tool execution

- **WHEN** the user interrupts while a tool is running
- **THEN** the runtime aborts the execution, records an aborted tool result, ends the turn, and emits settled

### Requirement: Single-writer runtime state

The runtime SHALL serialize state transitions through a single agent loop and SHALL expose state changes only through events; external callers MUST NOT mutate runtime state directly.

#### Scenario: Concurrent caller commands

- **WHEN** two clients send prompt and steer commands concurrently
- **THEN** the runtime processes them through one serialized queue and emits one consistent event order
