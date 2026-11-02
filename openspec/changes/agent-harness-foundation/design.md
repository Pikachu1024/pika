# Design

## Context

See `proposal.md` for motivation. This is a greenfield repository: OpenSpec is initialized, there is no application code, and there are no existing specs. The design therefore establishes the package layout, event model, and storage model that every later change builds on.

Constraints that shape the approach:

- The primary goal is learning harness engineering by building the core, not shipping a product in the shortest time.
- TypeScript on Node 24, CLI first, with a Codex-like multi-client experience later.
- macOS 15 is the primary development platform; Linux support follows, Windows is deferred.
- Reuse existing components (`pi-ai`, `pi-tui`, the official MCP SDK) instead of rebuilding them, but do not fork a product.
- The sandbox must be a real enforcement boundary, not an approval dialog.

## Goals / Non-Goals

**Goals:**

- One event contract shared by the runtime, the protocol, and the session log.
- A one-way dependency direction so CLI, server, and SDK cannot diverge into separate code paths.
- A first-class sandbox subsystem with explicit policy, platform executors, and auditable decisions.
- Deterministic replay: the same log produces the same timeline, projection, and prompt hash.
- A v0/v1 scope that exercises every layer end to end without requiring the full product surface.
- Replaceable providers, tools, sandbox backends, and UI.

**Non-Goals:**

- Plugin marketplace, subagents, browser or computer-use tools, web/desktop clients, remote sandboxes, RAG, or a custom MCP implementation.
- Windows sandbox support.
- Multi-tenant or untrusted-public workloads.
- Perfect isolation at v0. v0 builds the policy and executor seams; real OS isolation arrives in v1.
- Hand-writing adapters for many model providers.

## Decisions

### D1. Architecture and layering

Use a pnpm monorepo with six packages and a strictly one-way dependency direction:

```
apps/cli (pi-tui)      apps/server (daemon)      packages/client (SDK)
        \                    |                    /
         +-------- packages/schema (protocol types + codec) --------+
                              |
                        packages/core
        (runtime, context, prompt, tools, sandbox policy, session)
                              |
                        packages/adapters
        (pi-ai providers, MCP, sandbox backends, JSONL/SQLite)
```

- `schema` depends on nothing but a schema library.
- `core` depends on `schema` and on adapter interfaces, never on CLI, server, or concrete storage.
- `server` composes `core`, storage, and transports.
- `client` and `cli` depend only on `schema` and the protocol, never on `core`.
- `adapters` implement interfaces declared by `core`.

This mirrors two proven arrangements: Codex's `core / app-server-protocol / app-server / transport` split, and OpenCode's rule that `Schema -> Core/Protocol -> Server` with `Client` depending only on Schema and Protocol. It also prevents the most common harness failure mode: a CLI that calls the runtime directly and slowly becomes a second implementation.

Alternatives considered:

- Fork OpenCode, Kimi Code, or DeepSeek Harness. Rejected because their value is in their product surface; forking teaches their architecture rather than harness fundamentals.
- Single package. Rejected because the protocol boundary is the main learning objective and is hard to retrofit.
- Cordis-style "everything is a plugin" DI. Rejected for v0 because the plugin system would dominate the learning time. Three fixed extension seams (tool, provider, context hook) are sufficient.

### D2. Runtime and provider boundary

Write the runtime ourselves and place `pi-ai` behind a thin provider interface. The runtime consumes normalized `LlmEvent` values, never provider wire formats.

```ts
interface Provider {
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent>;
  models(): ModelInfo[];
}

type LlmEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: "usage"; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: "done"; stopReason: "end" | "tool_use" | "max_tokens" | "aborted" }
  | { type: "error"; error: unknown };
```

`pi-ai` is chosen because it covers a broad provider set, OAuth and API keys, usage and cost, cache retention fields, custom providers, and has explicit prompt-cache tests. It is a library, not a framework, so it does not constrain the loop.

Alternatives considered:

- Depend on `pi-agent-core`. Rejected because the runtime is the thing we want to learn. It remains a primary reference.
- Vercel AI SDK. Viable, but provider quirks and cache control are less explicit for this use case.
- Hand-written adapters. Only justified if provider abstraction itself becomes the learning objective.

### D3. Turn loop and event contract

Define the event contract before writing the loop, because it becomes the protocol and the replay log.

```
agent_start
turn_start
message_start / message_delta / message_end
tool_call_start
tool_execution_start / tool_execution_update / tool_execution_end
approval_requested / approval_resolved
sandbox_decision
compaction_start / compaction_end
turn_end
agent_end
error
settled
```

Semantics:

- A **turn** runs from one user input to quiescence and may contain several model calls and tool batches.
- **Steering** injects a user message at the next safe boundary within the current turn.
- **Follow-up** queues a message for a new turn after the current one ends.
- **Interrupt** aborts the current turn, records an aborted tool result if needed, and keeps the session.
- **settled** means all queues are empty, no stream is active, and no tool is running. Clients use it to decide when the session is safe to reuse.

The runtime is a single-writer async loop. External commands enter through a serialized queue; state changes leave only as events. This avoids the race conditions that appear when a TUI, an SDK, and an approval handler mutate state concurrently.

Tool batches are preflighted as a whole, then independent calls run concurrently while conflicting writes are serialized. Results are recorded in the original call order regardless of completion order.

Alternatives considered:

- A simple request/response chat loop. Rejected because steering, interruption, and replay need explicit lifecycle events.
- Event sourcing with an external bus. Deferred; an in-process emitter plus the append-only log is enough for v0.

### D4. Prompt assembly

The system prompt is a structured document, not a concatenated string. It has named sections:

- identity and behavior constraints,
- environment (working directory, OS, shell, date, git branch, model),
- project instructions (`AGENTS.md` from repository root to working directory),
- skill index (name and description only),
- tool guidance (not tool schemas; those travel in the tools field),
- mode (plan, execute, review).

Two Pi-derived details are adopted:

1. Every system message records named sections plus `toolsAdded` and `toolsRemoved`. Replaying a session therefore reconstructs the exact prompt and tool set of that turn, rather than explaining yesterday's session with today's configuration.
2. Templates live in files and render deterministically. Nothing volatile appears above the cache boundary.

Model-specific overrides are supported because Codex demonstrates that the same harness needs different prompts for different models. The default template is used unless a model override exists.

Alternatives considered:

- One large prompt string. Rejected because replay, cache control, and model overrides all become string surgery.
- An external prompt-management service. Unnecessary for a local harness.

### D5. Context projection

Two representations are kept separate:

```
TimelineEvent[]  --(project)-->  LlmMessage[]  --(adapter)-->  provider wire
authoritative, append-only       recomputed per request        provider-specific
```

Projection is a pure function with a fixed pipeline:

1. Select the active branch from the session tree.
2. Apply compaction summaries and drop replaced ranges.
3. Inject runtime reminders (mode, todo state, approval outcomes).
4. Repair tool pairing so every tool call has a result.
5. Downgrade images and attachments according to provider capability.
6. Estimate tokens for budgeting and compaction.

The projection never mutates stored history. Any "injection" is a derived view. A prompt hash is recorded with each request so replay can be compared byte for byte.

References: Pi's `transformContext()` then `convertToLlm()`; Codex's `context_manager/history.rs` separation of parent history, retained context, world state, and prompt projection; Kimi's `context-projector` in `apps/vis`, which makes the projection layer observable.

Alternatives considered:

- Mutating stored messages during compaction. Rejected because replay and audit lose their source of truth.
- Building provider messages inline inside the loop. Rejected because it couples the loop to provider quirks.

### D6. Cache construction

Caching is not a separate subsystem. It is prompt-assembly discipline plus provider adapter details:

| Lever | Implementation |
|---|---|
| Stable prefix | Static sections first, dynamic content last, no timestamps above the cache boundary |
| Explicit markers | Anthropic `cache_control` on system, tools, and history tail; OpenAI `prompt_cache_key` with a stable prefix |
| Session affinity | Keep a session on the same backend where the provider exposes affinity |
| Measurement | Record `usage.cache_read` and `usage.cache_write` per request and surface them in the CLI |

`pi-ai` already implements retention, usage fields, OpenAI prompt-cache affinity, and cache tests. The design uses those capabilities rather than reimplementing them.

The one policy this harness owns: compaction must not poison the cache. One-off summarization requests disable prompt-cache writes, following Pi's compaction behavior, so a series of throwaway summaries does not evict the useful prefix.

Alternatives considered:

- Ignore caching until later. Rejected because prompt ordering decisions are hard to change after the prompt builder stabilizes.
- Build a cache-management service. Rejected as unnecessary complexity; the provider adapter and prompt builder own the behavior.

### D7. Compaction

Compaction is a policy object with four pluggable points: token estimator, trigger, summarizer, and re-injection strategy.

Default policy, adopted from Pi:

- Trigger when `contextTokens > contextWindow - reserveTokens`, with a default reserve of 16384.
- Summarize older turns into one summary message and preserve recent turns verbatim.
- Summarize branches independently when a session is forked.
- On a provider context-overflow error, compact and retry once.
- Record a `compaction` event containing the summary, replaced range, token counts before and after, and the model used.

Compaction is an event in the log, not an in-place rewrite. Projection applies it deterministically. Codex's `compact.rs` phases and strategies are the reference for a more advanced implementation; remote compaction is a non-goal.

Alternatives considered:

- Truncate the oldest messages. Rejected because it loses task state and confuses replay.
- Summarize every turn eagerly. Rejected because it adds cost and latency without need.

### D8. Tool system

A tool is a declarative object plus an executor:

```ts
type Tool = {
  name: string;
  description: string;
  schema: ZodType;
  approval: ApprovalPolicy;
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  render?(result: ToolResult): string;
};
```

The executor owns the hard parts:

- preflight validation and approval resolution for the whole batch,
- parallel execution of independent calls,
- serialization of conflicting write targets,
- result normalization into text, image, and error content,
- truncation with head and tail excerpts plus a persisted full-output reference,
- start, update, and end events per call.

The v0 tool set is deliberately small: `read_file`, `write_file`, `edit_file`, `bash`, `grep`, and `glob`. These cover validation, approval, truncation, parallel execution, abort, and error feedback. Browser, computer-use, worktree, and subagent tools are product features, not harness fundamentals.

References: Pi's `validateToolArguments` and event model; Codex's `tools/context.rs` for tool-call state, source, and truncation policy.

Alternatives considered:

- Implement only MCP tools. Rejected because local file and shell tools are the core learning surface.
- Code-mode tool execution. Interesting, but deferred until the basic tool contract is stable.

### D9. Sandbox

#### D9.1 Separation from approval

Approval and sandbox are independent axes:

```
approval: untrusted | on-failure | on-request | never
sandbox:  read-only | workspace-write | danger-full-access
```

Approval decides whether a command may run. The sandbox bounds what it can touch if it runs. They combine into a permission profile. The client displays and selects the profile; the server enforces it.

This separation matters because approval prompts are social-engineering targets. A repository README can instruct the model to run a "standard build step" that exfiltrates data. A network-denied sandbox is the actual defense; the approval dialog is only a UX checkpoint.

#### D9.2 Threat model

| Threat | Primary defense |
|---|---|
| Model deletes or rewrites files | Path confinement plus approval |
| Prompt injection exfiltrates data | Network denied by default plus secret scrubbing |
| Dependency postinstall runs arbitrary code | Network allowlist or container |
| Malicious MCP server | Separate process under the same policy plus tool exposure filters |
| Malicious plugin or extension | Out-of-process execution plus Node permission model |
| Supply-chain or zero-day | Container, micro-VM, or remote sandbox |

The design follows the "lethal trifecta" rule: private data, untrusted content, and an outbound channel must not all be available at once. The sandbox breaks the outbound leg by default.

#### D9.3 Policy model

```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

type SandboxPolicy = {
  mode: SandboxMode;
  writableRoots: string[];
  deniedReads: string[];
  network: "none" | "proxy" | "full";
  envAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
};
```

The effective policy is resolved from the session mode, each tool's declared requirement, user rules, and project trust. The resolved policy is what gets logged and enforced; the requested policy is not trusted.

#### D9.4 Executor boundary

```ts
interface Executor {
  readonly backend: "none" | "seatbelt" | "bwrap" | "docker";
  exec(req: ExecRequest, policy: SandboxPolicy): Promise<ExecResult>;
  probe(): Promise<SandboxCapabilities>;
}
```

All tool-initiated subprocess execution passes through an executor. Tools never call `child_process.spawn` directly, and a dependency or conformance check enforces this. The executor records its backend and effective policy for each execution.

#### D9.5 Backend selection

| Backend | Platform | Isolation | Dependency | Role |
|---|---|---|---|---|
| Seatbelt (`sandbox-exec`) | macOS | Process-level, medium-high | Built in, deprecated but functional | v1 default on macOS |
| Landlock plus seccomp | Linux 5.13+, network restrictions from 6.7 | Process-level, medium-high | Small launcher | Later Linux option |
| bubblewrap | Linux | Namespace, high | Package install | Linux default and CI |
| Docker or Podman | Cross-platform | Container, high | Container runtime | CI, remote, untrusted |
| gVisor or Firecracker | Linux | Micro-VM or user-space kernel, very high | Infrastructure | Later multi-tenant |
| Apple Containerization | macOS 26+ | One Linux VM per container | System framework | Future local strong isolation |
| Cloud sandbox (E2B, Modal, Daytona) | Hosted | Very high | External service | Productization |
| Node `--permission` | Cross-platform | Harness process only | Node 24 | Plugin isolation |

macOS 15 uses Seatbelt. `sandbox-exec` is deprecated by Apple but remains functional and is still used by Codex; it is hidden behind the executor interface so it can be replaced by Apple Containerization or a container backend later. Linux uses bubblewrap first; Landlock is an option when bubblewrap is unavailable. Docker is the portability and untrusted-workload path, not the default daily driver because of filesystem overhead on macOS.

#### D9.6 Environment and secret isolation

Child environments are constructed, never inherited:

```ts
spawn(program, args, { env: buildEnv(policy), detached: true });
```

- Provider credentials remain in the harness process and are never passed to tool subprocesses.
- Only allowlisted variables such as `PATH`, `HOME`, `LANG`, and `TERM` are forwarded.
- Shell startup files are not sourced: use `bash --noprofile --norc -c` or `zsh -f -c`. This avoids loading tokens or aliases from user rc files and keeps `PATH` explicit.
- Secrets are stored in the OS keychain rather than a plaintext config file that a tool could read.

#### D9.7 Filesystem confinement including in-process tools

OS sandboxing only covers subprocesses. The harness's own `read_file`, `write_file`, and `edit_file` tools run in the Node process and would otherwise bypass Seatbelt entirely. Therefore:

- every in-process file operation passes through a `PathPolicy` that resolves the real path and checks it against writable and readable roots,
- symlinks that resolve outside the workspace are rejected,
- strict mode can route file operations through a sandboxed helper process,
- reads of sensitive locations such as `~/.ssh`, `~/.aws`, `~/.config/gh`, and `.env` are denied by default outside the workspace.

This is the most commonly missed hole in TypeScript harnesses.

#### D9.8 Network policy

Network defaults to `none`. In `proxy` mode, the sandbox permits connections only to a local proxy. The proxy enforces a destination allowlist, records outbound requests, and can inject credentials so tools never hold them. This is the v2 design; v1 uses `none` plus explicit escalation.

Seatbelt can deny network access but cannot enforce per-domain rules by itself, which is why the allowlist lives in the proxy.

#### D9.9 Escalation flow

1. A command is denied by the sandbox.
2. The executor classifies the failure as a sandbox denial and emits a `sandbox_decision` event.
3. The runtime surfaces an escalation approval containing the denied operation and reason.
4. `accept_for_session` widens the effective policy for the session and records an escalation.
5. The session ends and the default policy is restored.

Commands are classified before execution where possible (path rules and a shell parser), with post-hoc denial detection as a fallback. Relying only on `EPERM` detection is fragile across platforms.

#### D9.10 Audit and monotonicity

Every decision is a `sandbox_decision` event with tool call identifier, backend, mode, outcome, and reason. Replay exposes the same decisions. Child tasks and subagents receive a policy no broader than their parent's; an escalation that would exceed the parent policy is rejected or clamped.

#### D9.11 Sandbox conformance suite

Every backend runs the same tests:

- write inside the workspace succeeds,
- write outside the workspace fails,
- reads of `~/.ssh` and `~/.aws` fail,
- network access fails,
- the same operations attempted from a child process still fail,
- a symlink pointing outside the workspace fails,
- `..` traversal fails,
- tool environments contain no credentials,
- timeouts leave no orphan processes,
- oversized output is truncated and persisted,
- MCP server child processes obey the same policy.

This suite is what keeps platform adapters honest.

#### D9.12 Alternatives considered

- No sandbox, containerization advice only (Pi's current stance). Rejected because the goal includes learning enforcement, and advice is not a boundary.
- Approval-only gating. Rejected as a security model; it remains a UX layer.
- Container-only sandbox. Rejected for v0 because it adds image, mount, and user-mapping complexity before the policy model exists. It is the v3 path for untrusted work.
- Running the whole harness as a separate OS user. Rejected as impractical for a developer CLI.

### D10. Skills and MCP

Skills follow the Agent Skills specification: `SKILL.md` with YAML frontmatter, progressive disclosure, and four scopes (builtin, user, project, plugin). Only name and description enter the prompt; the body loads when selected. Following the standard means existing community skills work.

MCP uses the official `@modelcontextprotocol/sdk` with stdio and streamable HTTP, OAuth, namespaced tools (`mcp__server__tool`), exposure filters, and project trust gating. Server lifecycle handling covers crashes, reconnection, timeouts, and tool-list changes.

Alternatives considered:

- Custom skill format. Rejected; interoperability is more valuable than control.
- Custom MCP transport. Rejected; the official SDK is the standard.
- Loading all skill bodies eagerly. Rejected because it consumes the context window before the skill is needed.

### D11. Records, replay, and storage

The append-only log is the source of truth. Derived views are rebuildable.

- **Log**: JSONL with session metadata, messages, tool calls and results, approvals, sandbox decisions, compactions, turn boundaries, and model changes. Entries carry `id` and `parentId`, forming a tree that supports fork and branch summarization.
- **Index**: SQLite for session listing, token and cost totals, and full-text search. It is derived from the log and can be deleted and rebuilt.
- **Raw capture**: provider request and response bodies are stored in a sidecar directory for debugging. Replay does not depend on them.
- **Replay**: fold the log into a timeline, project it, and rebuild the prompt. The prompt hash recorded during the original turn must match. Replay is a pure function of the log and policy.

References: Pi's session format v3 and `SessionManager`; Codex's rollout recorder, thread store, resume, and fork; Kimi's `wire.jsonl` and `state.json` plus the `vis` replay UI.

Alternatives considered:

- SQLite as the source of truth. Rejected because append-only files are easier to inspect, diff, and recover, and replay wants ordered events.
- A linear log without parent links. Rejected because fork and branch summarization would require awkward rewriting.
- Replaying by re-calling the model. Rejected; replay must be deterministic and offline.

### D12. Protocol, SDK, and CLI

- **CLI**: `pi-tui`, which provides differential rendering, synchronized output, main and alternate screens, components, images, and autocomplete. Kimi Code's TUI is derived from `pi-tui`, which validates the choice.
- **Protocol**: JSON-RPC 2.0 style over stdio JSONL, WebSocket, and in-process transports. Methods cover `initialize`, session start/resume/fork/list, turn start/steer/interrupt, approval response, subscribe/unsubscribe, and sandbox mode selection.
- **SDK**: a typed client generated from the schema or hand-written thinly over it, exposing session creation, prompt, steer, interrupt, event subscription, and approval response.
- **ACP**: added later as an adapter for editor integration; it is not the primary protocol.
- **Web/desktop**: deferred until the protocol and replay are stable.

The CLI is a protocol client from day one, even when the transport is in-process. This prevents the CLI from becoming a second runtime.

Alternatives considered:

- REST/HTTP as the primary protocol. Rejected for v0 because bidirectional events and server-initiated approvals fit JSON-RPC better.
- ACP as the primary protocol. Rejected because ACP targets editor integration, not session storage and multi-client replay.
- CLI calling the runtime directly. Rejected for the reason above.

### D13. Engineering baseline

- pnpm workspace, Node 24, TypeScript strict.
- vitest for unit and integration tests.
- A faux provider that returns scripted streams so loop tests are deterministic.
- A package-boundary check in CI that rejects CLI-to-core imports and direct `child_process` use in tools.
- Structured logging with session and tool-call identifiers.

### D14. Milestones

| Milestone | Deliverable | Dimensions exercised |
|---|---|---|
| M0 | One provider, streaming CLI chat, event log skeleton | runtime, turn loop, provider, records |
| M1 | Tool loop with six tools, approval gate, context projection | tools, context, approval |
| M2 | Sectioned prompt, AGENTS.md, skill index, compaction | prompt, cache, compaction, extensions |
| M3 | JSONL tree, resume/fork, deterministic replay test | records, replay, storage |
| M4 | Protocol, server, typed SDK, CLI as protocol client | protocol, SDK, CLI |
| M5 | Sandbox executor on macOS, conformance suite, MCP | sandbox, extensions |
| M6 | Network proxy, container backend, ACP | sandbox, protocol |

The sandbox policy and executor interfaces are introduced in M0/M1 even though the first real backend lands in M5, so that tools are written against the executor boundary from the start.

## Risks / Trade-offs

- **Seatbelt is deprecated** → Keep it behind the executor interface; maintain a Docker fallback; adopt Apple Containerization or bubblewrap on Linux as alternatives.
- **Docker on macOS is slow for large repositories** → Use it for untrusted workloads and CI, not as the default daily driver; evaluate OrbStack.
- **In-process file tools bypass OS sandboxes** → Mandatory `PathPolicy`, symlink resolution, and optional sandboxed file helper; conformance tests cover both paths.
- **Prompt-cache fragility** → Stable-prefix ordering, prompt hash logging, cache usage metrics, and compaction that avoids cache writes for one-off summaries.
- **JSONL growth** → Compaction, SQLite indexing, and a later retention policy; raw payloads are stored separately and can be pruned.
- **Dependency risk in `pi-ai`** → The provider interface isolates it; a Vercel AI SDK or direct adapter can replace it.
- **Scope creep** → Explicit non-goals and milestone gates; product features require a separate change.
- **False sense of security** → Documentation states that approval is UX and that v0 has no OS sandbox; the sandbox is not claimed as complete until the conformance suite passes.
- **Tree-log complexity** → Start with append plus `parentId`; fork and branch summarization arrive in M3.
- **Protocol churn** → Version the protocol and keep schema-generated clients; additive changes only until the first external client ships.

## Migration Plan

This is a greenfield change, so there is no data or API migration. The rollout is milestone-based:

1. Scaffold the workspace and `schema` package.
2. Implement M0 through M4 against a faux provider and an in-memory store.
3. Add the JSONL store and replay test before exposing the protocol.
4. Add the sandbox policy and `NoopExecutor`, then the Seatbelt executor and conformance suite.
5. Add MCP and the network proxy after the local sandbox is stable.

Each milestone is independently revertible because later milestones depend on interfaces introduced earlier, not on uncommitted behavior. The protocol is versioned from its first release; incompatible changes require a new version rather than silent changes.

## Open Questions

- Which provider and model are used for the first end-to-end run? The design assumes one OpenAI-compatible endpoint; `pi-ai` can supply others later.
- Which SQLite binding is used? `better-sqlite3` and libsql are both viable; the index is disposable, so this can be decided at implementation time.
- Is macOS 26 available on the development machine for Apple Containerization experiments, or is Seatbelt plus Docker sufficient for the first year?
- Should the first SDK be generated from the schema or hand-written? Generation is preferred if the schema tooling is stable; otherwise a thin hand-written client is acceptable.
- When should the plugin API be exposed? Not before the protocol and sandbox boundaries are stable.
