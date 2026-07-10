#!/usr/bin/env bash
# Minimal EAS smoke for verifying that a coding agent can see and use Expo
# skills/plugins without running the full app authoring/evaluation harness.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AGENT="${AGENT:-codex}"
[ "$AGENT" = "claude" ] && AGENT="claude-code"
AGENT_MODEL="${AGENT_MODEL:-}"
SMOKE_SKILL="${SMOKE_SKILL:-native-data-fetching}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-skill-smoke}"
OUT="${OUT:-$ROOT/skill-smoke-out/$RUN_ID}"
WORKSPACE="${WORKSPACE:-$OUT/workspace}"
mkdir -p "$OUT" "$WORKSPACE"

if [ -z "$AGENT_MODEL" ]; then
  if [ "$AGENT" = "codex" ]; then
    AGENT_MODEL="${CODEX_MODEL:-gpt-5-mini}"
  else
    AGENT_MODEL="sonnet"
  fi
fi

cat >"$OUT/prompt.md" <<EOF
You are running an Expo skill visibility smoke test inside an empty workspace.

Explicitly use the installed \`$SMOKE_SKILL\` Expo skill/guidance if it is available.
Then create these files:

1. \`skill-smoke-result.json\` with this JSON shape:
   {
     "agent": "$AGENT",
     "skill_requested": "$SMOKE_SKILL",
     "used_skill": true,
     "evidence": "one concrete sentence about the guidance you used",
     "app_files_created": ["package.json", "app.json", "App.js"]
   }

2. A tiny Expo app consisting of \`package.json\`, \`app.json\`, and \`App.js\`.
   The app should implement a simple mobile-safe remote data loading screen with
   loading, error, and pull-to-refresh states, following the requested skill.

Keep it minimal. Do not start Metro or run a native build. Stop after writing the files.
EOF

echo "================= AGENT SKILL SMOKE ================="
echo "RUN_ID=$RUN_ID"
echo "AGENT=$AGENT"
echo "AGENT_MODEL=$AGENT_MODEL"
echo "SMOKE_SKILL=$SMOKE_SKILL"
echo "WORKSPACE=$WORKSPACE"

run_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    npm install -g @openai/codex >"$OUT/install-codex.log" 2>&1
  fi
  if [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "OPENAI_API_KEY is required for Codex smoke"
    return 1
  fi
  export CODEX_HOME="${CODEX_HOME:-$OUT/codex-home}"
  mkdir -p "$CODEX_HOME"
  cat >"$CODEX_HOME/config.toml" <<EOF
model = "$AGENT_MODEL"
model_provider = "openai-env"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.openai-env]
name = "OpenAI via OPENAI_API_KEY"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
supports_websockets = false
EOF
  {
    echo "Installing Expo skills for Codex with npx -y skills add expo/skills --yes"
    (cd "$WORKSPACE" && npx -y skills add expo/skills --yes)
    echo
    echo "Installed skill files:"
    find "$WORKSPACE/.agents/skills" -maxdepth 2 -name SKILL.md -print | sort
    echo
    echo "Codex MCP servers:"
    codex mcp list --json || true
  } >"$OUT/c-plugin.log" 2>&1
  local install_rc=$?
  echo "Codex skill install exit=$install_rc"
  if [ "$install_rc" != 0 ]; then
    tail -80 "$OUT/c-plugin.log" | sed 's/^/    /'
    return "$install_rc"
  fi

  (cd "$WORKSPACE" && codex exec \
    --skip-git-repo-check \
    --sandbox danger-full-access \
    -m "$AGENT_MODEL" \
    -c approval_policy=\"never\" \
    -o "$OUT/last-message.txt" \
    "$(cat "$OUT/prompt.md")") 2>&1 | tee "$OUT/c-agent.log"
  return "${PIPESTATUS[0]}"
}

run_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code >"$OUT/install-claude.log" 2>&1
  fi
  {
    echo "Installing Expo plugin for Claude Code"
    claude plugin marketplace add anthropics/claude-plugins-official || \
      claude plugin marketplace update claude-plugins-official
    claude plugin install expo@claude-plugins-official
    echo
    echo "Claude plugins:"
    claude plugin list || true
  } >"$OUT/c-plugin.log" 2>&1
  local install_rc=$?
  echo "Claude plugin install exit=$install_rc"
  if [ "$install_rc" != 0 ]; then
    tail -80 "$OUT/c-plugin.log" | sed 's/^/    /'
    return "$install_rc"
  fi

  (cd "$WORKSPACE" && claude -p "$(cat "$OUT/prompt.md")" \
    --model "$AGENT_MODEL" \
    --dangerously-skip-permissions \
    --add-dir "$WORKSPACE") 2>&1 | tee "$OUT/c-agent.log"
  return "${PIPESTATUS[0]}"
}

case "$AGENT" in
  codex) run_codex; rc=$? ;;
  claude-code) run_claude; rc=$? ;;
  *) echo "Unsupported AGENT=$AGENT"; rc=2 ;;
esac

echo "agent exit=$rc" >"$OUT/summary.txt"
print_plugin_summary() {
  grep -E "Found [0-9]+ skills|Installation complete|Installed [0-9]+ skills|Successfully installed|expo@|Version:|Status:|Codex MCP servers|Installed skill files" "$OUT/c-plugin.log" 2>/dev/null | head -80 || true
}

{
  echo "----- c-plugin summary -----"
  print_plugin_summary
  echo
  echo "----- skill-smoke-result.json -----"
  cat "$WORKSPACE/skill-smoke-result.json" 2>/dev/null || echo "missing"
  echo
  echo "----- workspace files -----"
  find "$WORKSPACE" -maxdepth 3 -type f -print | sort
} | tee "$OUT/smoke-report.txt"

if [ "$rc" = 0 ] && [ -f "$WORKSPACE/skill-smoke-result.json" ]; then
  echo "✅ skill smoke completed"
else
  echo "❌ skill smoke failed"
  rc=1
fi
exit "$rc"
