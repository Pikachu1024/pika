import type { ExecResult } from "@pika-harness/core";
import type { SandboxPolicy } from "@pika-harness/schema";

const DENIAL_PATTERNS = [
  /operation not permitted/i,
  /permission denied/i,
  /read-only file system/i,
  /could not resolve host/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  /nodename nor servname provided/i,
  /servname not supported/i,
  /network is unreachable/i,
  /no route to host/i,
  /sandbox(?:\.exec)?:.*deny/i,
  /bwrap:.*(?:denied|not permitted)/i,
  /cannot connect to the docker daemon/i,
];

const NETWORK_HINT =
  /resolve host|network|socket|connect|dns|nodename nor servname|servname not supported/i;

/** Detects a backend denial from its stderr so the tool layer can record it. */
export function detectDenial(
  result: ExecResult,
  policy: SandboxPolicy,
): ExecResult["denied"] | undefined {
  if (result.timedOut || result.exitCode === 0) {
    return undefined;
  }
  const text = `${result.stderr}\n${result.stdout}`.trim();
  if (text === "" || !DENIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return undefined;
  }
  if (policy.network === "full" && NETWORK_HINT.test(text) && !/permission denied/i.test(text)) {
    return undefined;
  }
  const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? text;
  return { reason: firstLine.trim().slice(0, 500) };
}
