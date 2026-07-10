eval::gate() { # rc label
  local ts
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || date)"
  if [ "${1}" = 0 ]; then
    echo "  [$ts] ✅ STAGE OK:   ${2}"
  else
    echo "  [$ts] ❌ STAGE FAIL: ${2} (rc=${1})"
  fi
}

eval::fix_java_home() {
  # Worker's JAVA_HOME points at a non-existent openjdk@21; Maestro needs a valid
  # JDK (worker has Java 17). Repoint it so the Maestro hybrid restart path works.
  export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home 2>/dev/null)"
  echo "JAVA_HOME=$JAVA_HOME"
}

eval::env_banner() {
  echo "================= ENV ================="
  sw_vers 2>/dev/null | tr '\n' ' '; echo
  xcodebuild -version 2>/dev/null | head -1
  echo "node: $(node --version 2>/dev/null)  npm: $(npm --version 2>/dev/null)"
  echo "java: $(java -version 2>&1 | head -1)"
  echo "python3: $(python3 --version 2>&1)"
}
