# Proposal

## Why

The project currently standardizes on Node 24, pnpm 10, Vitest, and a Node SEA binary pipeline. The required toolchain is Bun end to end: one package manager, one test runner, and a native single-file compiler. Consolidating removes parallel lockfiles and build paths, and keeps local runs, CI, and release binaries aligned.

## What Changes

- **BREAKING** Replace the pnpm workspace with Bun workspaces (`bun install`, `bun.lock`); remove `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `.npmrc`.
- Replace root scripts with Bun equivalents for install, tests, type checking, boundary checks, local runs, and builds.
- Migrate all test files from Vitest to `bun:test`, including the small `vi` surface; remove `vitest.config.ts` and the Vitest dependency.
- Replace esbuild + Node SEA + postject with `bun build --compile` for `pika` and `pika-server`.
- Update CI from pnpm/Node to `oven-sh/setup-bun` and Bun commands.
- Update README, CONTRIBUTING, AGENTS.md, OpenSpec context, framework/sandbox docs, and CHANGELOG.
- Remove Node-specific pinning (`.nvmrc`) and obsolete build tooling (`esbuild`, `postject`, `tsx`, `vitest`).
- Keep `tsc --noEmit` for type checking and Biome for lint/format; Bun does not replace either responsibility.

## Capabilities

### New Capabilities

None. This is a tooling-only migration with no product behavior change; the change sets `skip_specs: true`.

### Modified Capabilities

None.

## Impact

- Root and package manifests, lockfile, workspace configuration, and CI workflow.
- All test files (imports and the `vi.fn` / `vi.stubEnv` usages).
- `scripts/build-binaries.ts`, output paths, and macOS signing/injection logic.
- `apps/cli` and `packages/server` bin shebangs become `#!/usr/bin/env bun`.
- `@opentelemetry/api` is added to `@pika-harness/adapters` so the bundled pi-ai/Mistral module graph resolves; `protobufjs` and `@google/genai` become trusted lifecycle scripts.
- Node built-in modules remain the code-level API surface, executed by Bun; Node itself is no longer a runtime prerequisite.

## Out of Scope

- Protocol, runtime, context, sandbox, provider, and session-format behavior.
- Replacing Biome or TypeScript with Bun-native tooling.
- A cross-platform release pipeline; the binary script supports local targets, but CI artifact publishing is not added.
- Windows-native features such as koffi-backed terminal input; koffi remains optional and untrusted.
