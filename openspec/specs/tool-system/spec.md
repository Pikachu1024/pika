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

### Requirement: Server-provided built-in tools

The server SHALL expose the built-in file and shell tools `read_file`, `write_file`, `edit_file`, `glob`, `grep`, and `bash` to every session it starts, resumes, or forks in serve mode, declare them to the provider before the first turn, and execute their calls through the session tool executor.

#### Scenario: Built-in tools declared

- **WHEN** a session starts in serve mode
- **THEN** the first provider request declares all six built-in tools

#### Scenario: Built-in tool executes

- **WHEN** the model calls `read_file` with a valid path
- **THEN** the tool result contains the file content and the session records a matching `tool_execution_end` event

#### Scenario: Tooling not configured

- **WHEN** an embedded server is created without a tooling configuration
- **THEN** a tool call returns an explicit not-configured error result and the turn continues to settle

### Requirement: Per-session workspace binding

The server SHALL bind built-in tools to the workspace of the session that invoked them, including sessions started, resumed, or forked with a different `cwd`. Relative paths SHALL resolve against that workspace and shell commands SHALL run with it as the working directory.

#### Scenario: Fork with a different workspace

- **WHEN** a session is forked with a different `cwd`
- **THEN** relative file reads and shell commands in the forked session target the forked workspace

#### Scenario: Path escape denied

- **WHEN** a file tool receives a relative or absolute path that resolves outside the session workspace
- **THEN** the tool returns a path-policy denial and performs no write

#### Scenario: Sessions stay isolated

- **WHEN** two active sessions use different workspaces
- **THEN** a relative path in one session never resolves against the other session's workspace
