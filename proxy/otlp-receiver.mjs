#!/usr/bin/env node
// Minimal OTLP/HTTP receiver for Codex's native OpenTelemetry export.
//
// Codex's [otel] exporter is OTLP-only (protocol = "binary" = HTTP+protobuf) and
// does NOT honor OTEL_EXPORTER_OTLP_* env vars, so we can't use a console exporter
// like we do for Claude Code. This sidecar accepts the OTLP POSTs, persists the raw
// protobuf payloads, and indexes them. `codex exec` exports traces + logs (no metrics
// — upstream gap openai/codex#12913), so expect /v1/traces and /v1/logs.
//
// We don't decode protobuf here (no deps); we store the raw .pb bytes for offline
// decoding and also extract printable strings so tool names / event text / prompts
// are glanceable in the index without a decoder.
//
// Env:
//   OTLP_PORT  listen port              (default 4318, the OTLP/HTTP default)
//   OTLP_OUT   output dir               (default ./telemetry/codex-otel)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = parseInt(process.env.OTLP_PORT || "4318", 10);
const OUT_DIR = process.env.OTLP_OUT || "./telemetry/codex-otel";
fs.mkdirSync(OUT_DIR, { recursive: true });
const index = fs.createWriteStream(path.join(OUT_DIR, "index.jsonl"), { flags: "a" });
let seq = 0;

// Printable-ASCII runs (>= min chars) pulled from protobuf bytes — gives a readable
// peek (event names, tool names, prompt text) without a full proto decoder.
function readableStrings(buf, min = 4) {
  const out = [];
  let cur = "";
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) cur += String.fromCharCode(b);
    else { if (cur.length >= min) out.push(cur); cur = ""; }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    seq += 1;
    const signal = (req.url || "/").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "root";
    const fname = `${String(seq).padStart(4, "0")}_${signal}.pb`;
    if (body.length) fs.writeFileSync(path.join(OUT_DIR, fname), body);
    index.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        seq,
        path: req.url,
        content_type: req.headers["content-type"] || null,
        bytes: body.length,
        file: body.length ? fname : null,
        strings: readableStrings(body).slice(0, 300),
      }) + "\n"
    );
    // OTLP/HTTP success = 200 with an (empty) protobuf Export*ServiceResponse.
    // An empty body is a valid response (all fields optional) → exporter sees success.
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[otlp-receiver] listening on 127.0.0.1:${PORT} -> ${OUT_DIR}`);
});
