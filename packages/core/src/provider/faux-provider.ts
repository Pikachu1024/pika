import type { LlmEvent, LlmRequest, ModelInfo, Provider } from "../provider.js";

export type FauxTurnEvents = LlmEvent[] | AsyncIterable<LlmEvent>;

export type FauxTurnFactory = (request: LlmRequest) => FauxTurnEvents | Promise<FauxTurnEvents>;

/** One scripted turn: inline events, an async iterable, or a factory returning either. */
export type FauxTurn = FauxTurnEvents | FauxTurnFactory;

export interface FauxProviderOptions {
  models?: ModelInfo[];
}

const defaultModels: ModelInfo[] = [
  { id: "faux-model", provider: "faux", contextWindow: 128_000, maxOutputTokens: 8_192 },
];

/** Deterministic provider that replays one scripted turn per stream call. */
export class FauxProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  readonly #turns: FauxTurn[];
  readonly #models: ModelInfo[];
  #turnIndex = 0;

  constructor(turns: readonly FauxTurn[] = [], options: FauxProviderOptions = {}) {
    this.#turns = [...turns];
    this.#models = options.models === undefined ? [...defaultModels] : [...options.models];
  }

  models(): ModelInfo[] {
    return [...this.#models];
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<LlmEvent> {
    this.requests.push(copyRequest(request));
    const turn = this.#turns[this.#turnIndex];
    this.#turnIndex += 1;
    if (turn === undefined) {
      return;
    }
    const events = typeof turn === "function" ? await turn(request) : turn;
    for await (const event of iterate(events)) {
      if (signal.aborted) {
        return;
      }
      yield event;
    }
  }
}

function copyRequest(request: LlmRequest): LlmRequest {
  return { ...request, messages: [...request.messages], tools: [...request.tools] };
}

async function* iterate(events: FauxTurnEvents): AsyncIterable<LlmEvent> {
  if (Array.isArray(events)) {
    for (const event of events) {
      yield event;
    }
    return;
  }
  yield* events;
}
