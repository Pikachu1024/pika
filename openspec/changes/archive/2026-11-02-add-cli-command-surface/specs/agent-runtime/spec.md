# Spec Delta

## ADDED Requirements

### Requirement: Side-question isolation

The runtime SHALL answer a side question only while settled, using the current model and history with an empty tool list, and SHALL NOT alter history, turn counters, usage totals, or persisted events.

#### Scenario: Idle side question

- **WHEN** a side question runs on a settled session
- **THEN** the answer is returned and a subsequent prompt sees the same history as before the question

#### Scenario: Busy side question

- **WHEN** a side question is requested during a turn
- **THEN** the runtime rejects it without calling the provider

#### Scenario: Prompt during side question

- **WHEN** a prompt arrives while a side question is running
- **THEN** the prompt is queued and starts after the side question finishes

## MODIFIED Requirements

### Requirement: Single-writer runtime state

The runtime SHALL serialize turns, side questions, and manual compaction through a single agent loop and SHALL expose state changes only through events; external callers MUST NOT mutate runtime state directly.

#### Scenario: Concurrent caller commands

- **WHEN** two clients send prompt and steer commands concurrently
- **THEN** the runtime processes them through one serialized queue and emits one consistent event order

#### Scenario: Side question and prompt

- **WHEN** a side question and a prompt are submitted at the same time
- **THEN** they execute in one non-overlapping order and the turn event stream contains no interleaved transitions
