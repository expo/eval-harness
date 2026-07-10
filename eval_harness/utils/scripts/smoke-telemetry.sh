#!/usr/bin/env bash
# Phase-1 telemetry smoke test for Claude Code + Codex.
#
# Assumes `claude` and `codex` are already on PATH (the workflow installs them),
# and that ANTHROPIC_API_KEY / OPENAI_API_KEY are exported (from EAS secrets).
#
# What it does:
#   1. launches a transparent logging proxy per provider + a Codex OTLP receiver
#   2. points each agent's base_url at its proxy; CC console OTEL + Codex [otel]→OTLP
#   3. runs a ~1-call smoke prompt per agent (no tools, no file writes)
#   4. tears the sidecars down and prints a capture summary
#
# All telemetry lands under $TELEMETRY_DIR for the workflow to upload as an artifact.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TELEMETRY_DIR="${TELEMETRY_DIR:-$ROOT/telemetry}"
mkdir -p "$TELEMETRY_DIR"

# Shared telemetry-sidecar helpers (eval::launch_proxy / eval::wait_for_port /
# eval::launch_otlp_receiver / eval::stop_proxies).
# shellcheck source=eval_harness/utils/shell/eval_stages.sh
source "$ROOT/eval_harness/utils/shell/eval_stages.sh"

# ---- model selection (cheapest tier; override via env) ----
CC_MODEL="${CC_MODEL:-claude-haiku-4-5}"
CODEX_MODEL="${CODEX_MODEL:-gpt-5-mini}"   # CONFIRM this id exists for your OpenAI account

ANTHROPIC_PROXY_PORT="${ANTHROPIC_PROXY_PORT:-8081}"
OPENAI_PROXY_PORT="${OPENAI_PROXY_PORT:-8082}"
OTLP_PORT="${OTLP_PORT:-4318}"   # Codex native OTel (OTLP/HTTP) sink

EVAL_PROXY_PIDS=()
trap 'eval::stop_proxies' EXIT

echo "== launching logging proxies =="
eval::launch_proxy "$ROOT" anthropic https://api.anthropic.com "$ANTHROPIC_PROXY_PORT" "$TELEMETRY_DIR/anthropic.jsonl"
eval::launch_proxy "$ROOT" openai    https://api.openai.com    "$OPENAI_PROXY_PORT"    "$TELEMETRY_DIR/openai.jsonl"
eval::wait_for_port "$ANTHROPIC_PROXY_PORT"
eval::wait_for_port "$OPENAI_PROXY_PORT"

echo "== launching Codex OTLP/HTTP receiver (:$OTLP_PORT) =="
eval::launch_otlp_receiver "$ROOT" "$OTLP_PORT" "$TELEMETRY_DIR/codex-otel"
eval::wait_for_port "$OTLP_PORT"

# =================== secret-value diagnostics (direct, no proxy) ===================
# Both agents 401 with keys that work locally → isolate whether the EAS-injected
# secret VALUE is the problem. Print length + trailing bytes in hex (catches a stray
# \n=0a / \r=0d) and hit each API directly. Known-good: ANTH len=108 tailhex=51414141,
# OAI len=164 tailhex=6e716741.
echo "== secret-value diagnostics =="
echo "ANTH: len=${#ANTHROPIC_API_KEY} head=${ANTHROPIC_API_KEY:0:8} tailhex=$(printf %s "${ANTHROPIC_API_KEY: -4}" | od -An -tx1 | tr -d ' \n')"
echo "OAI:  len=${#OPENAI_API_KEY} head=${OPENAI_API_KEY:0:8} tailhex=$(printf %s "${OPENAI_API_KEY: -4}" | od -An -tx1 | tr -d ' \n')"
ac=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' || echo "curl-fail")
echo "direct anthropic (no proxy): $ac"
oc=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" || echo "curl-fail")
echo "direct openai (no proxy): $oc"

# =================== Claude Code ===================
if command -v claude >/dev/null 2>&1 && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "== Claude Code smoke ($CC_MODEL) =="
  # Console OTEL writes to stdout and would collide with --output-format json,
  # so we drop the json flag and capture stdout+stderr combined. The proxy
  # (anthropic.jsonl) is the source of truth for the model I/O; this file adds
  # CC's native OTEL metrics/events. `timeout` guards against a hung agent.
  (
    export ANTHROPIC_BASE_URL="http://127.0.0.1:$ANTHROPIC_PROXY_PORT"
    export ANTHROPIC_MODEL="$CC_MODEL"
    export CLAUDE_CODE_ENABLE_TELEMETRY=1
    export OTEL_METRICS_EXPORTER=console
    export OTEL_LOGS_EXPORTER=console
    export OTEL_METRIC_EXPORT_INTERVAL=2000
    export OTEL_LOGS_EXPORT_INTERVAL=2000
    # Tool-invoking prompt so we exercise tool-use telemetry; skip-permissions so
    # the Write tool runs headlessly without a prompt (ephemeral throwaway worker).
    timeout 120 claude -p "Create a file named hello.txt containing exactly: TELEMETRY_OK" \
      --model "$CC_MODEL" --dangerously-skip-permissions
  ) > "$TELEMETRY_DIR/claude-console.log" 2>&1
  echo "   exit=$? (combined stdout+stderr incl. console OTEL -> claude-console.log)"
else
  echo "== Claude Code SKIPPED (claude not on PATH or ANTHROPIC_API_KEY unset) =="
fi

# =================== Codex ===================
if command -v codex >/dev/null 2>&1 && [ -n "${OPENAI_API_KEY:-}" ]; then
  echo "== Codex smoke ($CODEX_MODEL) =="
  export CODEX_HOME="$TELEMETRY_DIR/codex-home"
  mkdir -p "$CODEX_HOME"
  # Custom model_provider (NOT bare openai_base_url): env_key attaches the
  # Authorization: Bearer header (bare base_url override sent no auth → 401), and
  # supports_websockets=false forces plain HTTP POST so our HTTP proxy captures it
  # (the built-in openai provider uses a websocket transport we can't proxy).
  # [otel]: exporter=logs, trace_exporter=traces (signal-specific; both → our OTLP
  # sink), metrics_exporter=none to suppress the default Statsig phone-home.
  cat > "$CODEX_HOME/config.toml" <<EOF
model = "$CODEX_MODEL"
model_provider = "proxy"
approval_policy = "never"
# danger-full-access: disable Codex's own nested sandbox (Landlock/seccomp/bubblewrap),
# which can't initialize inside EAS's already-isolated worker. Safe here because the
# worker is ephemeral + isolated; lets Codex actually execute its shell/file tools.
sandbox_mode = "danger-full-access"

[model_providers.proxy]
name = "OpenAI via local logging proxy"
base_url = "http://127.0.0.1:$OPENAI_PROXY_PORT/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
supports_websockets = false

[otel]
environment = "eas-smoke"
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://127.0.0.1:$OTLP_PORT", protocol = "binary" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:$OTLP_PORT", protocol = "binary" } }
metrics_exporter = "none"
EOF
  timeout 180 codex exec "Create a file named hello.txt containing exactly: TELEMETRY_OK" \
    > "$TELEMETRY_DIR/codex-stdout.txt" 2> "$TELEMETRY_DIR/codex-stderr.log"
  echo "   exit=$? (stdout -> codex-stdout.txt)"
else
  echo "== Codex SKIPPED (codex not on PATH or OPENAI_API_KEY unset) =="
fi

# =================== capture summary ===================
echo "== capture summary =="
for f in anthropic openai; do
  log="$TELEMETRY_DIR/$f.jsonl"
  if [ -s "$log" ]; then
    n=$(wc -l < "$log" | tr -d ' ')
    echo "   $f: $n request(s) captured"
  else
    echo "   $f: NO requests captured (check base_url wiring / agent ran)"
  fi
done
if [ -s "$TELEMETRY_DIR/codex-otel/index.jsonl" ]; then
  n=$(wc -l < "$TELEMETRY_DIR/codex-otel/index.jsonl" | tr -d ' ')
  echo "   codex-otel: $n OTLP export(s) captured (raw .pb in codex-otel/)"
else
  echo "   codex-otel: NO OTLP exports captured (check [otel] config / receiver)"
fi
echo "== telemetry written to $TELEMETRY_DIR =="
ls -la "$TELEMETRY_DIR"

# Dump a capped copy to the job log as a text backstop. The workflow also uploads
# telemetry.tar.gz as a generic EAS artifact. Cap per-file + pace writes so a big
# log can't trip the non-blocking stdout pipe (EAGAIN / "Resource temporarily unavailable").
echo "== full capture dump (stdout backstop; capped per file) =="
CAP=60000
for f in "$TELEMETRY_DIR"/*.jsonl "$TELEMETRY_DIR"/codex-otel/index.jsonl; do
  [ -e "$f" ] || continue
  sz=$(wc -c < "$f" | tr -d ' ')
  echo "----- $f ($sz bytes; showing up to $CAP) -----"
  head -c "$CAP" "$f"; echo
  sleep 0.1
done
for f in claude-console.log codex-stdout.txt codex-stderr.log; do
  [ -s "$TELEMETRY_DIR/$f" ] && { echo "----- $f (first 60 lines) -----"; head -n 60 "$TELEMETRY_DIR/$f"; echo; sleep 0.1; }
done

# Always succeed so cleanup and artifact-upload steps can still run when an agent failed.
exit 0
