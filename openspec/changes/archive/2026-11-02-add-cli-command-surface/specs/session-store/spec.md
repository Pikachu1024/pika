# Spec Delta

## MODIFIED Requirements

### Requirement: Resume and fork

The harness SHALL resume an existing session from its last settled state, fork a session at a chosen entry with optional model and working-directory overrides, and list sessions with their status.

#### Scenario: Resume

- **WHEN** a user resumes a session that ended at a settled state
- **THEN** a new turn continues from that state without replaying completed side effects

#### Scenario: Fork with overrides

- **WHEN** a user forks at an entry with a different model and working directory
- **THEN** the new session records the overrides, the parent session id, and the fork entry, and the source session remains unchanged
