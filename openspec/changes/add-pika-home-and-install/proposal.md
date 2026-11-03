# Proposal

## Why

The built `pika` binary currently scatters user state depending on where it is launched: sessions default to `<cwd>/.pika/sessions`, while user configuration and credentials live under `~/.config/pika`. Moving between projects creates new session roots, and there is no predictable single directory to back up, inspect, or clean. A single home directory makes the binary behave like a normal user-level tool, matching the `BYF_HOME`/`~/.byf` model used by `../byf`.

Separately, `bun run build:binary` leaves the executable at `dist/bin/pika`, so there is no supported way to put it on `PATH` after building.

## What Changes

- Add `PIKA_HOME` as the root for user data, defaulting to `~/.pika`.
- Default local session storage to `$PIKA_HOME/sessions` (`~/.pika/sessions`) instead of `<cwd>/.pika/sessions`. `PIKA_SESSION_DIR` and `pika serve --dir` still override it. **BREAKING**: sessions no longer follow the working directory by default.
- Store the user-level model catalog and credentials directly under `$PIKA_HOME` (`models.json`, `credentials.json`). `PIKA_CONFIG_DIR` still overrides the location. **BREAKING**: the default user config location moves from `~/.config/pika` to `~/.pika`.
- On startup, copy `models.json` and `credentials.json` from the legacy XDG location (`$XDG_CONFIG_HOME/pika` or `~/.config/pika`) into `$PIKA_HOME` when the target file is absent; never delete the legacy files.
- Add `scripts/install.sh` (and `bun run install:local`): build the standalone binary and install it as `pika` into `PIKA_INSTALL_DIR`, defaulting to `~/.local/bin`, then print a `PATH` hint when the directory is not on `PATH`.
- Update usage text, CLI/provider documentation, and the affected specs.

Out of scope:

- GitHub Releases assets, a download-based installer, platform matrices, npm distribution, or auto-update.
- Moving or deleting existing legacy config; migration is a non-destructive copy.
- OS keychain or OAuth credential storage.
- Changing the project-level `<cwd>/.pika/models.json` discovery or its precedence.
- Changing per-session `cwd` semantics; only the default session store root moves.

## Capabilities

### New Capabilities

- `distribution`: how the built single binary is installed onto a user's `PATH`, including the install directory override and post-install guidance.

### Modified Capabilities

- `local-server-lifecycle`: the default local session storage location changes from the working directory to the Pika home directory, still overridable by `PIKA_SESSION_DIR` and `--dir`.
- `cli-commands`: the user-level catalog and credentials location changes to the Pika home directory, with `PIKA_CONFIG_DIR` remaining the explicit override and legacy files copied once.

## Impact

- `apps/cli`: new home-directory resolver and legacy-config migration; catalog, credentials, and CLI startup paths.
- `packages/server`: `parseServeArgs` default session directory and usage text.
- `apps/pika`: entrypoint usage text.
- `scripts`: new `install.sh`; root `package.json` gains an `install:local` script.
- `docs`: CLI, provider, and README path descriptions.
- Tests: CLI home/config tests, server default-directory test, and an install-script smoke check.
- No new runtime dependencies and no change to sandbox, provider, or protocol boundaries.

This change supersedes the config-location decision in the unarchived `add-in-tui-llm-config` change (XDG path); that change's command behavior is unaffected.
