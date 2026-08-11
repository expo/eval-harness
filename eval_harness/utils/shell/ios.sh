eval::boot_sim_and_runner() { # out_dir
  local out="$1"
  echo "================= STAGE 4: device select + agent-device boot + prepare ios-runner ================="
  local devices_json selection devname dev_udid runtime_version available_versions
  unset EVAL_IOS_PREREQUISITE_REASON EVAL_IOS_PREREQUISITE_LOG
  devices_json="$out/s4-simctl-devices.json"
  if ! xcrun simctl list devices available --json >"$devices_json" 2>"$out/s4-simctl-devices.err"; then
    EVAL_IOS_PREREQUISITE_REASON="evaluator simulator selection failed"
    EVAL_IOS_PREREQUISITE_LOG="logs/s4-simctl-devices.err"
    export EVAL_IOS_PREREQUISITE_REASON EVAL_IOS_PREREQUISITE_LOG
    echo "  ❌ could not list available iOS simulators as JSON"
    return 1
  fi
  selection="$(python3 - "$devices_json" 2>>"$out/s4-simctl-devices.err" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)

candidates = []
versions = set()
for runtime_id, devices in (payload.get("devices") or {}).items():
    match = re.search(r"\.iOS-([0-9-]+)$", runtime_id)
    if not match or not isinstance(devices, list):
        continue
    version = match.group(1).replace("-", ".")
    version_key = tuple(int(part) for part in version.split("."))
    for index, device in enumerate(devices):
        if not isinstance(device, dict):
            continue
        name = device.get("name")
        udid = device.get("udid")
        if not isinstance(name, str) or not name.startswith("iPhone"):
            continue
        if not isinstance(udid, str) or not udid or device.get("isAvailable") is False:
            continue
        versions.add((version_key, version))
        candidates.append(
            (version_key, device.get("state") == "Booted", -index, name, udid, version)
        )

if not candidates:
    raise SystemExit("no available iPhone simulator runtime")

selected = max(candidates, key=lambda item: (item[0], item[1], item[2]))
available = [version for _, version in sorted(versions, reverse=True)]
print("\t".join((selected[3], selected[4], selected[5], json.dumps(available))))
PY
)" || {
    EVAL_IOS_PREREQUISITE_REASON="evaluator simulator selection failed"
    EVAL_IOS_PREREQUISITE_LOG="logs/s4-simctl-devices.err"
    export EVAL_IOS_PREREQUISITE_REASON EVAL_IOS_PREREQUISITE_LOG
    echo "  ❌ no available iPhone simulator could be selected"
    return 1
  }
  IFS=$'\t' read -r devname dev_udid runtime_version available_versions <<<"$selection"
  if [ -z "$devname" ] || [ -z "$dev_udid" ] || [ -z "$runtime_version" ]; then
    EVAL_IOS_PREREQUISITE_REASON="evaluator simulator selection failed"
    EVAL_IOS_PREREQUISITE_LOG="logs/s4-simctl-devices.err"
    export EVAL_IOS_PREREQUISITE_REASON EVAL_IOS_PREREQUISITE_LOG
    echo "  ❌ simulator selection returned incomplete device metadata"
    return 1
  fi
  echo "  device: '$devname'  udid='$dev_udid'  iOS='$runtime_version'"
  export EVAL_DEVNAME="$devname"
  export EVAL_DEV_UDID="$dev_udid"
  export EVAL_IOS_RUNTIME_VERSION="$runtime_version"
  export EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON="$available_versions"
  export AGENT_DEVICE_IOS_DEVICE="$dev_udid"
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
      bun "$_EVAL_STAGES_DIR/timeout_exec.ts" "${EVAL_IOS_BOOT_TIMEOUT_SEC:-240}" \
        agent-device boot --platform ios --device "$dev_udid"
    } >>"$out/s4-boot.log" 2>&1
    rc=$?
    [ "$rc" = 0 ] && break
    tail -20 "$out/s4-boot.log" | sed 's/^/    /'
    sleep 10
  done
  eval::gate $rc "agent-device boot ($devname, $dev_udid, iOS $runtime_version)"
  if [ "$rc" != 0 ]; then
    EVAL_IOS_PREREQUISITE_REASON="evaluator simulator boot failed"
    EVAL_IOS_PREREQUISITE_LOG="logs/s4-boot.log"
    export EVAL_IOS_PREREQUISITE_REASON EVAL_IOS_PREREQUISITE_LOG
    tail -30 "$out/s4-boot.log" | sed 's/^/    /'
    return "$rc"
  fi
  local runner_timeout="${EVAL_IOS_RUNNER_TIMEOUT_SEC:-420}"
  echo "  preparing ios-runner (timeout ${runner_timeout}s)"
  bun "$_EVAL_STAGES_DIR/timeout_exec.ts" "$runner_timeout" \
    agent-device prepare ios-runner --platform ios --device "$dev_udid" --timeout "$AGENT_DEVICE_DAEMON_TIMEOUT_MS" \
    >"$out/s4-runner.log" 2>&1
  rc=$?; eval::gate $rc "agent-device prepare ios-runner"
  [ "$rc" != 0 ] && tail -25 "$out/s4-runner.log" | sed 's/^/    /'
  if [ "$rc" != 0 ]; then
    EVAL_IOS_PREREQUISITE_REASON="evaluator ios-runner preparation failed"
    EVAL_IOS_PREREQUISITE_LOG="logs/s4-runner.log"
    export EVAL_IOS_PREREQUISITE_REASON EVAL_IOS_PREREQUISITE_LOG
  fi
  return $rc
}
