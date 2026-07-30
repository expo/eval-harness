#!/usr/bin/env bash
set -u

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY must be unset because it overrides Claude subscription OAuth" >&2
  exit 1
fi

if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "ANTHROPIC_AUTH_TOKEN must be unset because it overrides Claude subscription OAuth" >&2
  exit 1
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "CLAUDE_CODE_OAUTH_TOKEN is missing; generate one with 'claude setup-token'" >&2
  exit 1
fi

echo "CLAUDE_CODE_OAUTH_TOKEN bound"
