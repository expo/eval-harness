#!/usr/bin/env bash
# Standalone entrypoint for the provision_mcp_token workflow job: refreshes the
# Expo MCP OAuth access token exactly once per workflow run and prints it so the
# caller can `set-output` it for every downstream author_app job to consume
# directly via `EXPO_MCP_BEARER_TOKEN`/`EXPO_MCP_AUTH_STATUS` env vars.
#
# Without this, each author_app job called eval::refresh_expo_mcp_token (see
# agents.sh) independently, and each one self-persisted the newly-rotated
# refresh_token back to the same shared EAS `EXPO_MCP_REFRESH_TOKEN` secret --
# fine for a single job, but a real race the moment more than one author_app
# job runs in the same workflow invocation (e.g. one per PRD). Refreshing once
# here and fanning the resulting access token out as a job output makes that
# race structurally impossible, regardless of fan-out width, as long as the
# fanned-out jobs finish inside the access token's 1hr TTL.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=eval_harness/utils/shell/eval_stages.sh
source "$ROOT/eval_harness/utils/shell/eval_stages.sh"

OUT="$(mktemp -d)"
# Redirect the function's own diagnostic echo lines to stderr so stdout carries
# only the final key=value pair below -- the workflow step captures stdout with
# $(...) and needs it free of anything but these two lines.
eval::refresh_expo_mcp_token "$OUT" 1>&2 || true

echo "bearer_token=${EXPO_MCP_BEARER_TOKEN:-}"
echo "auth_status=${EXPO_MCP_AUTH_STATUS:-unconfigured}"
