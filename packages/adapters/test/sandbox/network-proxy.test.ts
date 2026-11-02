import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import http from "node:http";
import net from "node:net";
import { isHostAllowed, startNetworkProxy } from "../../src/sandbox/network-proxy.js";

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function connectThroughProxy(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let data = "";
    socket.setTimeout(2_000);
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(data);
    });
    socket.on("error", reject);
  });
}

describe("isHostAllowed", () => {
  const allowlist = ["api.example.com", "*.trusted.dev"];

  it("matches exact hosts and wildcard suffixes", () => {
    expect(isHostAllowed("API.example.com", allowlist)).toBe(true);
    expect(isHostAllowed("a.trusted.dev", allowlist)).toBe(true);
    expect(isHostAllowed("trusted.dev", allowlist)).toBe(false);
  });

  it("rejects unrelated hosts", () => {
    expect(isHostAllowed("example.com", allowlist)).toBe(false);
    expect(isHostAllowed("evil-trusted.dev", allowlist)).toBe(false);
  });
});

describe("startNetworkProxy", () => {
  let target: http.Server;
  let targetPort = 0;
  let proxy: Awaited<ReturnType<typeof startNetworkProxy>>;
  let proxyPort = 0;

  beforeAll(async () => {
    target = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("proxied");
    });
    targetPort = await listen(target);
    proxy = await startNetworkProxy({ allowlist: ["127.0.0.1"] });
    proxyPort = Number(new URL(proxy.url).port);
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it("tunnels an allowlisted destination and records it", async () => {
    const response = await connectThroughProxy(proxyPort, `127.0.0.1:${targetPort}`);
    expect(response).toContain("200 Connection Established");
    expect(proxy.records().at(-1)).toMatchObject({
      host: "127.0.0.1",
      port: targetPort,
      allowed: true,
    });
  });

  it("denies and records a destination outside the allowlist", async () => {
    const response = await connectThroughProxy(proxyPort, "example.com:443");
    expect(response).toContain("403");
    expect(proxy.records().at(-1)).toMatchObject({
      host: "example.com",
      allowed: false,
      reason: "denied",
    });
  });

  it("rejects relative proxy requests", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port: proxyPort, path: "/relative" },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk.toString();
          });
          response.on("end", () => resolve(`${response.statusCode ?? 0} ${data}`));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(body).toContain("400");
  });
});
