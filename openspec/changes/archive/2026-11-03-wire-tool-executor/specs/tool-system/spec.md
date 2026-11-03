# Spec Delta

## ADDED Requirements

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
