# Spec Delta

## ADDED Requirements

### Requirement: Authenticated local WebSocket connections

A local server started by `pika` SHALL authenticate WebSocket connections during the upgrade with the per-run token, SHALL reject connections that omit or mismatch the token before accepting any protocol frame, and SHALL leave stdio and in-process transport semantics unchanged.

#### Scenario: Authenticated connection

- **WHEN** the client connects to its local server with the current run token
- **THEN** the upgrade succeeds and JSON-RPC requests and notifications flow normally

#### Scenario: Missing or wrong token

- **WHEN** a WebSocket client connects without a token or with an outdated token
- **THEN** the server rejects the upgrade and sends no protocol frames to that client

#### Scenario: Other transports unaffected

- **WHEN** the same turn runs over stdio or in-process transports
- **THEN** the token requirement does not apply and the event sequence matches the unauthenticated behavior
