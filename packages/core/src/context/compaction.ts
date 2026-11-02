import type { CompactionPolicy } from "../context.js";
import type { LlmMessage } from "../provider.js";
import { estimateMessages } from "./token-estimator.js";

export interface CompactionPlanOptions {
  contextWindow: number;
  reserveTokens: number;
  keepRecentTurns: number;
}

export interface CompactionPlan {
  needed: boolean;
  cutIndex: number;
  tokensBefore: number;
}

function findCutIndex(messages: LlmMessage[], keepRecentTurns: number): number {
  if (keepRecentTurns <= 0) {
    return messages.length;
  }

  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    seen += 1;
    if (seen === keepRecentTurns) {
      return index;
    }
  }

  return 0;
}

/** Creates the threshold-based compaction policy. */
export function createCompactionPolicy(): CompactionPolicy {
  return {
    shouldCompact(tokens: number, contextWindow: number, reserveTokens: number): boolean {
      return tokens > contextWindow - reserveTokens;
    },
  };
}

/** Plans the message boundary to compact, keeping recent turns verbatim when needed. */
export function planCompaction(
  messages: LlmMessage[],
  options: CompactionPlanOptions,
): CompactionPlan {
  const tokensBefore = estimateMessages(messages);
  const cutIndex = findCutIndex(messages, options.keepRecentTurns);
  const overThreshold = tokensBefore > options.contextWindow - options.reserveTokens;

  return {
    needed: cutIndex > 0 && overThreshold,
    cutIndex,
    tokensBefore,
  };
}
