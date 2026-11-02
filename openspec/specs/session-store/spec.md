# session-store Specification

## Purpose

Defines the append-only session record as the source of truth, deterministic replay, resume and fork behavior, raw provider capture, and a rebuildable query index.

## Requirements

### Requirement: Append-only session tree

The session store SHALL persist session metadata, messages, tool calls and results, approvals, sandbox decisions, compactions, and turn boundaries as append-only entries linked by identifier and parent identifier.

#### Scenario: Fork at an earlier entry

- **WHEN** a user forks a session at an earlier entry
- **THEN** a new branch is created from that entry and the original branch remains unchanged

#### Scenario: Append during a turn

- **WHEN** a turn records messages, tool results, and a sandbox decision
- **THEN** the entries are appended in occurrence order with stable identifiers

### Requirement: Deterministic replay

The session store SHALL reconstruct the timeline, projection, and prompt for a recorded turn from the log alone, and replaying the same log SHALL produce the same prompt hash.

#### Scenario: Replay after restart

- **WHEN** a recorded session is replayed after a process restart
- **THEN** the reconstructed prompt hash matches the hash recorded during the original turn

### Requirement: Resume and fork

The harness SHALL resume an existing session from its last settled state, fork a session at a chosen entry with optional model and working-directory overrides, and list sessions with their status.

#### Scenario: Resume

- **WHEN** a user resumes a session that ended at a settled state
- **THEN** a new turn continues from that state without replaying completed side effects

#### Scenario: Fork with overrides

- **WHEN** a user forks at an entry with a different model and working directory
- **THEN** the new session records the overrides, the parent session id, and the fork entry, and the source session remains unchanged

### Requirement: Rebuildable index

The session store SHALL maintain a query index derived from the append-only log, and the index SHALL be safely deletable and rebuildable without losing session data.

#### Scenario: Index rebuild

- **WHEN** the query index is deleted and rebuilt from the log
- **THEN** session listings, token totals, and search results match the pre-deletion state

### Requirement: Raw provider capture

The session store SHALL persist raw provider requests and responses separately from the replay log for debugging, and replay SHALL not depend on those raw payloads.

#### Scenario: Raw capture excluded from replay

- **WHEN** a session with raw provider payloads is replayed
- **THEN** replay succeeds from the structured log even if the raw payloads are removed
