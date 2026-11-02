# Tasks

## 1. Bun Workspace and Dependencies

- [x] 1.1 Add root Bun workspaces, `bunfig.toml`, and `@types/bun`; verify `bun install` creates `bun.lock` with 0 errors.
- [x] 1.2 Remove `vitest`, `tsx`, `esbuild`, and `postject` from manifests and add `@opentelemetry/api` to `@pika-harness/adapters`; verify `bun install` resolves the full dependency graph.
- [x] 1.3 Replace the stale `esbuild` trusted dependency with `protobufjs` and `@google/genai`, leaving `koffi` untrusted; verify `bun pm untrusted` lists only `koffi`.
- [x] 1.4 Delete `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, and `.nvmrc`; verify `bun install --frozen-lockfile` succeeds from a clean install.

## 2. Test Runner

- [x] 2.1 Rewrite all test imports to `bun:test`, replace `vi.fn` with `mock`, and replace `vi.stubEnv` with explicit environment save/restore; verify `bun test` reports 318 pass, 23 skip, 0 fail.
- [x] 2.2 Delete `vitest.config.ts` and confirm no Vitest references remain in manifests, configs, or tests; verify `rg -n 'vitest' --glob '!node_modules/**'` returns only changelog or historical mentions.

## 3. Binary Build

- [x] 3.1 Replace `scripts/build-binaries.mjs` with `scripts/build-binaries.ts` using `bun build --compile`; verify `dist/bin/pika` and `dist/bin/pika-server --help` run after copying them outside the repository.
- [x] 3.2 Externalize optional native modules if Bun cannot bundle them, and verify the compiled server handles a real OpenAI-compatible LLM turn.
- [x] 3.3 Verify `bun link` exposes `pika` and `pika-server` from `~/.bun/bin` and that the linked CLI completes a live turn.

## 4. CI

- [x] 4.1 Replace pnpm/Node CI setup with `oven-sh/setup-bun@v2` pinned to 1.4.4, `bun install --frozen-lockfile`, `bun run check`, and the sandbox suite; verify the workflow contains no pnpm or `node-version-file` references.

## 5. Documentation and OpenSpec Context

- [x] 5.1 Update `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `docs/framework-selection.md`, `docs/sandbox.md`, `docs/providers.md`, and `CHANGELOG.md` for Bun commands and the compiled binaries; verify `rg -n 'pnpm|vitest|Node SEA|postject|esbuild' --glob '!node_modules/**' --glob '!openspec/changes/archive/**'` finds no stale instructions.
- [x] 5.2 Update `openspec/config.yaml` project context and apply guidance from Node 24/pnpm 10 to Bun 1.4; verify `openspec validate --all` passes.

## 6. Integration Verification

- [x] 6.1 Run `bun run typecheck`, `bun run lint`, `bun run boundary`, and `bun run test`; verify all exit 0.
- [x] 6.2 Rebuild with `bun run build` and rerun both standalone binaries; verify help output and one live LLM turn.

## Workflow follow-up

- Archive the change after all tracked tasks and review requirements are satisfied.
