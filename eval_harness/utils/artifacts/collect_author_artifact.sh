#!/usr/bin/env bash
# Construct the canonical authored-app directory from one authoring run.
#
# Positional args:
#   repository_root run_id workspace_root metadata_root artifact_root
#
# This helper runs from author-app.sh's EXIT trap. Trace reconstruction is
# best-effort so a failed authoring run still produces useful diagnostics.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <repository_root> <run_id> <workspace_root> <metadata_root> <artifact_root>" >&2
  exit 2
fi

ROOT="$1"
RUN_ID="$2"
WORKSPACE_ROOT="$3"
METADATA_ROOT="$4"
ARTIFACT_ROOT="$5"
AGENT="${AGENT:-claude-code}"
[ "$AGENT" = "claude" ] && AGENT="claude-code"
RUN_START_MTIME="${RUN_START_MTIME:-0}"
PY="$(command -v python3 || command -v python)"

canonical_existing_dir() { (cd "$1" && pwd -P); }
canonical_target() {
  if [ -d "$1" ]; then
    canonical_existing_dir "$1"
  else
    printf '%s/%s\n' "$(canonical_existing_dir "$(dirname "$1")")" "$(basename "$1")"
  fi
}

ROOT="$(canonical_existing_dir "$ROOT")"
WORKSPACE_ROOT="$(canonical_existing_dir "$WORKSPACE_ROOT")"
METADATA_ROOT="$(canonical_existing_dir "$METADATA_ROOT")"
ARTIFACT_ROOT="$(canonical_target "$ARTIFACT_ROOT")"
if [ "$WORKSPACE_ROOT" != "$ROOT/author-agent-workspace" ] \
  || [ "$METADATA_ROOT" != "$ROOT/author-agent-metadata" ] \
  || [ "$ARTIFACT_ROOT" != "$ROOT/authored-app" ]; then
  echo "author artifact paths must be the canonical repository children" >&2
  exit 2
fi

WORKSPACE="$WORKSPACE_ROOT/$RUN_ID"
OUT="$METADATA_ROOT/$RUN_ID"
if [ ! -d "$WORKSPACE" ] || [ ! -d "$OUT" ]; then
  echo "missing author runtime directories for run $RUN_ID" >&2
  exit 2
fi

echo "================= COLLECT: authored-app for run $RUN_ID ================="
rm -rf -- "$OUT/telemetry/traces"
mkdir -p "$OUT/telemetry/traces"

run_trace_ts() {
  (cd "$ROOT" && bun "$@")
}

collect_author_trace() {
  local trace_name trace_script source_name session_name tmp dest
  case "$AGENT" in
    codex)
      trace_name="codex-authoring.json"
      trace_script="$ROOT/eval_harness/utils/telemetry/tracing/codex_rollout.ts"
      source_name="codex-authoring"
      session_name="Codex Authoring Session"
      ;;
    muse-code)
      trace_name="muse-code-authoring.json"
      trace_script="$ROOT/eval_harness/utils/telemetry/tracing/muse_session.ts"
      source_name="muse-code-authoring"
      session_name="Muse Code Authoring Session"
      ;;
    *)
      trace_name="claude-code-authoring.json"
      trace_script="$ROOT/eval_harness/utils/telemetry/tracing/cc_transcript.ts"
      source_name="claude-code-authoring"
      session_name="Claude Code Authoring Session"
      ;;
  esac

  dest="$OUT/telemetry/traces/$trace_name"
  tmp="$dest.tmp"
  if [ "$AGENT" = "codex" ]; then
    set -- "$trace_script" \
      --sessions-dir "${CODEX_SESSIONS_DIR:-${CODEX_HOME:-$HOME/.codex}/sessions}" \
      --out "$tmp" --since-mtime "$RUN_START_MTIME"
  elif [ "$AGENT" = "muse-code" ]; then
    set -- "$trace_script" \
      --data-root "${MUSE_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}}" \
      --out "$tmp" --since-mtime "$RUN_START_MTIME"
  else
    set -- "$trace_script" \
      --projects-dir "${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}" \
      --out "$tmp" --since-mtime "$RUN_START_MTIME"
  fi
  if [ -n "${EVAL_PHASE_START_MTIME:-}" ]; then
    set -- "$@" --before-mtime "$EVAL_PHASE_START_MTIME"
  fi
  set -- "$@" --run-id "$RUN_ID" --source "$source_name" --session-name "$session_name"
  if [ -n "${BRAINTRUST_API_KEY:-}" ]; then
    set -- "$@" --braintrust
  fi

  run_trace_ts "$@" >"$OUT/collect-author-trace.log" 2>&1 \
    || echo "  ⚠️  author trace reconstruction failed (see collect-author-trace.log)"
  if [ -f "$tmp" ]; then
    mv -f "$tmp" "$dest"
  fi
}

collect_author_trace

# Keep the authored source, but remove reproducible build products and
# credential-bearing harness configuration before it becomes transport data.
rm -rf -- \
  "$WORKSPACE/node_modules" "$WORKSPACE/.expo" "$WORKSPACE/.git" \
  "$WORKSPACE/.cache" "$WORKSPACE/.eval-bundle-export-tmp" \
  "$WORKSPACE/.mcp.json" \
  "$WORKSPACE/ios/Pods" "$WORKSPACE/ios/build" "$WORKSPACE/ios/DerivedData" \
  "$WORKSPACE/android/.gradle" "$WORKSPACE/android/build" "$WORKSPACE/android/app/build" \
  "$OUT/codex-home" "$OUT/muse-xdg-data" "$OUT/muse-data" \
  "$OUT/muse-bin" "$OUT/muse-settings" "$OUT/muse-xdg-config" \
  "$OUT/bundle" \
  2>/dev/null
rm -f -- "$OUT/$RUN_ID.tgz" 2>/dev/null
rm -f -- "$OUT/telemetry/meta.jsonl" 2>/dev/null

# Logs have exactly one producer-owned location in the canonical tree.
mkdir -p "$OUT/logs"
for log_file in "$OUT"/*.log; do
  [ -f "$log_file" ] || continue
  mv -f "$log_file" "$OUT/logs/"
done

rm -rf -- "$ARTIFACT_ROOT"
mkdir -p "$ARTIFACT_ROOT/author-agent-workspace" "$ARTIFACT_ROOT/author-agent-metadata"
mv "$WORKSPACE" "$ARTIFACT_ROOT/author-agent-workspace/$RUN_ID"
mv "$OUT" "$ARTIFACT_ROOT/author-agent-metadata/$RUN_ID"
rmdir "$WORKSPACE_ROOT" "$METADATA_ROOT" 2>/dev/null || true

GIT_SHA="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
RUN_ID="$RUN_ID" GIT_SHA="$GIT_SHA" AGENT="$AGENT" \
AGENT_MODEL="${AGENT_MODEL:-}" AGENT_REASONING_EFFORT="${AGENT_REASONING_EFFORT:-}" \
MUSE_CLI_VERSION="${MUSE_CLI_VERSION:-}" METRO_MODE="${METRO_MODE:-}" \
PRD="${PRD:-}" EXPO_MCP_AUTH_STATUS="${EXPO_MCP_AUTH_STATUS:-}" \
SCENARIO="${SCENARIO:-}" PROMPT_VARIANT="${PROMPT_VARIANT:-}" PROMPT_FILE="${PROMPT_FILE:-}" \
"$PY" - "$ARTIFACT_ROOT/manifest.json" <<'PYEOF'
import json
import os
import sys

run_id = os.environ["RUN_ID"]
agent = os.environ["AGENT"]
trace_names = {
    "claude-code": "claude-code-authoring.json",
    "codex": "codex-authoring.json",
    "muse-code": "muse-code-authoring.json",
}
metadata = f"author-agent-metadata/{run_id}"
manifest = {
    "schema_version": 2,
    "artifact_type": "authored-app",
    "run_id": run_id,
    "git_sha": os.environ.get("GIT_SHA"),
    "agent": agent,
    "agent_model": os.environ.get("AGENT_MODEL") or None,
    "agent_reasoning_effort": os.environ.get("AGENT_REASONING_EFFORT") or None,
    "muse_cli_version": os.environ.get("MUSE_CLI_VERSION") or None,
    "metro_mode": os.environ.get("METRO_MODE") or "dev-build",
    "prd": os.environ.get("PRD") or "dataset/prds/hot_chocolate/prd/mvp.txt",
    "expo_mcp_auth_status": os.environ.get("EXPO_MCP_AUTH_STATUS") or "not_attempted",
    "scenario": os.environ.get("SCENARIO") or None,
    "prompt_variant": os.environ.get("PROMPT_VARIANT") or "baseline",
    "prompt_file": os.environ.get("PROMPT_FILE") or "dataset/prompts/baseline.md",
    "artifacts": {
        "workspace": f"author-agent-workspace/{run_id}/",
        "metadata": f"{metadata}/",
        "author_env": f"{metadata}/author.env",
        "proxy_anthropic": f"{metadata}/telemetry/anthropic.jsonl",
        "proxy_openai": f"{metadata}/telemetry/openai.jsonl",
        "otel": f"{metadata}/telemetry/otel/",
        "author_trace": f"{metadata}/telemetry/traces/{trace_names.get(agent, trace_names['claude-code'])}",
        "logs": f"{metadata}/logs/",
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
PYEOF

echo "  authored artifact: $ARTIFACT_ROOT"
exit 0
