# Tasks

## 1. Pika home and configuration migration

- [x] 1.1 Add a CLI home resolver that returns `PIKA_HOME` when set and `~/.pika` otherwise, and route the config directory through it while keeping `PIKA_CONFIG_DIR` as the explicit override; verify unit tests cover `PIKA_HOME`, `PIKA_CONFIG_DIR` precedence, and the `HOME`-based default.
- [x] 1.2 Point catalog and credential paths at the resolved home directory and update the existing catalog/credential tests; verify `bun test apps/cli/test/catalog.test.ts apps/cli/test/credentials.test.ts` passes with the new default.
- [x] 1.3 Implement non-destructive startup migration that copies `models.json` and `credentials.json` from `$XDG_CONFIG_HOME/pika` or `~/.config/pika` into the home directory when the target file is absent; verify tests cover a copy, an existing target file left untouched, a missing legacy directory, and credentials mode `0600`.
- [x] 1.4 Run migration from the CLI startup path before credentials and catalog loading and report failures as warnings without aborting; verify a test with an unreadable legacy path still starts the client and prints the warning.

## 2. Default session directory

- [x] 2.1 Resolve the default `pika serve` session directory from `PIKA_HOME` (default `~/.pika`) plus `sessions`, keeping `PIKA_SESSION_DIR` and `--dir` precedence; verify `packages/server/test/serve.test.ts` covers the home default, a custom `PIKA_HOME`, and both explicit overrides.
- [x] 2.2 Update the `serve` usage text to describe `$PIKA_HOME/sessions` as the default; verify the usage test asserts the new text.
- [x] 2.3 Confirm the launcher forwards `PIKA_HOME` to the child server and that a local run without `PIKA_SESSION_DIR` writes under `PIKA_HOME/sessions`; verify an integration test spawns the entrypoint with a temporary `PIKA_HOME` and finds the session directory there.

## 3. Binary install script

- [x] 3.1 Add `scripts/install.sh` that builds the standalone binary and installs it as `pika` with mode `0755` into `PIKA_INSTALL_DIR` (default `~/.local/bin`), aborting non-zero on build failure without touching an existing install; verify `bash -n scripts/install.sh` and a run against a temporary install directory produce an executable `pika`.
- [x] 3.2 Print the installed path and a `PATH` note only when the install directory is absent from `PATH`; verify both branches by running the script with and without the temporary directory on `PATH`.
- [x] 3.3 Add the `install:local` script to the root `package.json` and document it alongside `build:binary`; verify `bun run install:local` resolves to the new script.

## 4. Documentation

- [x] 4.1 Update `apps/cli/src/cli.ts` and `apps/pika/src/usage.ts` usage text with `PIKA_HOME`, `~/.pika` config/credential paths, and the sessions default; verify a usage test or snapshot includes the new paths and environment variable.
- [x] 4.2 Update `docs/cli.md`, `docs/providers.md`, `docs/extensions.md` if needed, and `README.md` to describe the single home directory, overrides, migration behavior, and installation command; verify the documented paths match the implemented defaults.
- [x] 4.3 Document the archive ordering between `add-in-tui-llm-config` and this change in the change notes; verify the note names the reason (the XDG requirement is replaced by this change's delta).

## 5. Integration

- [x] 5.1 Run `bun run check` and verify typecheck, lint, boundary checks, and all tests pass.
- [x] 5.2 Run the installed binary with a temporary `HOME` and no `PIKA_SESSION_DIR`, send one prompt, and verify sessions, catalog reads, and credential reads all resolve under the temporary Pika home.

## Workflow follow-up

- Archive `add-in-tui-llm-config` before this change; its XDG-based "User-level configuration storage" requirement is the target of this change's MODIFIED delta.
- Archive this change only after `bun run check` and the installed-binary smoke run pass.
