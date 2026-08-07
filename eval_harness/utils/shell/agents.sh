eval::_agent_timeout() {
  if command -v gtimeout >/dev/null 2>&1; then echo "gtimeout 2400";
  elif command -v timeout >/dev/null 2>&1; then echo "timeout 2400";
  else echo "bun $_EVAL_STAGES_DIR/timeout_exec.ts 2400"; fi
}

# Normalize the public authoring-agent values once at the harness boundary.
# `muse` remains a convenience alias only; manifests and workflow behavior use
# the canonical `muse-code` value.
eval::normalize_authoring_agent() { # agent
  case "$1" in
    claude|claude-code) printf '%s\n' "claude-code" ;;
    codex) printf '%s\n' "codex" ;;
    muse|muse-code) printf '%s\n' "muse-code" ;;
    *)
      echo "unsupported authoring agent: $1 (expected claude-code, codex, or muse-code)" >&2
      return 2
      ;;
  esac
}

# Compatibility names keep the pure authoring configuration contract easy to
# invoke from shell tests and local tooling. The canonical runtime value remains
# `muse-code`; `muse` is accepted only as an input alias.
eval::normalize_author_agent() { # agent
  case "$1" in
    claude|claude-code|codex|muse|muse-code)
      eval::normalize_authoring_agent "$1"
      ;;
    *)
      echo "unknown coding agent: $1" >&2
      return 2
      ;;
  esac
}

eval::resolve_authoring_model() { # agent requested_model
  local agent="$1" requested="${2:-}"
  if [ -n "$requested" ]; then
    printf '%s\n' "$requested"
    return 0
  fi
  case "$agent" in
    claude-code) printf '%s\n' "sonnet" ;;
    codex) printf '%s\n' "${CODEX_MODEL:-gpt-5-mini}" ;;
    muse-code) printf '%s\n' "muse-spark-1.2" ;;
    *)
      echo "unsupported authoring agent: $agent" >&2
      return 2
      ;;
  esac
}

eval::default_author_model() { # agent
  eval::resolve_authoring_model "$1" ""
}

# Authoring credentials are deliberately provider-specific. In particular,
# do not run Claude Code's OAuth check for Codex or Muse: the downstream iOS
# evaluator retains its own Claude auth check in eval-ios-app.sh.
eval::require_authoring_credentials() { # agent root
  local agent="$1" root="$2"
  case "$agent" in
    claude-code)
      bash "$root/eval_harness/utils/shell/check_claude_auth.sh"
      ;;
    codex)
      if [ -z "${OPENAI_API_KEY:-}" ]; then
        echo "OPENAI_API_KEY is missing; Codex authoring requires it" >&2
        return 1
      fi
      echo "OPENAI_API_KEY bound"
      ;;
    muse-code)
      if [ -z "${META_API_KEY:-}" ]; then
        echo "META_API_KEY is missing; Muse authoring requires it" >&2
        return 1
      fi
      echo "META_API_KEY bound"
      ;;
    *)
      echo "unsupported authoring agent: $agent" >&2
      return 2
      ;;
  esac
}

eval::require_author_agent_credential() { # agent [root]
  local agent="$1" root="${2:-${_EVAL_STAGES_DIR%/utils/shell}}"
  if [ "$agent" = "muse" ] || [ "$agent" = "muse-code" ]; then
    if [ -z "${META_API_KEY:-}" ]; then
      echo "META_API_KEY must be set for Muse authoring" >&2
      return 1
    fi
    return 0
  fi
  eval::require_authoring_credentials "$(eval::normalize_authoring_agent "$agent")" "$root"
}

# Configures Expo MCP auth for this run. mcp.expo.dev now accepts an Expo
# Robot User access token (EXPO_TOKEN) directly as a Bearer token -- verified
# live (initialize + tools/list both succeed) -- so this is a plain variable
# assignment, no network call, no separate OAuth login/refresh/rotation dance
# needed at all. Replaces the old eval::refresh_expo_mcp_token /
# provision_mcp_token design (see git history), which existed only to work
# around mcp.expo.dev previously rejecting EXPO_TOKEN and requiring human
# browser OAuth with a rotating refresh_token.
#
# Always exports EXPO_MCP_AUTH_STATUS so collect_artifacts.sh can record the
# outcome in manifest.json: unconfigured | ok.
eval::configure_expo_mcp() {
  if [ -z "${EXPO_TOKEN:-}" ]; then
    echo "  Expo MCP not configured: EXPO_TOKEN unset"
    export EXPO_MCP_AUTH_STATUS="unconfigured"
    return 1
  fi
  if [ -n "${EXPO_TOKEN:-}" ]; then
    export EXPO_MCP_BEARER_TOKEN="$EXPO_TOKEN"
  fi
  export EXPO_MCP_AUTH_STATUS="ok"
  echo "  ✅ Expo MCP bearer token set from EXPO_TOKEN (len ${#EXPO_TOKEN})"
  return 0
}

# Muse reads settings from $XDG_CONFIG_HOME/muse/settings.json and session data
# from $XDG_DATA_HOME/muse. Authoring binds both roots to the current run.
eval::configure_muse_settings() { # scenario
  local scenario="$1"
  local settings_root="${MUSE_SETTINGS_ROOT:-${XDG_CONFIG_HOME:-}}"
  export MUSE_SETTINGS_CREATED=1
  if [ -z "$settings_root" ]; then
    settings_root="$(mktemp -d "${TMPDIR:-/tmp}/muse-settings.XXXXXX")" || return 1
  fi
  mkdir -p "$settings_root/muse" "$settings_root/data"
  export MUSE_SETTINGS_ROOT="$settings_root"
  export MUSE_DATA_ROOT="${MUSE_DATA_ROOT:-${XDG_DATA_HOME:-$settings_root/data}}"
  mkdir -p "$MUSE_DATA_ROOT"
  if [ "$scenario" = "skills_unavailable" ]; then
    export EXPO_MCP_AUTH_STATUS="not_attempted"
    echo "  Muse Expo MCP not configured: skills_unavailable scenario"
    return 0
  fi
  if [ -z "${EXPO_TOKEN:-}" ] && [ -z "${EXPO_MCP_BEARER_TOKEN:-}" ]; then
    export EXPO_MCP_AUTH_STATUS="unconfigured"
    echo "  Muse Expo MCP not configured: EXPO_TOKEN unset"
    return 0
  fi
  MUSE_SETTINGS_FILE="$settings_root/muse/settings.json" \
    MUSE_MCP_TOKEN="${EXPO_TOKEN:-${EXPO_MCP_BEARER_TOKEN:-}}" \
    node -e 'const fs = require("node:fs"); const file = process.env.MUSE_SETTINGS_FILE; const token = process.env.MUSE_MCP_TOKEN; fs.writeFileSync(file, JSON.stringify({schema_version: 1, mcp_servers: {expo: {enabled: true, transport: "streamable_http", url: "https://mcp.expo.dev/mcp", headers: {Authorization: `Bearer ${token}`}}}}, null, 2), {mode: 0o600});' \
    || return 1
  export EXPO_MCP_AUTH_STATUS="ok"
  echo "  ✅ Muse Expo MCP configured from EXPO_TOKEN"
}

eval::cleanup_muse_settings() {
  if [ "${MUSE_SETTINGS_CREATED:-0}" = "1" ] && [ -n "${MUSE_SETTINGS_ROOT:-}" ]; then
    rm -rf -- "$MUSE_SETTINGS_ROOT"
  fi
  # Session data is non-secret run evidence needed by collect_artifacts.sh;
  # only the credential-bearing settings root is removed here.
  unset MUSE_SETTINGS_ROOT MUSE_SETTINGS_CREATED
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
# Globals it reads when agent=muse-code:
#   META_PROXY_PORT, MUSE_SETTINGS_ROOT, MUSE_DATA_ROOT
# Also reads SCENARIO (default skills_available_unmentioned) and, only for the
# "skills_available_mentioned" scenario, SKILL_MENTION (a skill id to name
# explicitly in the prompt). "skills_unavailable" is the enforced
# negative-control config: skill install and Expo MCP wiring are both skipped
# entirely, so nothing exists for the agent to trigger -- see
# skill_invocation's UNAVAILABLE_SCENARIOS, which scores against this same
# enforced absence.
# SKILL_PLUGIN_DIR: when set, use the local checkout's skills rather than the
# published package. Claude loads its plugin directly; Codex and Muse copy the
# checkout's skills/ children into the authored project's .agents/skills/.
# PROMPT_FILE (default eval_harness/app_builder/prompts/author_app.md):
# base authoring prompt, relative to repo root -- overridable to compare
# prompt variants against the same PRD/scenario matrix.
eval::run_coding_agent() { # agent root workspace prd_file out_dir [model]
  local agent="$1" root="$2" workspace="$3" prd_file="$4" out="$5" model="${6:-}"
  agent="$(eval::normalize_authoring_agent "$agent")" || return $?
  local scenario="${SCENARIO:-skills_available_unmentioned}"
  local skills_enabled=1
  [ "$scenario" = "skills_unavailable" ] && skills_enabled=0
  if [ "$agent" = "muse-code" ] && [ -z "${MUSE_SETTINGS_ROOT:-}" ]; then
    eval::configure_muse_settings "$scenario" || return $?
  fi
  local prompt_file="${PROMPT_FILE:-eval_harness/app_builder/prompts/author_app.md}"
  echo "================= STAGE C: coding agent ($agent) authors the app ================="
  echo "  scenario=$scenario  skills_enabled=$skills_enabled  prompt_file=$prompt_file"
  local prompt TO
  prompt="$(cat "$root/$prompt_file")"
  if [ "$scenario" = "skills_available_mentioned" ] && [ -n "${SKILL_MENTION:-}" ]; then
    # Inserted before "The PRD follows." (not after the PRD itself) so it
    # reads as part of the task instructions the agent sees first, not as a
    # late addendum tacked on after the whole PRD.
    prompt="$prompt"$'\n\n## Guidance\n\nExplicitly use Expo'"'"'s "'"$SKILL_MENTION"'" skill/guidance for the relevant part of this feature.'
  fi
  prompt="$prompt"$'\n\nThe PRD follows.\n\n## App PRD\n\n'"$(cat "$prd_file")"
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
  elif [ "$agent" = "muse-code" ]; then
    if ! command -v muse >/dev/null 2>&1; then echo "  ❌ muse not on PATH"; return 127; fi
    if [ "$skills_enabled" = 1 ]; then
      (
        if [ -n "${SKILL_PLUGIN_DIR:-}" ]; then
          if [ ! -d "$SKILL_PLUGIN_DIR/skills" ]; then
            echo "  ❌ SKILL_PLUGIN_DIR has no skills directory: $SKILL_PLUGIN_DIR/skills"
            exit 1
          else
            mkdir -p "$workspace/.agents/skills"
            cp -R "$SKILL_PLUGIN_DIR/skills/." "$workspace/.agents/skills/"
            echo "loaded Expo skills from SKILL_PLUGIN_DIR"
          fi
        else
          ( cd "$workspace" && npx -y skills add expo/skills --yes )
        fi
        echo "muse skills list --source project --enabled-only --json"
        ( cd "$workspace" && env -u META_API_KEY muse skills list --source project --enabled-only --json )
      ) >"$out/c-plugin.log" 2>&1 || \
        echo "  ⚠️  Muse Expo skill setup failed (continuing; see c-plugin.log)"
    else
      echo "skills_unavailable scenario: skipping Expo skill install and MCP wiring" >"$out/c-plugin.log"
    fi
    local muse_settings_root="${MUSE_SETTINGS_ROOT:-}"
    local muse_data_root="${MUSE_DATA_ROOT:-}"
    local rc
    if [ -n "$muse_settings_root" ]; then
      ( cd "$workspace" && printf '%s\n' "$META_API_KEY" | ( unset META_API_KEY; \
          XDG_CONFIG_HOME="$muse_settings_root" XDG_DATA_HOME="$muse_data_root" \
          MUSE_NO_AUTO_UPDATE=1 $TO muse exec --json --api-key-stdin --provider meta \
            --model "${model:-muse-spark-1.2}" --workspace "$workspace" --yolo \
            --no-foreign-personal-context --base-url "http://127.0.0.1:${META_PROXY_PORT:-8084}" "$prompt" ) ) \
        2>&1 | tee "$out/c-agent.log"
      rc=${PIPESTATUS[0]}
    else
      ( cd "$workspace" && printf '%s\n' "$META_API_KEY" | ( unset META_API_KEY; \
          MUSE_NO_AUTO_UPDATE=1 $TO muse exec --json --api-key-stdin --provider meta \
            --model "${model:-muse-spark-1.2}" --workspace "$workspace" --yolo \
            --no-foreign-personal-context --base-url "http://127.0.0.1:${META_PROXY_PORT:-8084}" "$prompt" ) ) \
        2>&1 | tee "$out/c-agent.log"
      rc=${PIPESTATUS[0]}
    fi
    eval::gate $rc "muse-code authored app"
    return $rc
  else
    if ! command -v claude >/dev/null 2>&1; then echo "  ❌ claude not on PATH"; return 127; fi
    local settings_arg="" plugin_arg=""
    if [ "$skills_enabled" = 1 ]; then
      if [ -n "${SKILL_PLUGIN_DIR:-}" ]; then
        # CI-only path (see skills-repo integration): load the plugin straight
        # from a local checkout -- e.g. a PR's own proposed skill changes --
        # instead of the published marketplace version, so the eval actually
        # exercises what the PR changed rather than what's already released.
        plugin_arg="--plugin-dir $SKILL_PLUGIN_DIR"
        echo "loading plugin from SKILL_PLUGIN_DIR=$SKILL_PLUGIN_DIR (skipping marketplace install)" >"$out/c-plugin.log"
        # Also disable the *published* Expo plugin at the project level, in case
        # it's already enabled there (e.g. baked into a template, or carried
        # over in a reused ~/.claude/settings.json) -- project settings override
        # user settings, so this is the only reliable lever. Otherwise the model
        # could trigger the published skill instead of (or alongside) the local
        # one and we'd silently score the wrong version. Mirrors the same fix in
        # skills' own expo-skill-eval fixture generator (make-fixture.sh).
        local published_plugin_id="${SKILL_PLUGIN_PUBLISHED_ID:-expo@claude-plugins-official}"
        mkdir -p "$workspace/.claude"
        printf '{\n  "enabledPlugins": {\n    "%s": false\n  }\n}\n' "$published_plugin_id" \
          >"$workspace/.claude/settings.local.json"
      else
        # Install the official Expo plugin: bundles the Expo skills AND the Expo
        # MCP server, so we don't hand-wire `claude mcp add`. EAS workers start
        # with a clean Claude home, so seed the marketplace before installing.
        claude plugin marketplace add anthropics/claude-plugins-official >"$out/c-plugin.log" 2>&1 || \
          claude plugin marketplace update claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
          echo "  ⚠️  claude plugin marketplace setup failed (continuing; see c-plugin.log)"
        claude plugin install expo@claude-plugins-official >>"$out/c-plugin.log" 2>&1 || \
          echo "  ⚠️  claude plugin install expo@claude-plugins-official failed (continuing; see c-plugin.log)"
      fi
      settings_arg="$(eval::_claude_expo_mcp_settings_arg "$workspace")"
    else
      echo "skills_unavailable scenario: skipping Expo plugin install and MCP wiring" >"$out/c-plugin.log"
    fi
    # Branch on model rather than expanding a possibly-empty array — macOS ships
    # bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
    if [ -n "$model" ]; then
      ( cd "$workspace" && $TO claude -p "$prompt" --model "$model" \
          --dangerously-skip-permissions --add-dir "$workspace" $settings_arg $plugin_arg ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    else
      ( cd "$workspace" && $TO claude -p "$prompt" \
          --dangerously-skip-permissions --add-dir "$workspace" $settings_arg $plugin_arg ) 2>&1 | tee "$out/c-agent.log"
      local rc=${PIPESTATUS[0]}
    fi
    eval::gate $rc "claude-code authored app"
    return $rc
  fi
}
