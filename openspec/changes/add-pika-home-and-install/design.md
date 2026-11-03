# Design

## Context

See `proposal.md` for motivation.

- `apps/cli/src/catalog.ts` resolves the user config directory from `PIKA_CONFIG_DIR`, then `XDG_CONFIG_HOME/pika`, then `~/.config/pika`; `credentials.ts` reuses it.
- `packages/server/src/serve.ts` defaults `--dir` to `<cwd>/.pika/sessions` and honors `PIKA_SESSION_DIR`.
- `apps/pika/src/launcher.ts` forwards `PIKA_*` variables and a fixed environment allowlist to the child server, so `PIKA_HOME` reaches both sides without launcher changes.
- `scripts/build-binaries.ts` produces `dist/bin/pika`; there is no install step.
- Package boundaries forbid `cli` importing `core`/`server`/`adapters`, and `server` importing `cli`. A shared home resolver cannot live in `schema` without changing that package's purpose.

## Goals / Non-Goals

**Goals:**

- One predictable user-data root for sessions, configuration, and credentials.
- A non-destructive path from the current XDG configuration.
- An install workflow that works from a source checkout on macOS/Linux without root.
- Keep explicit overrides (`PIKA_HOME`, `PIKA_CONFIG_DIR`, `PIKA_SESSION_DIR`, `--dir`) working.

**Non-Goals:**

- Release hosting, checksums, signing, auto-update, or Windows installation.
- Migrating existing per-project session directories.
- Changing project catalog discovery or session `cwd` semantics.
- Introducing a shared path package or touching sandbox/provider code.

## Decisions

### Layout under `~/.pika`

`PIKA_HOME` (default `~/.pika`) is the root: `models.json`, `credentials.json`, `sessions/`, and the already-documented `skills/`. `PIKA_CONFIG_DIR` remains an explicit config override.

Alternatives considered:

- **Keep XDG for config and only move sessions**: leaves two roots and does not match the requested byf-style behavior.
- **`~/.pika/config/` subdirectory**: adds nesting for two files without a second consumer.
- **Follow `BYF_HOME` naming exactly**: rejected; `PIKA_HOME` matches the project's existing `PIKA_*` namespace.

`PIKA_CONFIG_DIR` is retained instead of removed because tests and advanced users use it to isolate state, and removing it would be a larger breaking change than the default-location move.

### Separate small resolvers in CLI and server

The CLI gets a home resolver in `apps/cli`; `parseServeArgs` gets an equivalent few-line resolver in `packages/server`. The duplication is intentional: the package boundary forbids sharing through `cli`, and adding a workspace package for one path rule costs more than the duplication.

Alternatives considered:

- **New `packages/paths` package**: adds build, boundary, and dependency surface for a single function.
- **Launcher injects `--dir`**: works for the bundled path but leaves `pika serve` standalone with the old default.
- **Put the resolver in `schema`**: `schema` owns protocol/event contracts, not filesystem policy.

### Copy-on-start migration from XDG

When `PIKA_CONFIG_DIR` is unset, the client copies `models.json` and `credentials.json` from `$XDG_CONFIG_HOME/pika` or `~/.config/pika` into the home directory if the target file is absent. It never deletes or rewrites the legacy files and only copies file-by-file, so a partially configured user keeps whichever file already exists at the target.

Alternatives considered:

- **Move**: risks losing data if a copy fails midway or another process still reads the old path.
- **Symlink**: platform- and permission-sensitive, and can confuse atomic writes.
- **No migration**: users would appear to lose presets and keys after upgrading.
- **Warn instead of copy**: requires UI work and still leaves users broken.

Migration runs in the CLI startup path before credentials and catalog loading. A failure is reported as a startup warning rather than aborting the TUI, because a read-only legacy directory must not make the binary unusable.

### Install script contract

`scripts/install.sh` runs `bun run build:binary`, then installs `dist/bin/pika` with mode `0755` into `PIKA_INSTALL_DIR` (default `~/.local/bin`). It prints the installed path and a `PATH` note only when needed. It does not use `sudo` and does not download release assets. `bun run install:local` is the discoverable entrypoint.

Alternatives considered:

- **Write to `/usr/local/bin` by default**: requires root on common setups and is surprising for a source checkout.
- **Download from GitHub Releases (byf's installer)**: no release pipeline exists yet.
- **Copy during `build:binary`**: conflates building with mutating the user's `PATH`; installs should be explicit.

### Archive ordering with `add-in-tui-llm-config`

The unarchived `add-in-tui-llm-config` change adds a "User-level configuration storage" requirement that names the XDG path. This change's `cli-commands` delta is a MODIFIED requirement that replaces that text with the Pika home path, so `add-in-tui-llm-config` must be archived first; otherwise archive reports the target requirement as missing. The proposal records that this change supersedes the earlier location decision. Updating the other change's artifacts directly was rejected to avoid rewriting in-flight work; the ordering is captured as a task instead.

## Risks / Trade-offs

- **Users expect sessions beside the project** → `PIKA_SESSION_DIR` and `--dir` remain; docs describe the new default prominently.
- **Legacy copy leaves two copies of secrets** → copy only happens once per file, modes are preserved/forced to `0600` for credentials, and the legacy copy is documented for manual cleanup.
- **A failed copy warns but does not fail startup** → users may run without migrated presets; the warning names the file so the fix is explicit.
- **Duplicated resolver can drift** → both copies stay under ten lines and each has a direct default-directory test.
- **Install script assumes `bun` and `install` exist** → it checks `bun`, exits non-zero with a clear message, and leaves any previous install untouched.
- **Archive ordering dependency** → documented in the proposal and a task; validation reports it as an informational issue, not an error.

## Migration Plan

1. On first start after upgrade, copy legacy XDG configuration files into `$PIKA_HOME` (or `~/.pika`) without deleting them.
2. New sessions default to `$PIKA_HOME/sessions`; existing session directories are not moved. Users who need old sessions can point `PIKA_SESSION_DIR`/`--dir` at them or move them manually.
3. Rollback: set `PIKA_HOME` to the old roots or remove the copied files; no legacy file was modified.
