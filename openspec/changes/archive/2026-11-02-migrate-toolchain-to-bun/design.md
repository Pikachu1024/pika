# Design

## Context

See `proposal.md` for motivation. The repository is a strict TypeScript ESM workspace with one-way package boundaries (`schema <- core <- adapters <- server`, `schema <- client <- cli`). It currently uses Node 24 + pnpm 10, Vitest, per-package `tsc` builds, and a Node SEA binary pipeline (esbuild CJS bundle + postject + codesign). Product code imports Node built-ins (`node:fs`, `node:path`, `node:child_process`, `node:readline`), which Bun implements.

Constraints that shape the migration:

- Sandbox, approval, path-policy, and provider behavior must not change.
- Type checking must stay strict (`NodeNext`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`).
- Tests must remain deterministic and must not hit live providers in `bun run check`.
- Only `packages/adapters/src/sandbox` may import `node:child_process`.

## Goals / Non-Goals

**Goals:**

- One toolchain for install, scripts, tests, and binary builds: Bun 1.4.4.
- Preserve the existing test count and skip behavior (318 pass, 23 environment skips).
- Keep standalone `pika` and `pika-server` binaries that run without `node_modules`.
- Keep CI, documentation, and OpenSpec context consistent with the Bun workflow.

**Non-Goals:**

- No protocol, runtime, context, sandbox, provider, or session-format changes.
- No replacement of TypeScript type checking or Biome.
- No release matrix or cross-compiled artifact publishing.
- No promotion of Bun-specific APIs into product code.

## Decisions

### Full Bun toolchain instead of a hybrid

Chosen: Bun workspaces, `bun install`, `bun test`, and `bun build --compile`.

Alternatives: keep pnpm and only use Bun to run/compile; use Bun for binaries only. Both leave two lockfiles/toolchains and keep `pnpm` in every script, which contradicts the requirement.

Trade-off: larger migration surface and dependence on Bun's Node compatibility. Mitigated by running the complete suite and the sandbox conformance suite after each phase.

### `bun:test` instead of Vitest

The suite uses a small Vitest surface: `vi.fn` (4 uses), `vi.stubEnv`/`vi.unstubAllEnvs` (5 uses), `it.each`, `describe.skipIf`, and standard matchers. All were verified under `bun:test`. `vi.fn` becomes `mock`; environment stubbing becomes explicit save/restore of `process.env`.

Alternatives: run Vitest under Bun (`bunx vitest`). Rejected because it keeps Vitest as the runner and a second config path.

Trade-off: Bun mock lifecycle and matcher edge cases can differ. Mitigated by the full-suite run; tests are already isolated per file.

### Keep `tsc --noEmit` and Biome

Bun executes and bundles TypeScript but does not type-check or lint. `tsc` remains the type gate and Biome remains the lint/format gate.

Alternative: rely on Bun's transpiler alone. Rejected because it drops strictness guarantees.

### `bun build --compile` instead of Node SEA

Chosen: compile each bin entry directly with Bun. This removes the esbuild CJS conversion, the `import.meta.url` shim for pi-tui, postject blob injection, and macOS signature removal/re-signing.

Alternatives: keep Node SEA (works, but is Node-specific and has more moving parts); distribute `dist` + Node (not standalone).

Trade-off: binaries embed Bun and are large; optional native modules may need externalization. Mitigated by building and running both binaries locally, then performing a live LLM call.

### Keep per-package `dist` builds for global linking

`bun link` bins continue to point at `dist/bin.js`, and `build:js` runs `bun run --filter '*' build` before linking. Package `exports` continue to point at `dist`.

Alternative: point `exports`/`bin` at `src/*.ts` and delete the build step. Bun can run TS directly, but this changes the package boundary surface and removes declaration output. Deferred as a possible follow-up.

### Bin shebang is Bun

Both bin entries use `#!/usr/bin/env bun`, so globally linked commands run under Bun rather than Node.

### Trusted lifecycle scripts

`protobufjs` and `@google/genai` are trusted for their lifecycle scripts because the pi-ai Google provider can depend on them. `koffi` stays untrusted: it is Windows-only terminal input support in pi-tui, guarded by a `try/catch`, and building its native binaries is unnecessary here. `@opentelemetry/api` is added explicitly to `@pika-harness/adapters` so the bundled pi-ai/Mistral observability imports resolve; marking it external would break standalone binaries.

## Risks / Trade-offs

- **Bun test behavior differs from Vitest** → Run the complete suite and fix only genuine compatibility issues; keep assertions unchanged.
- **Optional native modules (`koffi`, `bufferutil`, `utf-8-validate`) break bundling** → Keep them optional/external as needed and verify the compiled binaries at runtime.
- **Sandbox behavior changes under Bun** → Run `bun run test:sandbox`; do not relax any policy or approval check.
- **Two lockfiles temporarily coexist** → Delete pnpm files only after `bun install` and the full suite pass; CI uses `bun install --frozen-lockfile`.
- **Global install PATH gaps** → Document that `~/.bun/bin` must be on `PATH`; binaries remain the no-install option.
- **Binary size** → Accept ~100 MB per standalone binary; document that it embeds the Bun runtime.
- **Bun version drift in CI** → Pin Bun 1.4.4 in the workflow.

## Migration Plan

1. Install Bun 1.4.4; add root `workspaces`, `bunfig.toml`, trusted dependencies; run `bun install`; remove pnpm lock/workspace/npmrc after verification.
2. Migrate test imports and the small `vi` surface; run `bun test`.
3. Rewrite the binary script with `bun build --compile`; build and run both binaries, including a live LLM call.
4. Update GitHub Actions, README, CONTRIBUTING, AGENTS.md, OpenSpec context, framework/sandbox docs, and CHANGELOG.
5. Run `bun run check`, rebuild binaries, and verify global linking.

Rollback: revert the migration commit. There are no data migrations; the pnpm lockfile and Node SEA script remain in git history. Session JSONL files and protocol behavior are unchanged.

## Open Questions

None. Whether to drop per-package `dist` builds in favor of source exports can be decided after the Bun toolchain is stable.
