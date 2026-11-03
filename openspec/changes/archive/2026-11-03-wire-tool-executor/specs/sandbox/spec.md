# Spec Delta

## ADDED Requirements

### Requirement: Executor selection and backend reporting

The server SHALL select one sandbox executor at startup from an explicit backend setting or platform auto-detection, SHALL report the selected backend in each session's effective sandbox and sandbox decisions, and SHALL fail startup when an explicitly requested backend is unavailable.

#### Scenario: Explicit backend available

- **WHEN** a supported backend is requested explicitly on a host where it is installed
- **THEN** commands execute through that backend and sessions report it as the effective backend

#### Scenario: Explicit backend unavailable

- **WHEN** an explicitly requested backend is not available on the host
- **THEN** startup fails with an error naming the backend and the missing prerequisite, and no server listens

#### Scenario: Auto selection on macOS

- **WHEN** no backend is configured and Seatbelt is available
- **THEN** startup selects `seatbelt`

#### Scenario: Auto selection on Linux

- **WHEN** no backend is configured and bubblewrap is available
- **THEN** startup selects `bwrap`

#### Scenario: Auto selection unavailable

- **WHEN** no backend is configured and neither Seatbelt (macOS) nor bubblewrap (Linux) is available
- **THEN** startup fails with an error naming the auto-selectable backends and the explicit `docker` and `none` overrides

#### Scenario: Explicit unisolated backend

- **WHEN** the `none` backend is explicitly requested
- **THEN** startup succeeds and sessions report `none` as the backend without claiming operating-system isolation

#### Scenario: Decisions record the selected backend

- **WHEN** a shell tool call runs in a session
- **THEN** its sandbox decision records the same backend reported in the session's effective sandbox
