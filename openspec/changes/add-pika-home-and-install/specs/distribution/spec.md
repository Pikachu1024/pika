# Spec Delta

## Purpose

Defines how the built Pika binary is installed onto a user's `PATH` and how the installed executable resolves its user-data home.

## ADDED Requirements

### Requirement: Single-binary installation

The install workflow SHALL build the standalone `pika` executable and install exactly that one file into the directory named by `PIKA_INSTALL_DIR`, defaulting to `~/.local/bin`, with executable permissions and without requiring root.

#### Scenario: Default install directory

- **WHEN** a user runs the install workflow without `PIKA_INSTALL_DIR`
- **THEN** the `pika` executable is installed at `~/.local/bin/pika` and is executable

#### Scenario: Explicit install directory

- **WHEN** `PIKA_INSTALL_DIR` names a writable directory
- **THEN** the `pika` executable is installed in that directory instead

#### Scenario: Build failure

- **WHEN** building the standalone binary fails
- **THEN** the install workflow exits non-zero and leaves any previously installed `pika` executable untouched

### Requirement: PATH guidance

After a successful install, the workflow SHALL report the installed executable path and SHALL tell the user when the install directory is not on `PATH`.

#### Scenario: Install directory not on PATH

- **WHEN** the install directory is absent from `PATH`
- **THEN** the workflow reports the installed path and a note explaining how to add the directory to `PATH`

#### Scenario: Install directory already on PATH

- **WHEN** the install directory is already on `PATH`
- **THEN** the workflow reports the installed path without printing the `PATH` note

### Requirement: Installed binary home resolution

The installed executable SHALL resolve user data through the Pika home directory regardless of its launch directory, using `PIKA_HOME` when set and `~/.pika` otherwise.

#### Scenario: Launch from an arbitrary directory

- **WHEN** the installed `pika` binary starts without `PIKA_HOME`
- **THEN** user data paths are rooted at `~/.pika`, not at the launch directory

#### Scenario: Override home

- **WHEN** `PIKA_HOME` is set
- **THEN** user data paths are rooted at the value of `PIKA_HOME`
