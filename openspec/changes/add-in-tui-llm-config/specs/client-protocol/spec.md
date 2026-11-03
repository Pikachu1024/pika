# Spec Delta

## ADDED Requirements

### Requirement: Endpoint tool capability

The `llm` endpoint accepted by session start, resume, and fork SHALL include an optional `tools` boolean, where omission means tool calling is enabled. A session whose endpoint sets `tools` to false SHALL advertise no tools to the provider.

#### Scenario: Tools disabled

- **WHEN** a client starts a session with an endpoint whose `tools` flag is false
- **THEN** the first provider request declares no tools and the session emits no tool execution events

#### Scenario: Default enabled

- **WHEN** a client starts a session with an endpoint that omits `tools`
- **THEN** the endpoint is treated as tool-capable and the server applies its configured tooling

#### Scenario: Fork inherits capability

- **WHEN** a client forks a session without an endpoint override
- **THEN** the forked session inherits the source endpoint and its tool capability

#### Scenario: Fork overrides capability

- **WHEN** a client forks a session with an endpoint whose `tools` flag differs from the source
- **THEN** the forked session uses the override while the source session keeps its existing capability
