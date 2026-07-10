eval::launch_proxy() { # root label upstream port logfile
  local root="$1"
  PROXY_LABEL="$2" PROXY_UPSTREAM="$3" PROXY_PORT="$4" PROXY_LOG="$5" \
    node "$root/eval_harness/utils/telemetry/proxy/logging-proxy.mjs" &
  EVAL_PROXY_PIDS+=($!)
}

eval::launch_otlp_receiver() { # root port out_dir
  local root="$1" port="$2" out="$3"
  OTLP_PORT="$port" OTLP_OUT="$out" node "$root/eval_harness/utils/telemetry/proxy/otlp-receiver.mjs" &
  EVAL_PROXY_PIDS+=($!)
}

eval::wait_for_port() { # port
  local _
  for _ in $(seq 1 30); do
    if node -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "!! proxy on port $1 never came up" >&2; return 1
}

eval::stop_proxies() {
  local p
  for p in "${EVAL_PROXY_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
}
