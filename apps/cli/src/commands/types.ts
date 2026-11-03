import type { SelectItem } from "@mariozechner/pi-tui";
import type { NetworkPolicy, SandboxMode } from "@pika-harness/schema";
import type { CatalogState } from "../catalog.js";

export interface HandoffOptions {
  alias: string;
  cwd?: string;
  mode?: SandboxMode;
  network?: NetworkPolicy;
}

export interface SandboxOptions {
  mode?: SandboxMode;
  network?: NetworkPolicy;
}

export interface ConnectOptions {
  provider: string;
  alias: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  tools: boolean;
}

/** Operations the slash-command handlers use; implemented by the session controller. */
export interface CommandContext {
  readonly catalog: CatalogState;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly busy: boolean;
  print(text: string): void;
  quit(): void;
  select(title: string, items: SelectItem[]): Promise<string | undefined>;
  promptText(title: string): Promise<string | undefined>;
  promptSecret(title: string): Promise<string | undefined>;
  connect(options: ConnectOptions): Promise<void>;
  showModels(): void;
  showConfig(): void;
  showStatus(): void;
  showUsage(): Promise<void>;
  showContext(): void;
  startNewSession(): Promise<void>;
  showSessions(): Promise<void>;
  resumeSession(sessionId?: string): Promise<void>;
  forkSession(entryId?: string): Promise<void>;
  switchModel(alias?: string): Promise<void>;
  handoff(options: HandoffOptions): Promise<void>;
  setSandbox(options: SandboxOptions): Promise<void>;
  compact(): Promise<void>;
  askSideQuestion(question: string): Promise<void>;
  respondApproval(decision: "approve" | "approve_for_session" | "deny"): Promise<void>;
  sessionIds(): string[];
}
