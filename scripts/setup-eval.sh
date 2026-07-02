#!/usr/bin/env bash
# Standalone agentic-evaluator run inside an EAS macOS workflow job.
#
# Goal: run ONE primitive (test_insert) against the `notes` reference app in Expo Go,
# scoring via the agentic_evaluator (agent-device + Maestro hybrid). Because nobody has
# run a sim REPL inside EAS before, every dependency/stage is GATED and prints OK/FAIL —
# so a failure pinpoints the blocker (this run doubles as the capability probe).
#
# The reusable install/boot/serve/evaluate stages live in scripts/lib/eval-stages.sh,
# shared with the end-to-end orchestrator (scripts/build-and-eval.sh). This script just
# sequences them against the checked-in reference app.
#
# Never exits non-zero mid-way (so we learn as much as possible per run); ends exit 0.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVAL="$ROOT/evaluator"
APP="$EVAL/reference_apps_notes"
OUT="$ROOT/eval-out"; mkdir -p "$OUT"
export CI=1 EXPO_NO_TELEMETRY=1

# shellcheck source=scripts/lib/eval-stages.sh
source "$ROOT/scripts/lib/eval-stages.sh"

eval::fix_java_home
eval::env_banner

eval::install_agent_device "$OUT"
eval::install_maestro "$OUT"
eval::install_uv_and_evaluator "$EVAL" "$OUT"
eval::boot_sim_and_runner "$OUT"
eval::npm_install "$APP" "$OUT"
eval::start_metro_expo_go "$APP" "$OUT"
eval::probe_snapshot "$OUT" "host.exp.Exponent"
eval::run_evaluator "$EVAL" \
    test_plans/primitives/test_insert.txt \
    prds/notes/prd/mvp.txt \
    "$OUT/result.json" \
    "$OUT" \
    --hybrid-restart

echo "================= RESULT ================="
if [ -f "$OUT/result.json" ]; then cat "$OUT/result.json"; else echo "(no result.json produced)"; fi
echo "================= eval.log tail (40) ================="
tail -n 40 "$OUT/s7-eval.log" 2>/dev/null
echo "================= metro.log tail (15) ================="
tail -n 15 "$OUT/s6-metro.log" 2>/dev/null

kill "${EVAL_METRO_PID:-}" 2>/dev/null || true
exit 0
