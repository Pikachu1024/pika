import path from "node:path";
import { FileToolOutputStore } from "@pika-harness/adapters";
import type { Executor } from "@pika-harness/core";
import {
  createBashTool,
  createEditFileTool,
  createGlobTool,
  createGrepTool,
  createPathPolicy,
  createReadFileTool,
  createWriteFileTool,
  ToolBatchExecutor,
  ToolRegistry,
} from "@pika-harness/core";
import type { SessionToolingFactory } from "./session-server.js";

export interface ServeToolingOptions {
  /** Session store root; oversized output is written under `<sessionsDir>/<sessionId>/outputs`. */
  sessionsDir: string;
  /** Executor chosen once at startup for every shell-based tool call. */
  executor: Executor;
}

/** Builds the built-in file and shell tools bound to each session's workspace. */
export function createServeTooling(options: ServeToolingOptions): SessionToolingFactory {
  return (context, policy) => {
    const outputDirectory = sessionOutputDirectory(options.sessionsDir, context.sessionId);
    if (context.llm?.tools === false) {
      return {
        tools: [],
        executor: new ToolBatchExecutor(new ToolRegistry(), {
          maxOutputBytes: policy.maxOutputBytes,
          outputStore: new FileToolOutputStore(outputDirectory),
        }),
      };
    }
    const pathPolicy = createPathPolicy({
      workspaceRoot: policy.workspaceRoot,
      policy,
    });
    const registry = new ToolRegistry();
    registry.register(createReadFileTool({ pathPolicy }));
    registry.register(createWriteFileTool({ pathPolicy }));
    registry.register(createEditFileTool({ pathPolicy }));
    registry.register(
      createGlobTool({
        executor: options.executor,
        pathPolicy,
        policy,
        cwd: policy.workspaceRoot,
      }),
    );
    registry.register(
      createGrepTool({
        executor: options.executor,
        pathPolicy,
        policy,
        cwd: policy.workspaceRoot,
      }),
    );
    registry.register(
      createBashTool({
        executor: options.executor,
        policy,
        cwd: policy.workspaceRoot,
      }),
    );
    return {
      tools: registry.toProviderTools(),
      executor: new ToolBatchExecutor(registry, {
        maxOutputBytes: policy.maxOutputBytes,
        outputStore: new FileToolOutputStore(outputDirectory),
      }),
    };
  };
}

// Session ids become directory names, so reject anything that could leave the
// sessions root before the output directory is ever constructed.
function sessionOutputDirectory(sessionsDir: string, sessionId: string): string {
  if (
    sessionId === "" ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    throw new Error(`Invalid session id for a directory name: ${sessionId}`);
  }
  return path.join(path.resolve(sessionsDir), sessionId, "outputs");
}
