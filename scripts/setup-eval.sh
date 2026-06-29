#!/usr/bin/env bash
# Standalone agentic-evaluator run inside an EAS macOS workflow job.
#
# Goal: run ONE primitive (test_insert) against the `notes` reference app in Expo Go,
# scoring via the agentic_evaluator (agent-device + Maestro hybrid). Because nobody has
# run a sim REPL inside EAS before, every dependency/stage is GATED and prints OK/FAIL —
# so a failure pinpoints the blocker (this run doubles as the capability probe).
#
# Never exits non-zero mid-way (so we learn as much as possible per run); ends exit 0.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVAL="$ROOT/evaluator"
APP="$EVAL/reference_apps_notes"
OUT="$ROOT/eval-out"; mkdir -p "$OUT"
export CI=1 EXPO_NO_TELEMETRY=1
# Worker's JAVA_HOME points at a non-existent openjdk@21; Maestro needs a valid JDK
# (worker has Java 17). Repoint it so the Maestro hybrid restart path works.
export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home 2>/dev/null)"
echo "JAVA_HOME=$JAVA_HOME"

gate() { if [ "${1}" = 0 ]; then echo "  ✅ STAGE OK:   ${2}"; else echo "  ❌ STAGE FAIL: ${2} (rc=${1})"; fi; }

echo "================= ENV ================="
sw_vers 2>/dev/null | tr '\n' ' '; echo
xcodebuild -version 2>/dev/null | head -1
echo "node: $(node --version 2>/dev/null)  npm: $(npm --version 2>/dev/null)"
echo "java: $(java -version 2>&1 | head -1)"
echo "python3: $(python3 --version 2>&1)"

echo "================= STAGE 1: agent-device (Callstack CLI) ================="
npm install -g agent-device@0.17.6 >"$OUT/s1-agent-device.log" 2>&1
agent-device --version; gate $? "agent-device install (needs Node 22+)"

echo "================= STAGE 2: maestro ================="
curl -Ls "https://get.maestro.mobile.dev" | bash >"$OUT/s2-maestro.log" 2>&1
export PATH="$PATH:$HOME/.maestro/bin"
maestro --version >/dev/null 2>&1; gate $? "maestro install"

echo "================= STAGE 3: uv + python3.12 + evaluator deps ================="
curl -LsSf https://astral.sh/uv/install.sh | sh >"$OUT/s3-uv.log" 2>&1
[ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
cd "$EVAL"
uv --version >>"$OUT/s3-uv.log" 2>&1
uv sync --python 3.12 >>"$OUT/s3-uv.log" 2>&1
rc=$?; gate $rc "uv sync (evaluator deps)"
[ "$rc" != 0 ] && { echo "  --- s3-uv.log tail ---"; tail -25 "$OUT/s3-uv.log" | sed 's/^/    /'; }

echo "================= STAGE 4: device select + agent-device boot + prepare ios-runner ================="
# agent-device needs (a) a selected device via AGENT_DEVICE_IOS_DEVICE, (b) its own
# boot, and (c) `prepare ios-runner` to install the XCTest runner on the sim — without
# this the daemon can't snapshot (the cause of our prior "snapshot failed"). These env
# vars are EXPORTED so the evaluator's own agent-device subprocesses inherit the device.
DEV_LINE=$(xcrun simctl list devices available 2>/dev/null | grep -E "iPhone" | head -1)
DEVNAME=$(echo "$DEV_LINE" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*\([0-9A-Fa-f-]+\).*$//')
echo "  device: '$DEVNAME'  (line: $DEV_LINE)"
export AGENT_DEVICE_IOS_DEVICE="$DEVNAME"
export AGENT_DEVICE_DAEMON_TIMEOUT_MS=180000
export AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS=180000
agent-device boot --platform ios --device "$DEVNAME" >"$OUT/s4-boot.log" 2>&1
rc=$?; gate $rc "agent-device boot ($DEVNAME)"
[ "$rc" != 0 ] && tail -20 "$OUT/s4-boot.log" | sed 's/^/    /'
agent-device prepare ios-runner --platform ios --device "$DEVNAME" --timeout "$AGENT_DEVICE_DAEMON_TIMEOUT_MS" >"$OUT/s4-runner.log" 2>&1
rc=$?; gate $rc "agent-device prepare ios-runner"
[ "$rc" != 0 ] && tail -25 "$OUT/s4-runner.log" | sed 's/^/    /'

echo "================= STAGE 5: notes app deps ================="
cd "$APP"
npm install >"$OUT/s5-npm-notes.log" 2>&1; gate $? "notes npm install"

echo "================= STAGE 6: Metro + load app in Expo Go ================="
( cd "$APP" && npx expo start --ios ) >"$OUT/s6-metro.log" 2>&1 &
METRO_PID=$!
up=1
for _ in $(seq 1 60); do
  if curl -s http://localhost:8081/status >/dev/null 2>&1; then up=0; break; fi
  sleep 2
done
gate $up "metro up on :8081"
echo "  (giving Expo Go ~25s to install + load the bundle)"; sleep 25

echo "================= STAGE 6b: agent-device probe (open Expo Go + snapshot) ================="
# Direct probe with the SAME session the evaluator uses ("adaptive"). If this snapshots
# the app, the evaluator will too; if it fails, we see agent-device's REAL error (vs the
# evaluator's swallowed "snapshot failed") — and that decides the Expo-Go vs .app pivot.
agent-device open host.exp.Exponent --platform ios --session adaptive >"$OUT/s6b-open.log" 2>&1
rc=$?; gate $rc "agent-device open host.exp.Exponent"
[ "$rc" != 0 ] && tail -20 "$OUT/s6b-open.log" | sed 's/^/    /'
agent-device snapshot -i --platform ios --session adaptive >"$OUT/s6b-snap.log" 2>&1
rc=$?; gate $rc "agent-device snapshot probe"
echo "  --- snapshot head (first 25 lines) ---"; head -25 "$OUT/s6b-snap.log" | sed 's/^/    /'

echo "================= STAGE 7: agentic evaluator ================="
cd "$EVAL"
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "  ❌ ANTHROPIC_API_KEY unset"; fi
# macOS workers have neither GNU `timeout` nor `gtimeout`; use whichever exists,
# else run bare (the evaluator has its own 60-min watchdog).
TO=""
if command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 1800";
elif command -v timeout >/dev/null 2>&1; then TO="timeout 1800"; fi
$TO uv run python -m agentic_evaluator.main \
    test_plans/primitives/test_insert.txt \
    --prd prds/notes/prd/mvp.txt \
    -d agent-device --hybrid-restart \
    --seed-iterations 200 --max-iterations 50 \
    -o "$OUT/result.json" --verbose >"$OUT/s7-eval.log" 2>&1
rc=$?; gate $rc "evaluator run"
[ "$rc" != 0 ] && { echo "  --- s7-eval.log tail ---"; tail -40 "$OUT/s7-eval.log" | sed 's/^/    /'; }

echo "================= RESULT ================="
if [ -f "$OUT/result.json" ]; then cat "$OUT/result.json"; else echo "(no result.json produced)"; fi
echo "================= eval.log tail (40) ================="
tail -n 40 "$OUT/s7-eval.log" 2>/dev/null
echo "================= metro.log tail (15) ================="
tail -n 15 "$OUT/s6-metro.log" 2>/dev/null

kill $METRO_PID 2>/dev/null || true
exit 0
