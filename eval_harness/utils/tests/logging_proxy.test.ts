import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const PROXY = resolve(ROOT, "eval_harness/utils/telemetry/proxy/logging-proxy.mjs");
const processes: ReturnType<typeof Bun.spawn>[] = [];
const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const process of processes.splice(0)) process.kill();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port));
  });
}

function freePort(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to reserve a proxy port");
  return port;
}

async function waitForProxy(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error("logging proxy did not start");
}

test("[REGRESSION] preserves an upstream /v1 prefix and redacts credentials", async () => {
  const upstreamPaths: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamPaths.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  servers.push(upstream);
  const upstreamPort = await listen(upstream);

  const directory = await mkdtemp(join(tmpdir(), "logging-proxy-test-"));
  directories.push(directory);
  const proxyPort = freePort();
  const logFile = join(directory, "meta.jsonl");
  const proxy = Bun.spawn(["node", PROXY], {
    env: {
      ...process.env,
      PROXY_PORT: String(proxyPort),
      PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}/v1`,
      PROXY_LABEL: "meta",
      PROXY_LOG: logFile,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  processes.push(proxy);
  await waitForProxy(proxyPort);

  const secret = "meta-secret-that-must-not-be-logged";
  for (const route of ["/muse-code/models", "/responses"]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}${route}`, {
      headers: { Authorization: `Bearer ${secret}`, "x-api-key": secret },
    });
    expect(response.status).toBe(200);
  }

  expect(upstreamPaths).toEqual(["/v1/health", "/v1/muse-code/models", "/v1/responses"]);
  const records = (await readFile(logFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(records.at(-1).request_headers.authorization).toBe("<redacted>");
  expect(records.at(-1).request_headers["x-api-key"]).toBe("<redacted>");
  expect(await readFile(logFile, "utf8")).not.toContain(secret);
});
