eval::_agent_timeout() {
  if command -v gtimeout >/dev/null 2>&1; then echo "gtimeout 2400";
  elif command -v timeout >/dev/null 2>&1; then echo "timeout 2400";
  else echo "python3 $_EVAL_STAGES_DIR/timeout_exec.py 2400"; fi
}

# Writes Codex's user-level config.toml (model_provider routed through the
# logging proxy + [otel] pointed at the OTLP receiver).
eval::_write_codex_config() { # codex_home model openai_proxy_port otlp_port
  local codex_home="$1" model="$2" oport="$3" otlp="$4"
  mkdir -p "$codex_home"
  cat > "$codex_home/config.toml" <<EOF
model = "$model"
model_provider = "proxy"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.proxy]
name = "OpenAI via local logging proxy"
base_url = "http://127.0.0.1:$oport/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
supports_websockets = false

[otel]
environment = "eas-e2e"
log_user_prompt = true
exporter = { otlp-http = { endpoint = "http://127.0.0.1:$otlp", protocol = "binary" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:$otlp", protocol = "binary" } }
metrics_exporter = "none"
EOF
  if [ -n "${EXPO_MCP_BEARER_TOKEN:-}" ]; then
    cat >> "$codex_home/config.toml" <<EOF

[mcp_servers.expo]
url = "https://mcp.expo.dev/mcp"
bearer_token_env_var = "EXPO_MCP_BEARER_TOKEN"
enabled = true
EOF
  fi
}

# Runs the selected coding agent. Globals it reads when agent=codex:
#   CODEX_HOME, OPENAI_PROXY_PORT, OTLP_PORT, CODEX_MODEL
eval::run_coding_agent() { # agent root workspace prd_file out_dir [model]
  local agent="$1" root="$2" workspace="$3" prd_file="$4" out="$5" model="${6:-}"
  [ "$agent" = "claude" ] && agent="claude-code"
  echo "================= STAGE C: coding agent ($agent) authors the app ================="
  local prompt TO
  prompt="$(cat "$root/eval_harness/prompts/author_app.md")"$'\n\n## App PRD\n\n'"$(cat "$prd_file")"
  TO="$(eval::_agent_timeout)"

  if [ "$agent" = "codex" ]; then
    if ! command -v codex >/dev/null 2>&1; then echo "  ❌ codex not on PATH"; return 127; fi
    export CODEX_HOME="${CODEX_HOME:-$out/codex-home}"
    eval::_write_codex_config "$CODEX_HOME" "${model:-${CODEX_MODEL:-gpt-5-mini}}" \
      "${OPENAI_PROXY_PORT:-8082}" "${OTLP_PORT:-4318}"
    # Install Expo skills into the authored workspace. A fresh CI CODEX_HOME
    # does not have the reserved openai-curated marketplace configured, so use
    # Expo's generic skills installer. Expo MCP requires OAuth; wire it only
    # when a dedicated MCP bearer token has been provided.
    {
      if [ -n "${EXPO_MCP_BEARER_TOKEN:-}" ]; then
        echo "Expo MCP configured with EXPO_MCP_BEARER_TOKEN"
      else
        echo "Expo MCP not configured: set EXPO_MCP_BEARER_TOKEN to enable it"
      fi
      codex mcp list --json || true
      ( cd "$workspace" && npx -y skills add expo/skills --yes )
    } >"$out/c-plugin.log" 2>&1 || \
      echo "  ⚠️  npx skills add expo/skills failed (continuing; see c-plugin.log)"
    ( cd "$workspace" && $TO codex exec "$prompt" ) 2>&1 | tee "$out/c-agent.log"
    local rc=${PIPESTATUS[0]}
    eval::gate $rc "codex authored app"
    return $rc
  else
    if ! command -v claude >/dev/null 2>&1; then echo "  ❌ claude not on PATH"; return 127; fi
    # Install the official Expo plugin: bundles the Expo skills AND the Expo MCP
    # server, so we don't hand-wire `claude mcp add`. EAS workers start with a
    # clean Claude home, so seed the marketplace before installing the plugin.
    claude plugin marketplace add anthropics/claude-plugins-official >"$out/c-plugin.log" 2>&1 || \
      claude plugin marketplace update claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
      echo "  ⚠️  claude plugin marketplace setup failed (continuing; see c-plugin.log)"
    claude plugin install expo@claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
      echo "  ⚠️  claude plugin install expo@claude-plugins-official failed (continuing; see c-plugin.log)"
    # Branch on model rather than expanding a possibly-empty array — macOS ships
    # bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
    if [ -n "$model" ]; then
      ( cd "$workspace" && $TO claude -p "$prompt" --model "$model" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    else
      ( cd "$workspace" && $TO claude -p "$prompt" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    fi
    eval::gate $rc "claude-code authored app"
    return $rc
  fi
}

eval::run_coding_agent_repair() { # agent workspace prompt_file out_dir attempt [model]
  local agent="$1" workspace="$2" prompt_file="$3" out="$4" attempt="$5" model="${6:-}"
  [ "$agent" = "claude" ] && agent="claude-code"
  echo "================= STAGE C repair $attempt: coding agent fixes validation failures ================="
  local prompt TO
  prompt="$(cat "$prompt_file")"
  TO="$(eval::_agent_timeout)"
  if [ "$agent" = "codex" ]; then
    ( cd "$workspace" && $TO codex exec "$prompt" ) 2>&1 | tee "$out/c-repair-$attempt.log"
    local rc=${PIPESTATUS[0]}
    eval::gate $rc "codex repair pass $attempt"
    return $rc
  else
    if [ -n "$model" ]; then
      ( cd "$workspace" && $TO claude -p "$prompt" --model "$model" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-repair-$attempt.log"
      local rc=${PIPESTATUS[0]}
    else
      ( cd "$workspace" && $TO claude -p "$prompt" \
          --dangerously-skip-permissions --add-dir "$workspace" ) 2>&1 | tee "$out/c-repair-$attempt.log"
      local rc=${PIPESTATUS[0]}
    fi
    eval::gate $rc "claude-code repair pass $attempt"
    return $rc
  fi
}
