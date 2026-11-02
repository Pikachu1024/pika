import { describe, expect, it } from "bun:test";
import type { ApprovalDecision, SessionMeta } from "@pika-harness/schema";
import { z } from "zod";
import type { RuntimeOptions } from "../../src/agent.js";
import { createIdGenerator } from "../../src/clock.js";
import { createEventCollector } from "../../src/events.js";
import { FauxProvider } from "../../src/provider/faux-provider.js";
import type { LlmEvent } from "../../src/provider.js";
import { createRuntime } from "../../src/runtime/runtime.js";
import { resolveSandboxPolicy } from "../../src/sandbox/policy.js";
import { MemorySessionStore } from "../../src/session/memory-store.js";
import { foldTimeline } from "../../src/session/replay.js";
import { ToolBatchExecutor } from "../../src/tool/executor.js";
import { ToolRegistry } from "../../src/tool/registry.js";
import type { Tool } from "../../src/tools.js";

const fixedDate = new Date("2026-01-01T00:00:00.000Z");
const clock = { now: () => new Date(fixedDate) };

function meta(id: string): SessionMeta {
  return { id, cwd: "/work", model: "faux-model", createdAt: fixedDate.toISOString() };
}

const toolTurn: LlmEvent[] = [
  { type: "tool_call_delta", index: 0, id: "call_1", name: "probe" },
  { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
  { type: "done", stopReason: "tool_use" },
];

const finalTurn: LlmEvent[] = [
  { type: "text_delta", text: "done" },
  { type: "done", stopReason: "end" },
];

function probeTool(executions: string[]): Tool {
  return {
    name: "probe",
    description: "records execution",
    schema: z.object({}),
    sandbox: { write: true, arbitraryProcess: false },
    async execute() {
      executions.push("ran");
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
}

function harness(
  turns: LlmEvent[][],
  executions: string[],
  overrides: Partial<RuntimeOptions> = {},
) {
  const registry = new ToolRegistry();
  registry.register(probeTool(executions));
  const sandbox = resolveSandboxPolicy({
    mode: "read-only",
    workspaceRoot: "/work",
    deniedReads: [],
  });
  const sink = createEventCollector();
  const runtime = createRuntime({
    sessionId: "session_sandbox",
    model: "faux-model",
    provider: new FauxProvider(turns),
    clock,
    ids: createIdGenerator(),
    eventSink: sink,
    toolExecutor: new ToolBatchExecutor(registry),
    sandbox: { backend: "seatbelt", policy: sandbox },
    ...overrides,
  });
  return { runtime, sink };
}

describe("sandbox decisions", () => {
  it("records a denial and replays it unchanged", async () => {
    const executions: string[] = [];
    const store = new MemorySessionStore({ ids: createIdGenerator() });
    await store.create(meta("session_sandbox"));
    const { runtime, sink } = harness([toolTurn, finalTurn], executions, { sessionStore: store });

    await runtime.prompt("write");
    await runtime.settled();

    const decisions = sink.events.filter((event) => event.type === "sandbox_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toMatchObject({
      toolCallId: "call_1",
      backend: "seatbelt",
      mode: "read-only",
      outcome: "deny",
    });
    expect(decisions[0]?.decision.reason).toContain("read-only");
    expect(executions).toEqual([]);

    const ends = sink.events.filter((event) => event.type === "tool_execution_end");
    expect(ends[0]?.result.content[0]).toMatchObject({ type: "error", code: "sandbox_denied" });

    const replay = foldTimeline(await store.entries("session_sandbox"));
    const replayed = replay.flatMap((turn) =>
      turn.events.filter((event) => event.type === "sandbox_decision"),
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.decision).toEqual(decisions[0]?.decision);
  });

  it("retries under a widened policy after approve-for-session", async () => {
    const executions: string[] = [];
    const approvals: string[] = [];
    const { runtime, sink } = harness([toolTurn, finalTurn, toolTurn, finalTurn], executions, {
      sandbox: {
        backend: "seatbelt",
        policy: resolveSandboxPolicy({ mode: "read-only", workspaceRoot: "/work" }),
        approve: async (request): Promise<ApprovalDecision> => {
          approvals.push(request.reason);
          return "approve_for_session";
        },
      },
    });

    await runtime.prompt("write");
    await runtime.settled();
    await runtime.prompt("write again");
    await runtime.settled();

    expect(approvals).toHaveLength(1);
    expect(executions).toEqual(["ran", "ran"]);

    const decisions = sink.events
      .filter((event) => event.type === "sandbox_decision")
      .map((event) => event.decision);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["deny", "allow", "allow"]);
    expect(decisions[1]).toMatchObject({ mode: "workspace-write", outcome: "allow" });
    expect(decisions[2]).toMatchObject({ mode: "workspace-write", outcome: "allow" });
    expect(decisions[2]?.reason).not.toContain("escalation");

    const approvalEvents = sink.events.filter(
      (event) => event.type === "approval_requested" || event.type === "approval_resolved",
    );
    expect(approvalEvents.map((event) => event.type)).toEqual([
      "approval_requested",
      "approval_resolved",
    ]);
  });

  it("keeps the original policy after a declined escalation and asks again", async () => {
    const executions: string[] = [];
    let prompts = 0;
    const { runtime, sink } = harness([toolTurn, finalTurn, toolTurn, finalTurn], executions, {
      sandbox: {
        backend: "seatbelt",
        policy: resolveSandboxPolicy({ mode: "read-only", workspaceRoot: "/work" }),
        approve: async (): Promise<ApprovalDecision> => {
          prompts += 1;
          return "deny";
        },
      },
    });

    await runtime.prompt("write");
    await runtime.settled();
    await runtime.prompt("write again");
    await runtime.settled();

    expect(prompts).toBe(2);
    expect(executions).toEqual([]);
    const decisions = sink.events.filter((event) => event.type === "sandbox_decision");
    expect(decisions).toHaveLength(2);
    expect(decisions.every((event) => event.decision.outcome === "deny")).toBe(true);
  });

  it("gates writes in untrusted mode without widening the policy", async () => {
    const executions: string[] = [];
    const { runtime, sink } = harness([toolTurn, finalTurn], executions, {
      sandbox: {
        backend: "none",
        policy: resolveSandboxPolicy({ mode: "workspace-write", workspaceRoot: "/work" }),
        approvalMode: "untrusted",
        approve: async (): Promise<ApprovalDecision> => "approve",
      },
    });

    await runtime.prompt("write");
    await runtime.settled();

    expect(executions).toEqual(["ran"]);
    const decisions = sink.events
      .filter((event) => event.type === "sandbox_decision")
      .map((event) => event.decision);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["deny", "allow"]);
    expect(decisions[1]).toMatchObject({ mode: "workspace-write", outcome: "allow" });
  });
});
