eval::_agent_timeout() {
  if command -v gtimeout >/dev/null 2>&1; then echo "gtimeout 2400";
  elif command -v timeout >/dev/null 2>&1; then echo "timeout 2400";
  else echo "python3 $_EVAL_STAGES_DIR/timeout_exec.py 2400"; fi
}

# Refreshes the Expo MCP OAuth access token from a stored, rotating refresh
# token, and persists the newly-rotated refresh_token back to the EAS
# `production` environment so the next run can refresh again. mcp.expo.dev
# supports only human browser OAuth (no service-account grant), and its
# refresh_token rotates on every use -- see get-expo-mcp-token.ts for the
# one-time bootstrap that seeds EXPO_MCP_CLIENT_ID/EXPO_MCP_REFRESH_TOKEN.
# On any failure this logs and returns non-zero; callers must treat Expo MCP
# as optional and continue authoring without it.
#
# Always exports EXPO_MCP_AUTH_STATUS so collect_artifacts.sh can record the
# outcome in manifest.json even when this silently degrades (nothing else
# about a "continue without Expo MCP" run makes that fact visible downstream
# otherwise): unconfigured | refresh_failed | ok | ok_persist_failed.
eval::refresh_expo_mcp_token() { # out_dir
  local out="$1"
  echo "================= STAGE B.5: refresh Expo MCP OAuth token ================="
  if [ -z "${EXPO_MCP_CLIENT_ID:-}" ] || [ -z "${EXPO_MCP_REFRESH_TOKEN:-}" ]; then
    echo "  Expo MCP not configured: set EXPO_MCP_CLIENT_ID + EXPO_MCP_REFRESH_TOKEN to enable it"
    export EXPO_MCP_AUTH_STATUS="unconfigured"
    return 1
  fi

  local resp_file="$out/mcp-refresh-response.json" http_code
  http_code=$(curl -sS --max-time 20 -o "$resp_file" -w '%{http_code}' https://mcp.expo.dev/oauth/token \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "refresh_token=${EXPO_MCP_REFRESH_TOKEN}" \
    --data-urlencode "client_id=${EXPO_MCP_CLIENT_ID}" 2>"$out/mcp-refresh.err") || http_code="curl-fail"
  if [ "$http_code" != "200" ]; then
    echo "  ❌ Expo MCP token refresh failed (HTTP $http_code); continuing without Expo MCP"
    export EXPO_MCP_AUTH_STATUS="refresh_failed"
    return 1
  fi

  local parsed access_token new_refresh_token
  parsed="$(python3 - "$resp_file" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(data.get("access_token", ""))
print(data.get("refresh_token", ""))
PY
)"
  access_token="$(echo "$parsed" | sed -n '1p')"
  new_refresh_token="$(echo "$parsed" | sed -n '2p')"
  if [ -z "$access_token" ]; then
    echo "  ❌ Expo MCP token refresh response missing access_token; continuing without Expo MCP"
    export EXPO_MCP_AUTH_STATUS="refresh_failed"
    return 1
  fi
  export EXPO_MCP_BEARER_TOKEN="$access_token"
  export EXPO_MCP_AUTH_STATUS="ok"
  echo "  ✅ Expo MCP access token refreshed (len ${#access_token})"

  if [ -n "$new_refresh_token" ] && [ "$new_refresh_token" != "$EXPO_MCP_REFRESH_TOKEN" ]; then
    if ! command -v eas >/dev/null 2>&1; then
      echo "  ⚠️  eas-cli not on PATH; cannot persist rotated refresh_token (next run's refresh will fail)"
      export EXPO_MCP_AUTH_STATUS="ok_persist_failed"
      return 0
    fi
    if [ -z "${EXPO_TOKEN:-}" ]; then
      echo "  ⚠️  EXPO_TOKEN unset; cannot persist rotated refresh_token (next run's refresh will fail)"
      export EXPO_MCP_AUTH_STATUS="ok_persist_failed"
      return 0
    fi
    local rc
    eas env:update production --variable-name EXPO_MCP_REFRESH_TOKEN --value "$new_refresh_token" --non-interactive \
      >"$out/mcp-refresh-env-update.log" 2>&1
    rc=$?
    eval::gate $rc "persist rotated Expo MCP refresh_token"
    if [ "$rc" != 0 ]; then
      tail -20 "$out/mcp-refresh-env-update.log" | sed 's/^/    /'
      export EXPO_MCP_AUTH_STATUS="ok_persist_failed"
    fi
  fi
  return 0
}

# Claude Code's Expo plugin bundles an unauthenticated MCP entry. A project-
# scope .mcp.json outranks it (matched by endpoint, not name), and prints the
# --settings flag needed to pre-approve it non-interactively -- both prints
# nothing (no-op) when EXPO_MCP_BEARER_TOKEN is unset, so callers can always
# splice the result into their claude invocation unquoted.
eval::_claude_expo_mcp_settings_arg() { # workspace
  local workspace="$1"
  if [ -z "${EXPO_MCP_BEARER_TOKEN:-}" ]; then
    return 0
  fi
  cat > "$workspace/.mcp.json" <<EOF
{"mcpServers":{"expo":{"type":"http","url":"https://mcp.expo.dev/mcp","headers":{"Authorization":"Bearer $EXPO_MCP_BEARER_TOKEN"}}}}
EOF
  echo '--settings {"enabledMcpjsonServers":["expo"]}'
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
# Also reads SCENARIO (default skills_available_unmentioned) and, only for the
# "skills_available_mentioned" scenario, SKILL_MENTION (a skill id to name
# explicitly in the prompt). "skills_unavailable" is the enforced
# negative-control config: skill install and Expo MCP wiring are both skipped
# entirely, so nothing exists for the agent to trigger -- see
# skill_invocation's UNAVAILABLE_SCENARIOS, which scores against this same
# enforced absence.
eval::run_coding_agent() { # agent root workspace prd_file out_dir [model]
  local agent="$1" root="$2" workspace="$3" prd_file="$4" out="$5" model="${6:-}"
  [ "$agent" = "claude" ] && agent="claude-code"
  local scenario="${SCENARIO:-skills_available_unmentioned}"
  local skills_enabled=1
  [ "$scenario" = "skills_unavailable" ] && skills_enabled=0
  echo "================= STAGE C: coding agent ($agent) authors the app ================="
  echo "  scenario=$scenario  skills_enabled=$skills_enabled"
  local prompt TO
  prompt="$(cat "$root/eval_harness/app_builder/prompts/author_app.md")"$'\n\n## App PRD\n\n'"$(cat "$prd_file")"
  if [ "$scenario" = "skills_available_mentioned" ] && [ -n "${SKILL_MENTION:-}" ]; then
    prompt="$prompt"$'\n\n## Guidance\n\nExplicitly use Expo'"'"'s "'"$SKILL_MENTION"'" skill/guidance for the relevant part of this feature.'
  fi
  TO="$(eval::_agent_timeout)"

  if [ "$agent" = "codex" ]; then
    if ! command -v codex >/dev/null 2>&1; then echo "  ❌ codex not on PATH"; return 127; fi
    export CODEX_HOME="${CODEX_HOME:-$out/codex-home}"
    local codex_bearer="${EXPO_MCP_BEARER_TOKEN:-}"
    [ "$skills_enabled" = 1 ] || codex_bearer=""
    EXPO_MCP_BEARER_TOKEN="$codex_bearer" eval::_write_codex_config "$CODEX_HOME" "${model:-${CODEX_MODEL:-gpt-5-mini}}" \
      "${OPENAI_PROXY_PORT:-8082}" "${OTLP_PORT:-4318}"
    if [ "$skills_enabled" = 1 ]; then
      # Install Expo skills into the authored workspace. A fresh CI CODEX_HOME
      # does not have the reserved openai-curated marketplace configured, so use
      # Expo's generic skills installer. Expo MCP requires OAuth; wire it only
      # when a dedicated MCP bearer token has been provided.
      {
        if [ -n "$codex_bearer" ]; then
          echo "Expo MCP configured with EXPO_MCP_BEARER_TOKEN"
        else
          echo "Expo MCP not configured: set EXPO_MCP_BEARER_TOKEN to enable it"
        fi
        codex mcp list --json || true
        ( cd "$workspace" && npx -y skills add expo/skills --yes )
      } >"$out/c-plugin.log" 2>&1 || \
        echo "  ⚠️  npx skills add expo/skills failed (continuing; see c-plugin.log)"
    else
      echo "skills_unavailable scenario: skipping Expo skill install and MCP wiring" >"$out/c-plugin.log"
    fi
    ( cd "$workspace" && $TO codex exec "$prompt" ) 2>&1 | tee "$out/c-agent.log"
    local rc=${PIPESTATUS[0]}
    eval::gate $rc "codex authored app"
    return $rc
  else
    if ! command -v claude >/dev/null 2>&1; then echo "  ❌ claude not on PATH"; return 127; fi
    local settings_arg=""
    if [ "$skills_enabled" = 1 ]; then
      # Install the official Expo plugin: bundles the Expo skills AND the Expo
      # MCP server, so we don't hand-wire `claude mcp add`. EAS workers start
      # with a clean Claude home, so seed the marketplace before installing.
      claude plugin marketplace add anthropics/claude-plugins-official >"$out/c-plugin.log" 2>&1 || \
        claude plugin marketplace update claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
        echo "  ⚠️  claude plugin marketplace setup failed (continuing; see c-plugin.log)"
      claude plugin install expo@claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
        echo "  ⚠️  claude plugin install expo@claude-plugins-official failed (continuing; see c-plugin.log)"
      settings_arg="$(eval::_claude_expo_mcp_settings_arg "$workspace")"
    else
      echo "skills_unavailable scenario: skipping Expo plugin install and MCP wiring" >"$out/c-plugin.log"
    fi
    # Branch on model rather than expanding a possibly-empty array — macOS ships
    # bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
    if [ -n "$model" ]; then
      ( cd "$workspace" && $TO claude -p "$prompt" --model "$model" \
          --dangerously-skip-permissions --add-dir "$workspace" $settings_arg ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    else
      ( cd "$workspace" && $TO claude -p "$prompt" \
          --dangerously-skip-permissions --add-dir "$workspace" $settings_arg ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    fi
    eval::gate $rc "claude-code authored app"
    return $rc
  fi
}
