eval::run_evaluator() { # eval_dir test_plan prd out_json out_dir [extra args...]
  # test_plan may be empty -- when omitted, the Python CLI auto-resolves which
  # test plans are relevant to $prd's app from dataset/prd_test_plans.json
  # instead of requiring one manually picked file/directory.
  local eval_dir="$1" test_plan="$2" prd="$3" out_json="$4" out="$5"; shift 5
  echo "================= STAGE 7: agentic evaluator ================="
  case "$test_plan" in
    "$eval_dir"/*) test_plan="${test_plan#"$eval_dir"/}" ;;
  esac
  case "$prd" in
    "$eval_dir"/*) prd="${prd#"$eval_dir"/}" ;;
  esac
  echo "  test_plan=${test_plan:-<auto-resolved from prd_test_plans.json>}"
  echo "  prd=$prd"
  bash "$_EVAL_STAGES_DIR/check_claude_auth.sh" || return 1
  local TO=""
  if command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 1800";
  elif command -v timeout >/dev/null 2>&1; then TO="timeout 1800";
  else TO="python3 $_EVAL_STAGES_DIR/timeout_exec.py 1800"; fi
  # Branch on test_plan rather than expanding a possibly-empty array — macOS
  # ships bash 3.2, where "${arr[@]}" on an empty array trips `set -u`.
  local rc
  if [ "${EVAL_STREAM_LOGS:-1}" = "1" ]; then
    if [ -n "$test_plan" ]; then
      ( cd "$eval_dir" && $TO uv run python -m eval_harness.evaluator.ios_agentic.main \
          "$test_plan" \
          --prd "$prd" \
          -d agent-device \
          --seed-iterations 200 --max-iterations 50 \
          -o "$out_json" --verbose "$@" ) 2>&1 | tee "$out/s7-eval.log"
    else
      ( cd "$eval_dir" && $TO uv run python -m eval_harness.evaluator.ios_agentic.main \
          --prd "$prd" \
          -d agent-device \
          --seed-iterations 200 --max-iterations 50 \
          -o "$out_json" --verbose "$@" ) 2>&1 | tee "$out/s7-eval.log"
    fi
    rc=${PIPESTATUS[0]}
  else
    if [ -n "$test_plan" ]; then
      ( cd "$eval_dir" && $TO uv run python -m eval_harness.evaluator.ios_agentic.main \
          "$test_plan" \
          --prd "$prd" \
          -d agent-device \
          --seed-iterations 200 --max-iterations 50 \
          -o "$out_json" --verbose "$@" ) >"$out/s7-eval.log" 2>&1
    else
      ( cd "$eval_dir" && $TO uv run python -m eval_harness.evaluator.ios_agentic.main \
          --prd "$prd" \
          -d agent-device \
          --seed-iterations 200 --max-iterations 50 \
          -o "$out_json" --verbose "$@" ) >"$out/s7-eval.log" 2>&1
    fi
    rc=$?
  fi
  eval::gate $rc "evaluator run"
  [ "$rc" != 0 ] && { echo "  --- s7-eval.log tail ---"; tail -40 "$out/s7-eval.log" | sed 's/^/    /'; }
  return $rc
}
