#!/usr/bin/env bash
# Collect + exfil everything from one end-to-end run, correlated by RUN_ID.
#
# Invoked from workflow entrypoint `trap … EXIT`, so it runs even when an earlier
# stage failed (a non-building app or a crashed agent is still worth diagnosing).
#
# Assembles eval-out/$RUN_ID/bundle/ from:
#   app/        the agent-authored workspace (minus node_modules / build dirs)
#   telemetry/  proxy JSONL, OTLP exports, reconstructed agent traces
#   eval/       the evaluator's traces dir + result.json + report.html
#   logs/       per-stage logs
#   manifest.json   the single object that stitches it all by RUN_ID
# then tars it. The workflow uploads eval-out as an EAS generic artifact; GCS is
# still supported as an optional mirror, and stdout remains a small text backstop.
#
# Positional args (from the orchestrator); other knobs come from the env it
# already exported (AGENT, RUN_START_MTIME, GCS_BUCKET, GCP_SA_KEY, CODEX_HOME,
# BRAINTRUST_API_KEY, BRAINTRUST_PROJECT, AGENT_MODEL, METRO_MODE,
# TRACE_PHASE / TRACE_SINCE_MTIME / EVAL_PHASE_START_MTIME).
set -uo pipefail

ROOT="$1"; RUN_ID="$2"; OUT="$3"; WORKSPACE="$4"; EVAL="$5"; TELEMETRY_DIR="$6"
AGENT="${AGENT:-claude-code}"
[ "$AGENT" = "claude" ] && AGENT="claude-code"
RUN_START_MTIME="${RUN_START_MTIME:-0}"
BUNDLE="$OUT/bundle"
PY="$(command -v python3 || command -v python)"

run_trace_py() {
  if command -v uv >/dev/null 2>&1 && [ -f "$EVAL/pyproject.toml" ]; then
    (cd "$EVAL" && uv run python "$@")
  else
    "$PY" "$@"
  fi
}

run_trace_ts() {
  (cd "$EVAL" && bun "$@")
}

echo "================= COLLECT: assembling bundle for run $RUN_ID ================="
mkdir -p "$BUNDLE/app" "$BUNDLE/telemetry/traces" "$BUNDLE/eval/traces" "$BUNDLE/logs"

# --- 1. reconstruct agent/evaluator execution traces from session logs (offline) ---
BT_FLAG=""; [ -n "${BRAINTRUST_API_KEY:-}" ] && BT_FLAG="--braintrust"

# Never let a fresh reconstruction that found 0 sessions clobber an
# already-present trace that has real sessions. This is exactly what happens
# when this script re-runs on the macOS eval_ios worker (where the coding
# agent never ran, so reconstruction always finds nothing there) after
# inheriting a correct trace from the downloaded authored-app artifact --
# without this guard, the second run silently overwrites it with an empty one.
_keep_better_trace() { # tmp_path dest_path
  local tmp="$1" dest="$2"
  if [ ! -f "$tmp" ]; then
    return
  fi
  local tmp_sessions
  tmp_sessions="$("$PY" -c "
import json, sys
try:
    print(json.load(open(sys.argv[1])).get('n_sessions', 0))
except Exception:
    print(0)
" "$tmp" 2>/dev/null)"
  if [ "${tmp_sessions:-0}" != "0" ] || [ ! -s "$dest" ]; then
    mv -f "$tmp" "$dest"
  else
    echo "  ℹ️  skipping trace overwrite: new reconstruction found 0 sessions, keeping existing $dest"
    rm -f "$tmp"
  fi
}

collect_author_trace() {
  local before_args=""
  if [ -n "${EVAL_PHASE_START_MTIME:-}" ]; then
    before_args="--before-mtime $EVAL_PHASE_START_MTIME"
  fi
  if [ "$AGENT" = "codex" ]; then
    local dest="$BUNDLE/telemetry/traces/codex-authoring.json" tmp="$BUNDLE/telemetry/traces/codex-authoring.json.tmp"
    run_trace_ts "$ROOT/eval_harness/utils/telemetry/tracing/codex_rollout.ts" \
      --sessions-dir "${CODEX_HOME:-$HOME/.codex}/sessions" \
      --out "$tmp" \
      --since-mtime "$RUN_START_MTIME" $before_args \
      --run-id "$RUN_ID" --source "codex-authoring" \
      --session-name "Codex Authoring Session" $BT_FLAG \
      >"$OUT/collect-author-trace.log" 2>&1 || echo "  ⚠️  codex author trace reconstruction failed (see collect-author-trace.log)"
    _keep_better_trace "$tmp" "$dest"
  elif [ "$AGENT" = "muse-code" ]; then
    local dest="$BUNDLE/telemetry/traces/muse-code-authoring.json" tmp="$BUNDLE/telemetry/traces/muse-code-authoring.json.tmp"
    run_trace_ts "$ROOT/eval_harness/utils/telemetry/tracing/muse_session.ts" \
      --data-root "${MUSE_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}}" \
      --out "$tmp" \
      --since-mtime "$RUN_START_MTIME" $before_args \
      --run-id "$RUN_ID" --source "muse-code-authoring" \
      --session-name "Muse Code Authoring Session" $BT_FLAG \
      >"$OUT/collect-author-trace.log" 2>&1 || echo "  ⚠️  Muse author trace reconstruction failed (see collect-author-trace.log)"
    _keep_better_trace "$tmp" "$dest"
  else
    local dest="$BUNDLE/telemetry/traces/claude-code-authoring.json" tmp="$BUNDLE/telemetry/traces/claude-code-authoring.json.tmp"
    run_trace_ts "$ROOT/eval_harness/utils/telemetry/tracing/cc_transcript.ts" \
      --projects-dir "$HOME/.claude/projects" \
      --out "$tmp" \
      --since-mtime "$RUN_START_MTIME" $before_args \
      --run-id "$RUN_ID" --source "claude-code-authoring" \
      --session-name "Claude Code Authoring Session" $BT_FLAG \
      >"$OUT/collect-author-trace.log" 2>&1 || echo "  ⚠️  claude author trace reconstruction failed (see collect-author-trace.log)"
    _keep_better_trace "$tmp" "$dest"
  fi
}

collect_evaluator_trace() {
  local since="${TRACE_SINCE_MTIME:-${EVAL_PHASE_START_MTIME:-$RUN_START_MTIME}}"
  run_trace_ts "$ROOT/eval_harness/utils/telemetry/tracing/cc_transcript.ts" \
    --projects-dir "$HOME/.claude/projects" \
    --out "$BUNDLE/telemetry/traces/agentic-evaluator.json" \
    --since-mtime "$since" \
    --run-id "$RUN_ID" --source "agentic-evaluator" \
    --session-name "Agentic Evaluator Session" $BT_FLAG \
    >"$OUT/collect-evaluator-trace.log" 2>&1 || echo "  ⚠️  evaluator trace reconstruction failed (see collect-evaluator-trace.log)"
}

case "${TRACE_PHASE:-author}" in
  evaluate)
    collect_evaluator_trace
    ;;
  both)
    collect_author_trace
    collect_evaluator_trace
    ;;
  *)
    collect_author_trace
    if [ -n "${EVAL_PHASE_START_MTIME:-}" ]; then
      collect_evaluator_trace
    fi
    ;;
esac

# --- 2. built app tree (exclude heavy/derived dirs) ---
if [ -d "$WORKSPACE" ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude node_modules --exclude .expo --exclude .git \
      --exclude ios/build --exclude android/.gradle --exclude android/build \
      --exclude .mcp.json \
      "$WORKSPACE/" "$BUNDLE/app/" 2>/dev/null
  else
    cp -R "$WORKSPACE/." "$BUNDLE/app/" 2>/dev/null
    rm -rf "$BUNDLE/app/node_modules" "$BUNDLE/app/.expo" "$BUNDLE/app/.git" \
           "$BUNDLE/app/ios/build" "$BUNDLE/app/android/.gradle" "$BUNDLE/app/.mcp.json" 2>/dev/null
  fi
fi

# --- 3. telemetry: proxy I/O + OTLP exports ---
[ -f "$TELEMETRY_DIR/anthropic.jsonl" ] && cp "$TELEMETRY_DIR/anthropic.jsonl" "$BUNDLE/telemetry/" 2>/dev/null
[ -f "$TELEMETRY_DIR/openai.jsonl" ] && cp "$TELEMETRY_DIR/openai.jsonl" "$BUNDLE/telemetry/" 2>/dev/null
[ -f "$TELEMETRY_DIR/meta.jsonl" ] && cp "$TELEMETRY_DIR/meta.jsonl" "$BUNDLE/telemetry/" 2>/dev/null
[ -d "$TELEMETRY_DIR/otel" ] && cp -R "$TELEMETRY_DIR/otel" "$BUNDLE/telemetry/otel" 2>/dev/null

# --- 4. evaluator traces (all current-run plans) + result.json ---
find "$EVAL/traces" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | while IFS= read -r trace_dir; do
  [ -n "${TRACE_SINCE_MTIME:-}" ] && [ "$(stat -f %m "$trace_dir" 2>/dev/null || echo 0)" -lt "${TRACE_SINCE_MTIME:-0}" ] && continue
  cp -R "$trace_dir" "$BUNDLE/eval/traces/" 2>/dev/null
done
[ -f "$OUT/result.json" ] && cp "$OUT/result.json" "$BUNDLE/eval/result.json" 2>/dev/null
[ -f "$OUT/result.html" ] && cp "$OUT/result.html" "$BUNDLE/eval/report.html" 2>/dev/null
if [ "${PUSH_EVAL_TRACE_BT:-0}" = "1" ] && [ -n "${BRAINTRUST_API_KEY:-}" ]; then
  find "$BUNDLE/eval/traces" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | while IFS= read -r trace_dir; do
    run_trace_py "$ROOT/eval_harness/utils/telemetry/tracing/eval_trace_bt.py" \
      --trace-dir "$trace_dir" \
      --run-id "$RUN_ID" \
      --project "${BRAINTRUST_EVAL_PROJECT:-${BRAINTRUST_PROJECT:-expo-evals}}" \
      >>"$OUT/collect-eval-bt.log" 2>&1 || echo "  ⚠️  evaluator Braintrust push failed (see collect-eval-bt.log)"
  done
fi

# --- 5. stage logs ---
cp "$OUT"/*.log "$BUNDLE/logs/" 2>/dev/null

# --- 6. manifest.json (stitches everything by run_id; embeds the score) ---
# This script runs on both the Linux author_app worker and the macOS eval_ios
# worker (via each script's own EXIT trap), but most of these fields
# (scenario, expo_mcp_auth_status, prd) are only ever known/set on the Linux
# side. Rather than re-deriving from env vars that are genuinely absent on
# the second run and silently regressing to null/defaults, merge: prefer a
# freshly-set env var, else fall back to whatever the existing manifest.json
# (inherited from the downloaded authored-app artifact) already had.
GIT_SHA="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
RESULT_JSON="$OUT/result.json" RUN_ID="$RUN_ID" AGENT="$AGENT" GIT_SHA="$GIT_SHA" \
PRD="${PRD:-}" TEST_PLAN="${TEST_PLAN:-}" \
AGENT_MODEL="${AGENT_MODEL:-}" MUSE_CLI_VERSION="${MUSE_CLI_VERSION:-}" METRO_MODE="${METRO_MODE:-}" \
EVAL_APP_BUNDLE_ID="${EVAL_APP_BUNDLE_ID:-}" EXPO_MCP_AUTH_STATUS="${EXPO_MCP_AUTH_STATUS:-}" \
SCENARIO="${SCENARIO:-}" PROMPT_VARIANT="${PROMPT_VARIANT:-}" PROMPT_FILE="${PROMPT_FILE:-}" \
"$PY" - "$BUNDLE/manifest.json" <<'PYEOF'
import json, os, sys
out = sys.argv[1]

existing = {}
if os.path.exists(out):
    try:
        existing = json.load(open(out)) or {}
    except Exception:
        existing = {}

def preferred(env_key, manifest_key, default=None):
    fresh = os.environ.get(env_key) or None
    if fresh is not None:
        return fresh
    return existing.get(manifest_key, default)

score = full = macro = micro = None
rj = os.environ.get("RESULT_JSON", "")
if rj and os.path.exists(rj):
    try:
        d = json.load(open(rj))
        score, full = d.get("score"), d.get("full_points")
        macro, micro = d.get("macro_avg_pct"), d.get("micro_pct")
    except Exception:
        pass
if score is None:
    score = existing.get("score")
    full = existing.get("full_points")
    macro = existing.get("macro_avg_pct")
    micro = existing.get("micro_pct")

manifest = {
    "run_id": os.environ.get("RUN_ID"),
    "git_sha": os.environ.get("GIT_SHA"),
    "agent": os.environ.get("AGENT"),
    "agent_model": preferred("AGENT_MODEL", "agent_model"),
    "muse_cli_version": preferred("MUSE_CLI_VERSION", "muse_cli_version"),
    "metro_mode": preferred("METRO_MODE", "metro_mode", "dev-build"),
    "eval_app_bundle_id": preferred("EVAL_APP_BUNDLE_ID", "eval_app_bundle_id"),
    "test_plan": preferred("TEST_PLAN", "test_plan") or "auto-resolved from dataset/prd_test_plans.json",
    "prd": preferred("PRD", "prd", "dataset/prds/hot_chocolate/prd/mvp.txt"),
    "expo_mcp_auth_status": preferred("EXPO_MCP_AUTH_STATUS", "expo_mcp_auth_status", "not_attempted"),
    "scenario": preferred("SCENARIO", "scenario"),
    "prompt_variant": preferred("PROMPT_VARIANT", "prompt_variant", "baseline"),
    "prompt_file": preferred("PROMPT_FILE", "prompt_file", "dataset/prompts/baseline.md"),
    "score": score, "full_points": full,
    "macro_avg_pct": macro, "micro_pct": micro,
    "artifacts": {
        "app": "app/",
        "proxy_anthropic": "telemetry/anthropic.jsonl",
        "proxy_openai": "telemetry/openai.jsonl",
        "proxy_meta": "telemetry/meta.jsonl",
        "otel": "telemetry/otel/",
        "agent_traces": "telemetry/traces/",
        "eval_traces": "eval/traces/",
        "result": "eval/result.json",
        "report": "eval/report.html",
        "logs": "logs/",
    },
}
json.dump(manifest, open(out, "w"), indent=2)
print(json.dumps(manifest, indent=2))
PYEOF

# --- 7. package ---
TGZ="$OUT/$RUN_ID.tgz"
tar czf "$TGZ" -C "$BUNDLE" . 2>/dev/null
echo "  bundle: $TGZ ($(wc -c < "$TGZ" | tr -d ' ') bytes)"

# --- 8. optional GCS mirror (best-effort) ---
if [ -n "${GCS_BUCKET:-}" ]; then
  echo "== GCS exfil → gs://$GCS_BUCKET/$RUN_ID.tgz =="
  SA_FILE=""
  if [ -n "${GCP_SA_KEY:-}" ]; then
    SA_FILE="$OUT/.gcp-sa.json"; printf '%s' "$GCP_SA_KEY" > "$SA_FILE"
    export GOOGLE_APPLICATION_CREDENTIALS="$SA_FILE"
  fi
  pushed=1
  if command -v gcloud >/dev/null 2>&1; then
    [ -n "$SA_FILE" ] && gcloud auth activate-service-account --key-file="$SA_FILE" >/dev/null 2>&1
    gcloud storage cp "$TGZ" "gs://$GCS_BUCKET/$RUN_ID.tgz" >"$OUT/collect-gcs.log" 2>&1 && pushed=0
  elif command -v gsutil >/dev/null 2>&1; then
    gsutil cp "$TGZ" "gs://$GCS_BUCKET/$RUN_ID.tgz" >"$OUT/collect-gcs.log" 2>&1 && pushed=0
  else
    echo "  ⚠️  neither gcloud nor gsutil on PATH; skipping upload (backstop dump below)"
  fi
  [ -n "$SA_FILE" ] && rm -f "$SA_FILE"
  if [ "$pushed" = 0 ]; then echo "  ✅ uploaded gs://$GCS_BUCKET/$RUN_ID.tgz";
  else echo "  ❌ GCS upload failed (see collect-gcs.log); relying on stdout backstop"; fi
else
  echo "== GCS exfil skipped (GCS_BUCKET unset) =="
fi

# --- 9. stdout backstop: the small text artifacts, capped + paced (EAGAIN guard) ---
echo "== capture backstop (manifest + result + trace indexes + key logs; capped) =="
CAP=40000
for f in "$BUNDLE/manifest.json" "$BUNDLE/eval/result.json" \
         "$BUNDLE/telemetry/traces/claude-code-authoring.json" "$BUNDLE/telemetry/traces/codex-authoring.json" \
         "$BUNDLE/telemetry/traces/muse-code-authoring.json" \
         "$BUNDLE/telemetry/traces/agentic-evaluator.json" \
         "$BUNDLE/telemetry/otel/index.jsonl" \
         "$BUNDLE/logs/c-agent.log" "$BUNDLE/logs/c-plugin.log" \
         "$BUNDLE/logs/s6-devbuild.log" "$BUNDLE/logs/s7-eval.log"; do
  [ -e "$f" ] || continue
  sz=$(wc -c < "$f" | tr -d ' ')
  echo "----- $f ($sz bytes; up to $CAP) -----"
  head -c "$CAP" "$f"; echo
  sleep 0.1
done
exit 0
