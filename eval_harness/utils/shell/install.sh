eval::install_agent_device() { # out_dir
  local out="$1"
  echo "================= STAGE 1: agent-device (Callstack CLI) ================="
  npm install -g agent-device@0.17.6 >"$out/s1-agent-device.log" 2>&1
  local rc=$?
  if [ "$rc" = 0 ]; then
    agent-device --version >>"$out/s1-agent-device.log" 2>&1
    rc=$?
  fi
  eval::gate "$rc" "agent-device install (needs Node 22+)"
  return "$rc"
}

eval::install_maestro() { # out_dir
  local out="$1"
  echo "================= STAGE 2: maestro ================="
  curl -Ls "https://get.maestro.mobile.dev" | bash >"$out/s2-maestro.log" 2>&1
  local pipeline_status=("${PIPESTATUS[@]}") rc=0 status
  for status in "${pipeline_status[@]}"; do
    if [ "$status" != 0 ]; then rc="$status"; break; fi
  done
  export PATH="$PATH:$HOME/.maestro/bin"
  if [ "$rc" = 0 ]; then
    maestro --version >>"$out/s2-maestro.log" 2>&1
    rc=$?
  fi
  eval::gate "$rc" "maestro install"
  return "$rc"
}

eval::install_uv_and_evaluator() { # eval_dir out_dir
  local eval_dir="$1" out="$2"
  echo "================= STAGE 3: uv + python3.12 + evaluator deps ================="
  curl -LsSf https://astral.sh/uv/install.sh | sh >"$out/s3-uv.log" 2>&1
  local pipeline_status=("${PIPESTATUS[@]}") rc=0 status
  for status in "${pipeline_status[@]}"; do
    if [ "$status" != 0 ]; then rc="$status"; break; fi
  done
  if [ "$rc" != 0 ]; then
    eval::gate "$rc" "uv installer"
    return "$rc"
  fi
  [ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  ( cd "$eval_dir" && uv --version >>"$out/s3-uv.log" 2>&1 && uv sync --python 3.12 >>"$out/s3-uv.log" 2>&1 )
  rc=$?; eval::gate $rc "uv sync (evaluator deps)"
  [ "$rc" != 0 ] && { echo "  --- s3-uv.log tail ---"; tail -25 "$out/s3-uv.log" | sed 's/^/    /'; }
  return $rc
}
