eval::boot_sim_and_runner() { # out_dir
  local out="$1"
  echo "================= STAGE 4: device select + agent-device boot + prepare ios-runner ================="
  local dev_line devname dev_udid
  dev_line=$(xcrun simctl list devices available 2>/dev/null | grep -E "iPhone" | head -1)
  devname=$(echo "$dev_line" | sed -E 's/^[[:space:]]*//; s/[[:space:]]*\([0-9A-Fa-f-]+\).*$//')
  dev_udid=$(echo "$dev_line" | sed -E 's/.*\(([0-9A-Fa-f-]+)\).*/\1/')
  echo "  device: '$devname'  udid='$dev_udid'  (line: $dev_line)"
  export EVAL_DEVNAME="$devname"
  export AGENT_DEVICE_IOS_DEVICE="$devname"
  export AGENT_DEVICE_DAEMON_TIMEOUT_MS=180000
  export AGENT_DEVICE_IOS_BOOT_TIMEOUT_MS=180000
  : >"$out/s4-boot.log"
  local rc=1 attempt max_attempts="${EVAL_IOS_BOOT_ATTEMPTS:-3}"
  for attempt in $(seq 1 "$max_attempts"); do
    echo "  agent-device boot attempt $attempt/$max_attempts"
    {
      echo "--- boot attempt $attempt/$max_attempts ---"
      xcrun simctl boot "$dev_udid" || true
      xcrun simctl bootstatus "$dev_udid" -b || true
      python3 "$_EVAL_STAGES_DIR/timeout_exec.py" "${EVAL_IOS_BOOT_TIMEOUT_SEC:-240}" \
        agent-device boot --platform ios --device "$devname"
    } >>"$out/s4-boot.log" 2>&1
    rc=$?
    [ "$rc" = 0 ] && break
    tail -20 "$out/s4-boot.log" | sed 's/^/    /'
    sleep 10
  done
  eval::gate $rc "agent-device boot ($devname)"
  if [ "$rc" != 0 ]; then
    tail -30 "$out/s4-boot.log" | sed 's/^/    /'
    return "$rc"
  fi
  local runner_timeout="${EVAL_IOS_RUNNER_TIMEOUT_SEC:-420}"
  echo "  preparing ios-runner (timeout ${runner_timeout}s)"
  python3 "$_EVAL_STAGES_DIR/timeout_exec.py" "$runner_timeout" \
    agent-device prepare ios-runner --platform ios --device "$devname" --timeout "$AGENT_DEVICE_DAEMON_TIMEOUT_MS" \
    >"$out/s4-runner.log" 2>&1
  rc=$?; eval::gate $rc "agent-device prepare ios-runner"
  [ "$rc" != 0 ] && tail -25 "$out/s4-runner.log" | sed 's/^/    /'
  return $rc
}
