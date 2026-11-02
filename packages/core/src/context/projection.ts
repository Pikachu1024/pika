import type { ContentPart, SessionEntry, ToolCall } from "@pika-harness/schema";
import type { ContextProjector, ProjectionInput, ProjectionResult } from "../context.js";
import type { LlmMessage } from "../provider.js";
import { hashPrompt } from "./hash.js";

interface AssistantDraft {
  text: string;
  toolCalls: ToolCall[];
}

type ProjectedRecord =
  | { kind: "assistant"; draft: AssistantDraft }
  | { kind: "message"; message: LlmMessage };

function selectActiveBranch(entries: SessionEntry[]): SessionEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: SessionEntry | undefined = entries[entries.length - 1];

  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }

  branch.reverse();
  return branch;
}

function cloneToolCall(call: ToolCall): ToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

function cloneContent(parts: ContentPart[]): ContentPart[] {
  return parts.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "image":
        return part.alt === undefined
          ? { type: "image", mediaType: part.mediaType, data: part.data }
          : { type: "image", mediaType: part.mediaType, data: part.data, alt: part.alt };
      case "error":
        return part.code === undefined
          ? { type: "error", message: part.message }
          : { type: "error", message: part.message, code: part.code };
      default:
        return { type: "error", message: "Unsupported content part." };
    }
  });
}

function compactedMessage(summary: string): LlmMessage {
  return { role: "user", content: [{ type: "text", text: `[compacted context]\n${summary}` }] };
}

function assistantMessage(draft: AssistantDraft): LlmMessage {
  const content: ContentPart[] = draft.text.length > 0 ? [{ type: "text", text: draft.text }] : [];
  const toolCalls = draft.toolCalls.map(cloneToolCall);

  if (toolCalls.length === 0) {
    return { role: "assistant", content };
  }
  return { role: "assistant", content, toolCalls };
}

function buildMessages(branch: SessionEntry[]): LlmMessage[] {
  const removedIds = new Set<string>();
  const discardedMessageIds = new Set<string>();
  for (const entry of branch) {
    if (entry.event.type === "message_end") {
      if (entry.event.stopReason === "error" || entry.event.stopReason === "aborted") {
        discardedMessageIds.add(entry.event.messageId);
      }
    }
  }
  const indexById = new Map<string, number>();
  branch.forEach((entry, index) => {
    indexById.set(entry.id, index);
  });
  const summariesByIndex = new Map<number, string[]>();

  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry === undefined) {
      continue;
    }
    const event = entry.event;
    if (event.type !== "compaction_end") {
      continue;
    }

    let anchor: number | undefined;
    for (const replacedId of event.replacedEntryIds) {
      removedIds.add(replacedId);
      const replacedIndex = indexById.get(replacedId);
      if (replacedIndex !== undefined && (anchor === undefined || replacedIndex < anchor)) {
        anchor = replacedIndex;
      }
    }

    // With no resolvable replaced entry, fall back to the compaction event position.
    const insertAt = anchor ?? index;
    const summaries = summariesByIndex.get(insertAt);
    if (summaries === undefined) {
      summariesByIndex.set(insertAt, [event.summary]);
    } else {
      summaries.push(event.summary);
    }
  }

  const records: ProjectedRecord[] = [];
  const drafts = new Map<string, AssistantDraft>();
  const toolNames = new Map<string, string>();

  const draftFor = (messageId: string): AssistantDraft => {
    const existing = drafts.get(messageId);
    if (existing !== undefined) {
      return existing;
    }
    const draft: AssistantDraft = { text: "", toolCalls: [] };
    drafts.set(messageId, draft);
    records.push({ kind: "assistant", draft });
    return draft;
  };

  for (let index = 0; index < branch.length; index += 1) {
    const summaries = summariesByIndex.get(index);
    if (summaries !== undefined) {
      for (const summary of summaries) {
        records.push({ kind: "message", message: compactedMessage(summary) });
      }
    }

    const entry = branch[index];
    if (entry === undefined || removedIds.has(entry.id)) {
      continue;
    }
    const event = entry.event;

    switch (event.type) {
      case "user_message":
        records.push({
          kind: "message",
          message: { role: "user", content: [{ type: "text", text: event.message.text }] },
        });
        break;
      case "message_start":
      case "message_end":
        if (!discardedMessageIds.has(event.messageId)) {
          draftFor(event.messageId);
        }
        break;
      case "message_delta": {
        if (discardedMessageIds.has(event.messageId)) {
          break;
        }
        const draft = draftFor(event.messageId);
        if (event.delta.kind === "text") {
          draft.text += event.delta.text;
        }
        // Reasoning deltas are dropped, and tool call deltas are skipped because
        // tool_call_start carries the complete call.
        break;
      }
      case "tool_call_start":
        if (discardedMessageIds.has(event.messageId)) {
          break;
        }
        toolNames.set(event.call.id, event.call.name);
        draftFor(event.messageId).toolCalls.push(cloneToolCall(event.call));
        break;
      case "tool_execution_end": {
        const toolName = toolNames.get(event.toolCallId);
        records.push({
          kind: "message",
          message: {
            role: "tool",
            toolCallId: event.toolCallId,
            ...(toolName === undefined ? {} : { toolName }),
            content: cloneContent(event.result.content),
          },
        });
        break;
      }
      default:
        break;
    }
  }

  return records.map((record) =>
    record.kind === "assistant" ? assistantMessage(record.draft) : record.message,
  );
}

function repairToolPairs(messages: LlmMessage[]): LlmMessage[] {
  const toolPositions = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.role !== "tool") {
      return;
    }
    const positions = toolPositions.get(message.toolCallId);
    if (positions === undefined) {
      toolPositions.set(message.toolCallId, [index]);
    } else {
      positions.push(index);
    }
  });

  const repaired: LlmMessage[] = [];
  const inserted = new Set<string>();
  messages.forEach((message, index) => {
    repaired.push(message);
    if (message.role !== "assistant" || message.toolCalls === undefined) {
      return;
    }
    for (const call of message.toolCalls) {
      const positions = toolPositions.get(call.id) ?? [];
      const hasFollowingResult = positions.some((position) => position > index);
      if (hasFollowingResult || inserted.has(call.id)) {
        continue;
      }
      inserted.add(call.id);
      repaired.push({
        role: "tool",
        toolCallId: call.id,
        content: [{ type: "error", message: `Missing tool result for tool call "${call.name}".` }],
      });
    }
  });
  return repaired;
}

/** Creates the pure projector from session entries to provider messages. */
export function createContextProjector(): ContextProjector {
  return {
    project(input: ProjectionInput): ProjectionResult {
      const branch = selectActiveBranch(input.entries);
      const messages = repairToolPairs(buildMessages(branch));
      return {
        messages,
        promptHash: hashPrompt({ system: input.system, messages, tools: input.tools }),
      };
    },
  };
}

/** Selects the active branch ending at the latest entry without mutating the log. */
export function activeBranch(entries: SessionEntry[]): SessionEntry[] {
  return selectActiveBranch(entries);
}
