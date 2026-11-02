# tool-system Specification

## Purpose

Defines tool registration, input validation, approval-aware execution, result normalization, output truncation, and lifecycle events.

## Requirements

### Requirement: Tool contract and validation

Each tool SHALL declare a name, description, input schema, and approval requirement, and invalid input SHALL be returned to the model as an error result without executing the tool.

#### Scenario: Missing required argument

- **WHEN** the model calls a tool without a required argument
- **THEN** the executor returns a validation error result and performs no side effect

#### Scenario: Unknown tool

- **WHEN** the model calls a tool name that is not registered
- **THEN** the executor returns an unknown-tool error result and continues the turn

### Requirement: Ordered, parallel-aware execution

The executor SHALL preflight every tool call, run approved independent calls concurrently, serialize calls with conflicting write targets, and return results in the original call order.

#### Scenario: Mixed read and write batch

- **WHEN** the model issues two read calls and one write call in one batch
- **THEN** the reads may run concurrently, the write is serialized, and results are recorded in the original call order

### Requirement: Normalized results and truncation

The executor SHALL normalize tool output into text, image, and error content, and SHALL truncate oversized output while persisting the complete output and returning a retrievable reference.

#### Scenario: Oversized output

- **WHEN** a tool produces output larger than the configured limit
- **THEN** the model receives head and tail excerpts plus a reference, and the complete output is persisted in the session directory

### Requirement: Tool lifecycle events

The executor SHALL emit start, update, and end events for each tool call, including an exit status or error classification.

#### Scenario: Long-running command

- **WHEN** a shell command produces incremental output
- **THEN** update events are emitted before the end event, and the end event includes the exit code
