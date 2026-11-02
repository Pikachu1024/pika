import type { SessionStore } from "./session-store.js";
import type { Clock, IdGenerator } from "./clock.js";
import type { EventSink } from "./events.js";
import type { Provider, ProviderTool } from "./provider.js";
import type { ToolExecutor } from "./tools.js";

export type AgentState = "idle" | "streaming" | "tool-calling" | "compacting" | "aborted";

export interface RuntimeOptions {
  sessionId: string;
  model: string;
  provider: Provider;
  systemPrompt?: string;
  tools?: ProviderTool[];
  toolExecutor?: ToolExecutor;
  eventSink: EventSink;
  sessionStore?: SessionStore;
  clock?: Clock;
  ids?: IdGenerator;
  maxModelCallsPerTurn?: number;
}

/** Single-writer runtime facade. Callers enqueue commands; state leaves only as events. */
export interface AgentRuntime {
  readonly state: AgentState;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  settled(): Promise<void>;
}
