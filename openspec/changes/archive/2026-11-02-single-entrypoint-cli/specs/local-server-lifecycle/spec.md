# Spec Delta

## Purpose

Defines how a single `pika` executable starts, authenticates, connects to, and tears down its bundled local session server, and how remote mode and the explicit `serve` mode fit into that lifecycle.

## ADDED Requirements

### Requirement: Single user-facing entrypoint

One `pika` executable SHALL provide the interactive client, one-shot mode, and an explicit `serve` mode that runs the session server; users MUST NOT need a separate server command for local use.

#### Scenario: Interactive start

- **WHEN** a user runs `pika` with no remote URL
- **THEN** the client starts, connects to a local server it owns, and shows the interactive session

#### Scenario: Server mode

- **WHEN** a user runs `pika serve --port 7331`
- **THEN** the process serves the protocol on that port without starting a terminal UI, and its startup output reports the listening URL

### Requirement: Automatic local server startup

Without an explicit remote endpoint, `pika` SHALL start a local server bound to `127.0.0.1` on an ephemeral port, wait until it is accepting connections, and only then connect the client.

#### Scenario: Ephemeral port negotiated

- **WHEN** the client starts a local server without specifying a port
- **THEN** the client learns the actual port from the startup handshake and connects to it

#### Scenario: Startup failure

- **WHEN** the local server exits or fails to become ready within the startup timeout
- **THEN** the client reports the failure and exits non-zero without entering the interactive UI

### Requirement: Local server authentication

Each auto-started local server SHALL require a random token generated for that run, SHALL reject WebSocket connections that do not present the token, and SHALL keep the token out of user-visible output, logs, and session data.

#### Scenario: Rejected connection

- **WHEN** a WebSocket client connects to the auto-started server without the current token
- **THEN** the server rejects the connection and does not expose the protocol

#### Scenario: Token not disclosed

- **WHEN** the client starts, renders the UI, handles errors, or writes session data
- **THEN** the token does not appear in any output, log line, or stored session record

### Requirement: Local server teardown

The client SHALL stop its local server when the interactive UI exits, when a one-shot prompt settles, and on SIGINT or SIGTERM; the local server SHALL also exit when its parent process disappears.

#### Scenario: Normal exit

- **WHEN** the user quits the UI or a one-shot prompt settles
- **THEN** the client terminates the local server before exiting and no listener remains

#### Scenario: Parent disappears

- **WHEN** the client process dies without running its shutdown path
- **THEN** the local server detects the closed parent channel and exits on its own

### Requirement: Remote mode

When `--url` or `PIKA_SERVER_URL` provides a WebSocket endpoint, `pika` SHALL connect to that endpoint and SHALL NOT start a local server.

#### Scenario: Remote connection

- **WHEN** the user passes `--url ws://host:7331`
- **THEN** the client connects to that endpoint and starts no local server process

### Requirement: Local session storage location

An auto-started local server SHALL store sessions under `<cwd>/.pika/sessions` and SHALL honor `PIKA_SESSION_DIR` when it is set.

#### Scenario: Sessions follow the working directory

- **WHEN** the client starts a local server from a project directory without `PIKA_SESSION_DIR`
- **THEN** sessions for that run are stored under `<cwd>/.pika/sessions`
