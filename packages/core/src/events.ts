import type { AgentEvent } from "@pika-harness/schema";

export interface EventSink {
  emit(event: AgentEvent): void | Promise<void>;
}

export interface EventCollector extends EventSink {
  readonly events: AgentEvent[];
}

/** Collects emitted events in memory for tests and in-process clients. */
export function createEventCollector(): EventCollector {
  const events: AgentEvent[] = [];
  return {
    events,
    emit: (event) => {
      events.push(event);
    },
  };
}
