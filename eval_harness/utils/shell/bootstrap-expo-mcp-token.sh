#!/usr/bin/env bash
# One-command bootstrap + secret push for a fresh EAS environment: loads
# EXPO_TOKEN from .env so the `eas` CLI is already authenticated, completes
# the one-time interactive Expo MCP OAuth login (get-expo-mcp-token.ts), then
# pushes EXPO_MCP_CLIENT_ID / EXPO_MCP_REFRESH_TOKEN plus (if present in .env)
# ANTHROPIC_API_KEY / OPENAI_API_KEY straight to EAS -- no manual copy-paste
# or separate `eas env:push` needed.
#
# Usage: eval_harness/utils/shell/bootstrap-expo-mcp-token.sh [environment]
#   environment defaults to "production" (matches `eas env:push` in the README).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENVIRONMENT="${1:-production}"
ENV_FILE="$ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE not found. Copy .env.default to .env and fill in EXPO_TOKEN first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ -z "${EXPO_TOKEN:-}" ]; then
  echo "❌ EXPO_TOKEN is not set in $ENV_FILE (needed so the eas CLI is authenticated non-interactively)." >&2
  exit 1
fi
export EXPO_TOKEN

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun is required to run get-expo-mcp-token.ts: https://bun.sh" >&2
  exit 1
fi
if ! command -v eas >/dev/null 2>&1; then
  echo "❌ eas CLI is required: npm install -g eas-cli" >&2
  exit 1
fi

echo "================= Step 1/2: interactive OAuth bootstrap ================="
echo "A browser window will open for you to approve the login."
TOKEN_OUT="$(mktemp)"
trap 'rm -f "$TOKEN_OUT"' EXIT

if ! bun "$ROOT/eval_harness/utils/shell/get-expo-mcp-token.ts" >"$TOKEN_OUT"; then
  echo "❌ get-expo-mcp-token.ts failed; nothing was pushed to EAS." >&2
  exit 1
fi

CLIENT_ID="$(grep '^EXPO_MCP_CLIENT_ID=' "$TOKEN_OUT" | head -1 | cut -d= -f2-)"
REFRESH_TOKEN="$(grep '^EXPO_MCP_REFRESH_TOKEN=' "$TOKEN_OUT" | head -1 | cut -d= -f2-)"

if [ -z "$CLIENT_ID" ] || [ -z "$REFRESH_TOKEN" ] || [[ "$REFRESH_TOKEN" == "(none returned"* ]]; then
  echo "❌ did not get a usable client_id/refresh_token pair from the OAuth flow; nothing was pushed to EAS." >&2
  exit 1
fi
echo "  ✅ got client_id (len ${#CLIENT_ID}) and refresh_token (len ${#REFRESH_TOKEN})"

# Most of these vars are being pushed for the first time on a fresh
# environment, so try env:create first; fall back to env:update for the
# (less common) case where a var is already there, e.g. re-running this
# script to re-bootstrap a broken Expo MCP refresh chain.
_push_var() { # name value visibility
  local name="$1" value="$2" visibility="$3"
  if eas env:create "$ENVIRONMENT" --name "$name" --value "$value" --type string --visibility "$visibility" --non-interactive >/dev/null 2>&1; then
    echo "  ✅ created new $name in '$ENVIRONMENT'"
    return 0
  fi
  if eas env:update "$ENVIRONMENT" --variable-name "$name" --value "$value" --non-interactive >/dev/null 2>&1; then
    echo "  ✅ updated existing $name in '$ENVIRONMENT'"
    return 0
  fi
  echo "  ❌ failed to push $name to '$ENVIRONMENT' (tried both env:create and env:update)" >&2
  return 1
}

echo "================= Step 2/2: pushing secrets to EAS ($ENVIRONMENT) ================="
ok=1
_push_var EXPO_MCP_CLIENT_ID "$CLIENT_ID" plaintext || ok=0
_push_var EXPO_MCP_REFRESH_TOKEN "$REFRESH_TOKEN" secret || ok=0

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  _push_var ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" secret || ok=0
else
  echo "  ℹ️  ANTHROPIC_API_KEY not set in .env; skipping"
fi

if [ -n "${OPENAI_API_KEY:-}" ]; then
  _push_var OPENAI_API_KEY "$OPENAI_API_KEY" secret || ok=0
else
  echo "  ℹ️  OPENAI_API_KEY not set in .env; skipping"
fi

if [ "$ok" = 1 ]; then
  echo "================= Done: secrets are live in '$ENVIRONMENT' ================="
else
  echo "================= Done with errors -- see above ================="
  exit 1
fi
