import type { ContentPart } from "@pika-harness/schema";
import type { TokenEstimator } from "../context.js";
import type { LlmMessage } from "../provider.js";

const defaultCharsPerToken = 4;

function estimateByCharacters(text: string): number {
  return Math.ceil(text.length / defaultCharsPerToken);
}

function estimateContent(parts: ContentPart[], estimator: TokenEstimator): number {
  let total = 0;
  for (const part of parts) {
    if (part.type === "text") {
      total += estimator.estimate(part.text);
    } else if (part.type === "error") {
      total += estimator.estimate(part.message);
    }
    // Images are not charged by the character heuristic; adapters price them per provider.
  }
  return total;
}

/** Creates a token estimator that defaults to a four-characters-per-token heuristic. */
export function createTokenEstimator(
  estimate: (text: string) => number = estimateByCharacters,
): TokenEstimator {
  return { estimate };
}

/** Estimates the total tokens of provider messages, including tool call payloads. */
export function estimateMessages(
  messages: LlmMessage[],
  estimator: TokenEstimator = createTokenEstimator(),
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateContent(message.content, estimator);
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        total += estimator.estimate(call.name) + estimator.estimate(call.arguments);
      }
    }
  }
  return total;
}
