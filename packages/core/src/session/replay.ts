import type { AgentEvent, SessionEntry, SessionSummary } from "@pika-harness/schema";
import { activeBranch, createContextProjector } from "../context/projection.js";
import type { ContextProjector } from "../context.js";
import type { LlmMessage, ProviderTool } from "../provider.js";
import type { SessionStore } from "../session-store.js";

export interface TimelineTurn {
  turnId: string;
  turnNumber: number;
  entryIds: string[];
  events: AgentEvent[];
}

export interface PromptCheck {
  entryId: string;
  turnId: string;
  recordedHash: string;
  replayedHash: string;
  matches: boolean;
}

export interface ReplayResult {
  branch: SessionEntry[];
  turns: TimelineTurn[];
  promptChecks: PromptCheck[];
  messages: LlmMessage[];
}

export interface ReplayInput {
  entries: SessionEntry[];
  projector?: ContextProjector;
  fallbackSystem?: string;
  fallbackTools?: ProviderTool[];
}

export interface ResumeState {
  summary: SessionSummary;
  entries: SessionEntry[];
  history: LlmMessage[];
}

/** Folds the active branch into turns in first-occurrence order. */
export function foldTimeline(entries: SessionEntry[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  const byTurn = new Map<string, TimelineTurn>();

  for (const entry of activeBranch(entries)) {
    const event = entry.event;
    if (!("turnId" in event)) {
      continue;
    }
    let turn = byTurn.get(event.turnId);
    if (turn === undefined) {
      turn = {
        turnId: event.turnId,
        turnNumber: event.type === "turn_start" ? event.turnNumber : turns.length + 1,
        entryIds: [],
        events: [],
      };
      byTurn.set(event.turnId, turn);
      turns.push(turn);
    }
    if (event.type === "turn_start") {
      turn.turnNumber = event.turnNumber;
    }
    turn.entryIds.push(entry.id);
    turn.events.push(event);
  }

  return turns;
}

/** Replays every recorded projection from the log and compares the prompt hashes. */
export function replaySession(input: ReplayInput): ReplayResult {
  const projector = input.projector ?? createContextProjector();
  const branch = activeBranch(input.entries);
  const promptChecks: PromptCheck[] = [];
  let lastSystem = input.fallbackSystem ?? "";
  let lastTools = input.fallbackTools ?? [];

  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry === undefined || entry.event.type !== "context_projected") {
      continue;
    }
    const projected = projector.project({
      entries: branch.slice(0, index),
      system: entry.event.system,
      tools: entry.event.tools,
    });
    promptChecks.push({
      entryId: entry.id,
      turnId: entry.event.turnId,
      recordedHash: entry.event.promptHash,
      replayedHash: projected.promptHash,
      matches: projected.promptHash === entry.event.promptHash,
    });
    lastSystem = entry.event.system;
    lastTools = entry.event.tools;
  }

  const messages = projector.project({
    entries: branch,
    system: lastSystem,
    tools: lastTools,
  }).messages;

  return { branch, turns: foldTimeline(branch), promptChecks, messages };
}

/** Loads a settled session and rebuilds the history a resumed runtime should continue from. */
export async function loadResumeState(
  store: SessionStore,
  sessionId: string,
): Promise<ResumeState> {
  const summaries = await store.list();
  const summary = summaries.find((candidate) => candidate.id === sessionId);
  if (summary === undefined) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const entries = await store.entries(sessionId);
  const last = entries.at(-1);
  if (last === undefined || last.event.type !== "settled") {
    throw new Error(`Session ${sessionId} is not at a settled state`);
  }
  return { summary, entries, history: replaySession({ entries }).messages };
}
