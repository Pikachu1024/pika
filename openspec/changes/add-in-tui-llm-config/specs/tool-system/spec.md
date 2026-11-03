# Spec Delta

## MODIFIED Requirements

### Requirement: Server-provided built-in tools

The server SHALL expose the built-in file and shell tools `read_file`, `write_file`, `edit_file`, `glob`, `grep`, and `bash` to every session it starts, resumes, or forks in serve mode unless the session's LLM endpoint sets `tools` to false, declare them to the provider before the first turn, and execute their calls through the session tool executor.

#### Scenario: Built-in tools declared

- **WHEN** a session starts in serve mode with tool calling enabled
- **THEN** the first provider request declares all six built-in tools

#### Scenario: Built-in tool executes

- **WHEN** the model calls `read_file` with a valid path
- **THEN** the tool result contains the file content and the session records a matching `tool_execution_end` event

#### Scenario: Tooling not configured

- **WHEN** an embedded server is created without a tooling configuration
- **THEN** a tool call returns an explicit not-configured error result and the turn continues to settle

#### Scenario: Tool calling disabled

- **WHEN** a session starts with an endpoint whose `tools` flag is false
- **THEN** the first provider request declares no built-in tools and the session emits no tool execution events
