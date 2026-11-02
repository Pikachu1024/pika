# extensions Specification

## Purpose

Defines Agent Skills discovery and lazy loading, MCP server lifecycle, authentication, and tool exposure so external capabilities integrate without expanding the core runtime.

## Requirements

### Requirement: Skill discovery and lazy loading

The harness SHALL discover skills from builtin, user, project, and plugin scopes, SHALL expose only each skill's name and description in the system prompt, and SHALL load the full skill body only when selected.

#### Scenario: Skill not selected

- **WHEN** a skill exists but is not relevant to the current turn
- **THEN** only its name and description appear in the prompt and its body is not sent to the model

#### Scenario: Skill selected

- **WHEN** the model or user selects a skill
- **THEN** the skill body is loaded and made available for the current turn

### Requirement: MCP server lifecycle

The harness SHALL support stdio and streamable HTTP MCP servers, SHALL handle OAuth authentication, and SHALL recover from server crashes and tool-list changes without restarting the session.

#### Scenario: Server crash

- **WHEN** an MCP server process exits unexpectedly
- **THEN** its tools are marked unavailable and the session continues with the remaining tools

#### Scenario: Reconnect

- **WHEN** a previously unavailable MCP server becomes reachable again
- **THEN** its tools are rediscovered and made available without restarting the session

### Requirement: Tool exposure and project trust

Project-scoped MCP servers SHALL require project trust before starting, and their tools SHALL be filterable by allow and deny rules and namespaced by server.

#### Scenario: Untrusted project server

- **WHEN** a project configuration declares an MCP server but the project is not trusted
- **THEN** the server is not started and its tools are not exposed

#### Scenario: Namespaced tools

- **WHEN** a trusted MCP server exposes a tool
- **THEN** the tool is registered under a server-namespaced name and remains subject to tool allow and deny rules
