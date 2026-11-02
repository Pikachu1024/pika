# Spec Delta

## Purpose

Defines the sandbox as an enforcement boundary separate from approval: policy resolution, platform executors, filesystem and network confinement, environment scrubbing, escalation, and decision audit.

## ADDED Requirements

### Requirement: Sandbox policy model

The sandbox SHALL resolve an effective policy from session mode, tool requirements, user rules, and project trust, supporting read-only, workspace-write, and danger-full-access modes with writable roots, denied reads, network policy, environment allowlist, timeout, and output limit.

#### Scenario: Workspace-write confinement

- **WHEN** the effective mode is workspace-write and a command writes inside the workspace
- **THEN** the write succeeds, while a write outside the workspace fails with a sandbox denial

#### Scenario: Read-only mode

- **WHEN** the effective mode is read-only
- **THEN** reads inside the workspace succeed and any write or process-spawn request is denied unless separately approved

### Requirement: Executor boundary

All subprocess execution initiated by tools SHALL pass through a sandbox executor, and tools MUST NOT spawn processes directly. The executor SHALL record its backend and effective policy for each execution.

#### Scenario: Shell tool execution

- **WHEN** the shell tool runs a command
- **THEN** the execution is performed by the configured executor and the backend is recorded in the session log

#### Scenario: Direct spawn prohibited

- **WHEN** a tool implementation attempts to spawn a process without the executor
- **THEN** the build or conformance check rejects the tool

### Requirement: Environment and secret isolation

Child processes SHALL receive only an explicitly constructed allowlisted environment. Provider credentials and unrelated process environment MUST NOT be inherited, and shell startup files MUST NOT be sourced.

#### Scenario: Environment inspection

- **WHEN** an agent runs an environment-listing command in a sandboxed shell
- **THEN** provider API keys and non-allowlisted variables are absent from the output

#### Scenario: Startup file isolation

- **WHEN** a user shell startup file defines an environment marker or alias
- **THEN** the sandboxed command does not observe that marker or alias

### Requirement: Filesystem confinement for in-process tools

File operations performed in-process by tools SHALL enforce the same path policy as subprocess execution, SHALL resolve symlinks before authorizing, and SHALL reject writes outside writable roots.

#### Scenario: In-process write outside workspace

- **WHEN** the file-write tool targets a path outside the workspace
- **THEN** the operation is denied even though no subprocess was started

#### Scenario: Symlink escape

- **WHEN** a path inside the workspace resolves through a symlink to a location outside it
- **THEN** the operation is denied

### Requirement: Network policy

Network access SHALL default to none. In proxy mode, traffic SHALL be permitted only through a local proxy that enforces destination allowlists and records outbound requests.

#### Scenario: Blocked destination

- **WHEN** a sandboxed command connects to a host not on the allowlist
- **THEN** the connection fails and the denial is recorded

#### Scenario: Allowed destination

- **WHEN** a sandboxed command connects to an allowlisted host through the proxy
- **THEN** the request succeeds and the outbound request is recorded

### Requirement: Approval integration and escalation

A sandbox denial SHALL produce an escalation request identifying the denied operation. Accepting for the session SHALL widen the effective policy for that session and SHALL be recorded as an escalation.

#### Scenario: Escalation accepted

- **WHEN** a command is denied by the sandbox and the user accepts the escalation for the session
- **THEN** the command is retried under the widened policy and the session log records the escalation

#### Scenario: Escalation declined

- **WHEN** the user declines the escalation
- **THEN** the original policy remains in effect and the tool result reports the denial

### Requirement: Sandbox decision audit

Every sandbox decision SHALL be recorded as an event containing the tool call identifier, backend, mode, outcome, and reason, and replay SHALL expose the same decisions.

#### Scenario: Replay decisions

- **WHEN** a recorded session is replayed
- **THEN** each sandbox decision is visible with the same outcome and reason as during the original run

### Requirement: Policy monotonicity

Child tasks and subagents SHALL receive a policy no broader than their parent's, and escalation requests that would exceed the parent policy SHALL be rejected or clamped.

#### Scenario: Child requests broader policy

- **WHEN** a child task running under a read-only parent requests workspace-write access
- **THEN** the request is rejected or clamped and the rejection is recorded
