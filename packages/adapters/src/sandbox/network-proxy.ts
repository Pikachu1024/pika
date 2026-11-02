import http from "node:http";
import net from "node:net";
import type { NetworkProxy, NetworkProxyRecord } from "@pika-harness/core";

export interface NetworkProxyOptions {
  /** Exact hosts or wildcard suffixes such as `*.example.com`. */
  allowlist: readonly string[];
  host?: string;
  /** 0 selects an ephemeral port. */
  port?: number;
  now?: () => Date;
}

function normalizeAllowlist(entries: readonly string[]): string[] {
  return entries.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
}

/** Returns true when the host matches an exact or `*.suffix` allowlist entry. */
export function isHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const candidate = host.toLowerCase();
  return normalizeAllowlist(allowlist).some((entry) => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return candidate.endsWith(suffix) && candidate.length > suffix.length;
    }
    return candidate === entry;
  });
}

function parseAuthority(authority: string): { host: string; port: number } {
  const trimmed = authority.trim();
  const match = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (match !== null) {
    return { host: match[1] ?? "", port: Number(match[2]) };
  }
  const separator = trimmed.lastIndexOf(":");
  if (separator > 0) {
    return {
      host: trimmed.slice(0, separator),
      port: Number(trimmed.slice(separator + 1)),
    };
  }
  return { host: trimmed, port: 80 };
}

/** Starts a local CONNECT/HTTP proxy that records every outbound destination. */
export async function startNetworkProxy(options: NetworkProxyOptions): Promise<NetworkProxy> {
  const allowlist = normalizeAllowlist(options.allowlist);
  const now = options.now ?? (() => new Date());
  const records: NetworkProxyRecord[] = [];
  const record = (host: string, port: number, allowed: boolean, reason: string): void => {
    records.push({ host, port, allowed, reason, timestamp: now().toISOString() });
  };

  const server = http.createServer((request, response) => {
    const target = request.url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      response.writeHead(400).end("proxy requires an absolute URL");
      return;
    }
    const allowed = isHostAllowed(parsed.hostname, allowlist);
    record(parsed.hostname, Number(parsed.port || 80), allowed, allowed ? "allowlisted" : "denied");
    if (!allowed) {
      response.writeHead(403).end("destination denied by proxy allowlist");
      return;
    }
    const upstream = http.request(
      {
        host: parsed.hostname,
        port: parsed.port === "" ? 80 : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => response.writeHead(502).end("upstream failed"));
    request.pipe(upstream);
  });

  server.on("connect", (request, clientSocket, head) => {
    const { host, port } = parseAuthority(request.url ?? "");
    const allowed = isHostAllowed(host, allowlist);
    record(host, port, allowed, allowed ? "allowlisted" : "denied");
    if (!allowed) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    records: () => records.map((entry) => ({ ...entry })),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
