#!/usr/bin/env bash
# Resolve PROMPT_VARIANT (a short id) to the authoring prompt's path, or fail.
#
# Prints the repo-relative path on stdout so a caller can capture it:
#   PROMPT_FILE="$(bash eval_harness/utils/shell/resolve_prompt.sh)" || exit 1
#
# Exists as its own script -- rather than inline in author-app.sh -- so the
# resolution rules are testable without running an authoring job (see
# eval_harness/utils/tests/test_resolve_prompt.py), matching check_claude_auth.sh.
#
# Why ids and not paths: a path input silently degrades. `prompt="$(cat "$bad")"`
# yields an empty base prompt, and author-app.sh runs `set -uo pipefail` without
# `-e`, so nothing aborts -- the agent authors from the bare PRD with no
# instructions, and that invalid run still gets built, evaluated, and scored.
# Resolving an id against dataset/prompts.json turns that into an immediate,
# explicit failure before any expensive stage runs.
set -uo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
REGISTRY="${PROMPT_REGISTRY:-$ROOT/dataset/prompts.json}"
VARIANT="${PROMPT_VARIANT:-baseline}"

if [ ! -f "$REGISTRY" ]; then
  echo "❌ prompt registry not found: $REGISTRY" >&2
  exit 1
fi

# Resolve id -> relative file, listing valid ids on a miss so the fix is obvious
# from the failure alone.
rel="$(REGISTRY="$REGISTRY" VARIANT="$VARIANT" python3 -c '
import json, os, sys
registry, variant = os.environ["REGISTRY"], os.environ["VARIANT"]
try:
    variants = (json.load(open(registry)) or {}).get("variants") or {}
except (OSError, json.JSONDecodeError) as exc:
    print(f"unreadable prompt registry {registry}: {exc}", file=sys.stderr)
    sys.exit(1)
entry = variants.get(variant)
if entry is None:
    known = ", ".join(sorted(variants)) or "(none)"
    print(f"unknown prompt_variant {variant!r}; known ids: {known}", file=sys.stderr)
    sys.exit(1)
file = (entry or {}).get("file")
if not file:
    print(f"prompt_variant {variant!r} has no file entry in {registry}", file=sys.stderr)
    sys.exit(1)
print(file)
')" || {
  echo "❌ could not resolve prompt_variant '$VARIANT' from $REGISTRY" >&2
  exit 1
}

abs="$(dirname "$REGISTRY")/$rel"
if [ ! -f "$abs" ]; then
  echo "❌ prompt_variant '$VARIANT' points at a missing file: $abs" >&2
  exit 1
fi
if [ ! -s "$abs" ]; then
  echo "❌ prompt_variant '$VARIANT' points at an empty file: $abs" >&2
  exit 1
fi

# Repo-relative, matching how PRD is passed around and recorded in manifest.json.
echo "${abs#"$ROOT"/}"
