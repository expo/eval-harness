#!/usr/bin/env node
// Transparent logging passthrough proxy.
//
// Forwards every request to a single fixed upstream (host taken from PROXY_UPSTREAM)
// while appending one JSONL record per request/response pair to PROXY_LOG.
// Streams responses (incl. SSE) straight back to the client so agents never stall.
//
// Env:
//   PROXY_PORT      local listen port            (default 8081)
//   PROXY_UPSTREAM  upstream origin, host only    (default https://api.anthropic.com)
//   PROXY_LABEL     tag written into each record  (default anthropic)
//   PROXY_LOG       JSONL output path             (default ./telemetry/<label>.jsonl)
//
// Zero dependencies — uses only the Node stdlib so it runs on any EAS linux worker
// that already has Node (installed for the agent CLIs).

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const PORT = parseInt(process.env.PROXY_PORT || "8081", 10);
const UPSTREAM = new URL(process.env.PROXY_UPSTREAM || "https://api.anthropic.com");
const LABEL = process.env.PROXY_LABEL || "anthropic";
const LOG_FILE = process.env.PROXY_LOG || `./telemetry/${LABEL}.jsonl`;

// Never persist credentials to the telemetry log.
const REDACT = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "openai-api-key",
  "api-key",
  "x-goog-api-key",
]);

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const log = fs.createWriteStream(LOG_FILE, { flags: "a" });

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT.has(k.toLowerCase()) ? "<redacted>" : v;
  }
  return out;
}

function tryParse(s) {
  if (!s) return s;
  try {
    return JSON.parse(s);
  } catch {
    return s; // SSE stream or non-JSON — keep raw text
  }
}

function upstreamRequestPath(requestUrl) {
  const prefix = UPSTREAM.pathname.replace(/\/+$/, "");
  const suffix = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  return `${prefix}${suffix}` || "/";
}

// Pull token usage out of a response. Handles both non-stream JSON
// (body.usage) and SSE streams (scan each `data:` event for a usage object;
// keep the last one — Anthropic's message_delta and OpenAI's response.completed
// both carry cumulative usage there).
function extractUsage(body) {
  if (body && typeof body === "object" && body.usage) return body.usage;
  if (typeof body !== "string") return null;
  let usage = null;
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      const u = obj.usage || (obj.response && obj.response.usage) || (obj.message && obj.message.usage);
      if (u) usage = u;
    } catch {
      /* partial/non-JSON event line — skip */
    }
  }
  return usage;
}

const server = http.createServer((req, res) => {
  const reqChunks = [];
  req.on("data", (c) => reqChunks.push(c));
  req.on("end", () => {
    const reqBody = Buffer.concat(reqChunks);
    const started = Date.now();

    // Forward headers as-is except: point Host at the upstream, and drop
    // accept-encoding so the upstream returns uncompressed bodies we can log.
    const headers = { ...req.headers, host: UPSTREAM.hostname };
    delete headers["accept-encoding"];

    const client = UPSTREAM.protocol === "http:" ? http : https;
    const upReq = client.request(
      {
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || 443,
        method: req.method,
        // `new URL(req.url, UPSTREAM)` would treat a leading slash as an
        // absolute upstream path and drop UPSTREAM.pathname. Keep a provider
        // prefix such as Meta's /v1 while preserving the existing root-origin
        // behavior for Anthropic and OpenAI.
        path: upstreamRequestPath(req.url || "/"),
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        const respChunks = [];
        upRes.on("data", (d) => {
          respChunks.push(d);
          res.write(d); // tee straight to client (streaming-safe)
        });
        upRes.on("end", () => {
          res.end();
          const respText = Buffer.concat(respChunks).toString("utf8");
          const respBody = tryParse(respText);
          log.write(
            JSON.stringify({
              ts: new Date().toISOString(),
              label: LABEL,
              method: req.method,
              path: req.url,
              status: upRes.statusCode,
              duration_ms: Date.now() - started,
              request_headers: redactHeaders(req.headers),
              request_body: tryParse(reqBody.toString("utf8")),
              response_body: respBody,
              usage: extractUsage(respBody),
              streamed: typeof respBody === "string", // SSE → raw text
            }) + "\n"
          );
        });
      }
    );

    upReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy upstream error: ${err.message}`);
      log.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          label: LABEL,
          method: req.method,
          path: req.url,
          error: err.message,
          request_headers: redactHeaders(req.headers),
          request_body: tryParse(reqBody.toString("utf8")),
        }) + "\n"
      );
    });

    upReq.write(reqBody);
    upReq.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[proxy ${LABEL}] listening on 127.0.0.1:${PORT} -> ${UPSTREAM.origin} (log: ${LOG_FILE})`);
});
