# Design

## Context

See `proposal.md` for motivation and the spec deltas for observable behaviour.

Current state that shapes the approach:

- `createSessionServer` already resolves a sandbox policy per session and passes `policy`, `backend`, and an `approve` callback into `createRuntime`. The runtime already routes denials through the approval protocol.
- `SessionServerOptions` accepts `tools` and `toolExecutor` separately, and `tools` is a flat array shared by every session. That cannot express a tool set rooted at each session's `cwd`, which fork and resume can change.
- `ToolBatchExecutor`, `ToolRegistry`, `createPathPolicy`, the six tool factories, and `FileToolOutputStore` already exist and are tested. `packages/server` may import `core` and `adapters`, so the missing composition can live there.
- `ShellTool`-style tools (`glob`, `grep`, `bash`) delegate process execution to an `Executor`; `read_file`, `write_file`, and `edit_file` enforce `PathPolicy` in process.
- `NodeProcessExecutor` provides no OS isolation; `SeatbeltExecutor` and `BwrapExecutor` provide the actual enforcement boundary. `startServe` currently hard-codes `backend: "none"`.
- The launcher forwards `PIKA_*` from the parent environment to the server child, so a `PIKA_SANDBOX_BACKEND` setting works in local TUI mode without changing `apps/pika`.

## Goals / Non-Goals

**Goals:**

- Make tool calls from the local TUI execute against the session workspace with real file and shell tools.
- Keep one authoritative policy per session: the executor and path policy must use the same resolved `SandboxPolicy` that the runtime enforces and reports.
- Never silently drop OS isolation: an unavailable isolation backend is a startup error unless the operator explicitly selects `none`.
- Keep the server API impossible to misconfigure with mismatched declarations and executor.
- Preserve the existing protocol, approval flow, event schema, and provider abstraction.

**Non-Goals:**

- Changing the WebSocket protocol, session record format, or event schema.
- Adding MCP or Skills tools, tool allowlists, per-tool configuration, or a network proxy.
- Auto-selecting Docker (its default image does not guarantee the required shell utilities).
- Adding approval UI or changing `/approve` and `/deny` semantics.
- Windows support.

## Decisions

### D1. Replace `tools`/`toolExecutor` with one per-session tooling factory

`SessionServerOptions` gains:

```ts
interface SessionTooling {
  tools: ProviderTool[];
  executor: ToolExecutor;
}

tooling?: SessionTooling | ((context: SessionContext, policy: SandboxPolicy) => SessionTooling)
```

`#createRuntime` resolves the tooling once with the already-resolved policy and passes `tooling.tools` and `tooling.executor` together. The old `tools` and `toolExecutor` options are removed and test fixtures move to the new option.

Rationale: the provider declarations and the executor that recognizes those names must come from the same `ToolRegistry`, and both depend on session identity and workspace. Resolving them as a pair removes the possibility of a declaration without an executor (the current gap) or an executor with stale declarations.

Alternatives considered:

- Keep `tools` static and make only `toolExecutor` dynamic. Rejected: tools would be rooted at the server process `cwd`, so `/handoff --cwd` and `session.start { cwd }` would act on the wrong workspace.
- Keep both old options plus a new factory. Rejected: two construction paths with different semantics invite drift and test/production divergence.
- Build tools inside `createRuntime` from policy alone. Rejected: `core` must not know about provider composition or session storage locations, and the runtime should stay an execution engine rather than a workspace composer.

### D2. A server-side tooling module owns the built-in set

New `packages/server/src/serve-tooling.ts` exports `createServeTooling({ sessionsDir, executor })`, returning a `SessionToolingFactory`.

For each `(context, policy)` it:

1. Creates one `PathPolicy` with `workspaceRoot: policy.workspaceRoot` and the resolved policy.
2. Registers `read_file`, `write_file`, `edit_file`, `glob`, `grep`, and `bash`. File tools use the shared `PathPolicy`; shell tools use `policy.workspaceRoot` as `cwd` and the startup executor.
3. Returns `{ tools: registry.toProviderTools(), executor: new ToolBatchExecutor(registry, { maxOutputBytes: policy.maxOutputBytes, outputStore }) }`.
4. Roots the output store at `<sessionsDir>/<sessionId>/outputs`, validating the session id with the same separators and `..` rules as `JsonlSessionStore.sessionDirectory` before joining, because this path is built outside that store. The output store is inside the session directory and therefore satisfies the existing truncation requirement.

`startServe` creates this factory once and installs it as `tooling`. A server embedded without `tooling` keeps the current explicit "no tool executor is configured" error, which preserves the existing embedded/test behaviour.

Alternatives considered:

- Put the built-in set in `apps/pika`. Rejected: `serve.ts` already composes the store, provider, compaction, and sandbox for `pika serve`; splitting tool composition into the launcher would require duplicating server options across the launcher boundary.
- Share one tool registry across sessions. Rejected: registries bind `PathPolicy` and `cwd`, so sharing would leak one session's workspace into another.

### D3. Startup selects exactly one executor and reports its backend

New `packages/server/src/serve-sandbox.ts` resolves `SandboxBackend | "auto"` into `{ executor, backend }`:

- `none` → `NodeProcessExecutor`, backend `none` (explicit, unisolated).
- `seatbelt` → `SeatbeltExecutor` after `seatbeltAvailable()`; otherwise startup error.
- `bwrap` → `createBwrapExecutor()`; missing binary is a startup error.
- `docker` → `createDockerExecutor()`; missing CLI or daemon is a startup error.
- `auto` → `seatbelt` on `darwin`, `bwrap` on `linux`, otherwise an error listing the auto-selectable backends and the explicit `docker` and `none` overrides.

The resolved backend is passed to `ServerSandboxOptions.backend`, so `EffectiveSandbox.backend` and every `sandbox_decision` already carry the truth. The executor instance is passed to `createServeTooling`.

Rationale: the executor is the enforcement boundary, and the server must not claim isolation it does not have. Failing startup is preferable to silently running with `none` on a host that expected confinement.

Alternatives considered:

- Auto-fallback to `none` with a warning. Rejected: the warning is not reliably visible in local mode (the launcher consumes the child's stdout/stderr), and silent isolation loss is the worst failure mode.
- Auto-select Docker after bubblewrap. Rejected: the default image may lack `bash`, `find`, or `grep`, turning a sandbox choice into surprise tool failures.
- Select the backend per session. Rejected: executor choice is a process capability; changing it mid-process would make session records inconsistent for no benefit.

### D4. Backend configuration is explicit and validated

`parseServeArgs` reads `PIKA_SANDBOX_BACKEND` and `--sandbox-backend`, defaulting to `auto`; invalid values fail with the accepted list. `ServeOptions.sandboxBackend` carries the selection into `startServe`. `serveUsage` and `docs/cli.md` list the values, the auto order, and the meaning of `none`.

The launcher already forwards `PIKA_*`, so TUI users can choose a backend without new launcher flags. Remote deployments select the backend on the server host.

Alternatives considered: a per-session `session.start` backend field. Rejected: this would change the protocol and allow a client to choose an executor the host may not support safely; the existing per-session `sandbox.mode` already covers policy selection.

### D5. Effective policy reaches in-process path checks everywhere

`read_file`, `write_file`, and `edit_file` already pass `context.sandboxPolicy` into `PathPolicy.resolve`. `glob` and `grep` currently resolve only against the policy bound at construction. This change passes `context.sandboxPolicy` in those two tools as well, so a `/sandbox` selection applies to path authorization consistently rather than only to process execution.

This does not widen policy on its own: `session-server` clamps client selections to `maxMode`/`maxNetwork`, and the runtime hands the clamped policy to the executor.

### D6. Approvals and provider streaming stay unchanged

The server's existing `approve` callback is already passed into `createRuntime`, and the runtime already supplies `requestApproval` to the tool executor and `sandbox_decision` events. Wiring tooling therefore activates the existing approval path: an interactive client receives `approval_requested` and can answer `approve`, `approve_for_session`, or `deny`; one-shot mode denies.

No provider changes are needed. Tool declarations use the existing `ProviderTool` shape, and provider tool-call deltas are already normalized into `ToolCall` objects by the runtime.

## Risks / Trade-offs

- [Startup now fails on a Linux host without bubblewrap or Docker] → Document `--sandbox-backend none` for development and pin it in platform-independent tests. The failure message names the supported options.
- [`none` has no OS isolation; `bash` can write outside the workspace] → It is explicit opt-in only. In-process file tools still enforce `PathPolicy`, and environment filtering still applies.
- [Per-session tool instances add small allocation overhead] → Negligible against a model call, and it is the only way to keep workspaces isolated.
- [A resumed session's stored `cwd` may no longer exist] → `PathPolicy` canonicalization and tool errors surface a normal execution error; no new failure mode is introduced.
- [Docker image lacks a required binary] → Docker is explicit-only and the tool result reports the execution error; operators choose the image.
- [Local mode drops `DOCKER_HOST` because the launcher forwards only `PIKA_*` and a fixed allowlist] → Document that a custom Docker daemon endpoint requires running `pika serve` directly; the default socket still works in local mode.
- [`glob` and `grep` depend on host `find`/`grep` being present] → Existing behaviour; the executor reports spawn failures as tool errors.

## Migration Plan

- No protocol, schema, or stored-data migration. Existing sessions resume and gain tools on their next turn.
- `SessionServerOptions.tools` and `.toolExecutor` are replaced by `.tooling`; update the repository's test helpers and server tests in the same change.
- Serve tests pass `sandboxBackend: "none"` (or set `PIKA_SANDBOX_BACKEND=none` for the spawned entry test) so they do not depend on host sandbox binaries.
- Rollback is a code revert; sessions recorded during the change remain readable because the event schema is unchanged.
