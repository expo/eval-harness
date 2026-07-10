eval::run_evaluator() { # eval_dir test_plan prd out_json out_dir [extra args...]
  local eval_dir="$1" test_plan="$2" prd="$3" out_json="$4" out="$5"; shift 5
  echo "================= STAGE 7: agentic evaluator ================="
  case "$test_plan" in
    "$eval_dir"/*) test_plan="${test_plan#"$eval_dir"/}" ;;
  esac
  case "$prd" in
    "$eval_dir"/*) prd="${prd#"$eval_dir"/}" ;;
  esac
  echo "  test_plan=$test_plan"
  echo "  prd=$prd"
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "  ❌ ANTHROPIC_API_KEY unset"; fi
  local TO=""
  if command -v gtimeout >/dev/null 2>&1; then TO="gtimeout 1800";
  elif command -v timeout >/dev/null 2>&1; then TO="timeout 1800";
  else TO="python3 $_EVAL_STAGES_DIR/timeout_exec.py 1800"; fi
  local rc
  if [ "${EVAL_STREAM_LOGS:-1}" = "1" ]; then
    ( cd "$eval_dir" && $TO uv run python -m eval_harness.evaluator.ios_agentic.main \
        "$test_plan" \
        --prd "$prd" \
        -d agent-device \
        --seed-iterations 200 --max-iterations 50 \
        -o "$out_json" --verbose "$@" ) 2>&1 | tee "$out/s7-eval.log"
    rc=${PIPESTATUS[0]}
  else
    ( cd "$eval_dir" && $TO uv run python -m eval_harness.evaluator.ios_agentic.main \
        "$test_plan" \
        --prd "$prd" \
        -d agent-device \
        --seed-iterations 200 --max-iterations 50 \
        -o "$out_json" --verbose "$@" ) >"$out/s7-eval.log" 2>&1
    rc=$?
  fi
  eval::gate $rc "evaluator run"
  [ "$rc" != 0 ] && { echo "  --- s7-eval.log tail ---"; tail -40 "$out/s7-eval.log" | sed 's/^/    /'; }
  return $rc
}
