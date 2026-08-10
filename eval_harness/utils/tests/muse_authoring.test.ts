import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const AGENTS_SH = join(REPO_ROOT, "eval_harness/utils/shell/agents.sh");
const PROXY = join(REPO_ROOT, "eval_harness/utils/telemetry/proxy/logging-proxy.mjs");
const COLLECT_AUTHOR_ARTIFACT = join(REPO_ROOT, "eval_harness/utils/artifacts/collect_author_artifact.sh");
const AUTHORING_SCRIPT = join(REPO_ROOT, "eval_harness/app_builder/scripts/author-app.sh");
const tempDirs: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runBash(script: string, env: Record<string, string> = {}) {
  const processEnv = { ...process.env };
  for (const key of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "META_API_KEY",
  ]) {
    delete processEnv[key];
  }
  return Bun.spawnSync(["bash", "-c", script, AGENTS_SH], {
    cwd: REPO_ROOT,
    env: { ...processEnv, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>): string {
  return `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
}

afterEach(() => {
  for (const process of processes.splice(0)) process.kill();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("shell test helper scrubs ambient provider credentials", () => {
  const previous = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    META_API_KEY: process.env.META_API_KEY,
  };
  Object.assign(process.env, {
    CLAUDE_CODE_OAUTH_TOKEN: "ambient-claude",
    ANTHROPIC_API_KEY: "ambient-anthropic",
    ANTHROPIC_AUTH_TOKEN: "ambient-anthropic-auth",
    OPENAI_API_KEY: "ambient-openai",
    META_API_KEY: "ambient-meta",
  });
  try {
    const result = runBash(`
      test -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}"
      test -z "\${ANTHROPIC_API_KEY:-}"
      test -z "\${ANTHROPIC_AUTH_TOKEN:-}"
      test -z "\${OPENAI_API_KEY:-}"
      test -z "\${META_API_KEY:-}"
    `);
    expect(result.exitCode).toBe(0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("authoring normalizes Muse and selects all agent defaults", () => {
  const result = runBash(`
    source "$0"
    printf '%s|%s|%s|%s\n' \
      "$(eval::normalize_author_agent muse)" \
      "$(eval::default_author_model claude-code)" \
      "$(eval::default_author_model codex)" \
      "$(eval::default_author_model muse-code)"
  `);

  expect(result.exitCode).toBe(0);
  expect(output(result).trim()).toBe("muse-code|sonnet|gpt-5-mini|muse-spark-1.2");

  const unknown = runBash(`source "$0"; eval::normalize_author_agent unrecognized-agent`);
  expect(unknown.exitCode).not.toBe(0);
  expect(output(unknown)).toContain("unknown coding agent");
});

test("reasoning effort defaults high and rejects unsupported values", () => {
  const ok = runBash(`source "$0"; printf '%s|%s|%s|%s' \\
    "$(eval::resolve_reasoning_effort '')" \\
    "$(eval::resolve_reasoning_effort low)" \\
    "$(eval::resolve_reasoning_effort medium)" \\
    "$(eval::resolve_reasoning_effort high)"`);
  expect(output(ok)).toBe("high|low|medium|high");
  expect(runBash(`source "$0"; eval::resolve_reasoning_effort ultra`).exitCode).toBe(2);
});

test("Muse rejects a missing Meta credential without applying Claude auth rules", () => {
  const missing = runBash(`source "$0"; eval::require_author_agent_credential muse-code`);
  expect(missing.exitCode).not.toBe(0);
  expect(output(missing)).toContain("META_API_KEY must be set for Muse authoring");

  const present = runBash(`source "$0"; eval::require_author_agent_credential muse-code`, {
    META_API_KEY: "meta-test-key",
    ANTHROPIC_API_KEY: "must-not-matter-for-muse",
  });
  expect(present.exitCode).toBe(0);
});

test("Muse credential validation captures the key in non-exported shell state", () => {
  const result = runBash(`
    set -e
    source "$0"
    eval::require_authoring_credentials muse-code "$ROOT"
    test "$MUSE_API_KEY" = "meta-secret"
    test -z "\${META_API_KEY:-}"
    ! export -p | grep -q 'MUSE_API_KEY'
  `, {
    ROOT: REPO_ROOT,
    META_API_KEY: "meta-secret",
  });

  expect(result.exitCode).toBe(0);
});

test("authoring rejects failed agents and missing package manifests", () => {
  const root = tempDir("authoring-result-");
  const completeWorkspace = join(root, "complete");
  const emptyWorkspace = join(root, "empty");
  mkdirSync(completeWorkspace, { recursive: true });
  mkdirSync(emptyWorkspace, { recursive: true });
  writeFileSync(join(completeWorkspace, "package.json"), "{}\n");

  const failedAgent = runBash(`source "$0"; eval::require_authored_app 17 "$WORKSPACE"`, {
    WORKSPACE: completeWorkspace,
  });
  const missingPackage = runBash(`source "$0"; eval::require_authored_app 0 "$WORKSPACE"`, {
    WORKSPACE: emptyWorkspace,
  });
  const complete = runBash(`source "$0"; eval::require_authored_app 0 "$WORKSPACE"`, {
    WORKSPACE: completeWorkspace,
  });

  expect(failedAgent.exitCode).toBe(17);
  expect(output(failedAgent)).toContain("coding agent failed");
  expect(missingPackage.exitCode).toBe(1);
  expect(output(missingPackage)).toContain("did not produce package.json");
  expect(complete.exitCode).toBe(0);
});

test("Muse installer isolates credentials and writes a sourceable CLI version", () => {
  const root = tempDir("muse-install-key-boundary-");
  const bin = join(root, "bin");
  const out = join(root, "out");
  const installerEnvironment = join(root, "installer-environment.txt");
  const versionEnvironment = join(root, "version-environment.txt");
  mkdirSync(bin, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "author.env"), "RUN_ID=test\n");
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
cat <<'INSTALLER'
set -e
printf '%s|%s' "\${META_API_KEY-absent}" "\${MUSE_API_KEY-absent}" > "$CAPTURE_INSTALLER_ENVIRONMENT"
mkdir -p "$MUSE_INSTALL_DIR"
cat > "$MUSE_INSTALL_DIR/muse" <<'MUSE'
#!/usr/bin/env bash
printf '%s|%s' "\${META_API_KEY-absent}" "\${MUSE_API_KEY-absent}" > "$CAPTURE_VERSION_ENVIRONMENT"
printf 'Muse Code 0.1.0 (0.1.0-R708.1)\n'
MUSE
chmod +x "$MUSE_INSTALL_DIR/muse"
INSTALLER
`);
  chmodSync(join(bin, "curl"), 0o755);

  const result = runBash(`
    set -e
    source "$0"
    eval::gate() { return "$1"; }
    eval::require_authoring_credentials muse-code "$ROOT"
    eval::install_muse_cli "$OUT"
    unset MUSE_CLI_VERSION
    source "$OUT/author.env"
    test "$MUSE_CLI_VERSION" = "Muse Code 0.1.0 (0.1.0-R708.1)"
  `, {
    ROOT: REPO_ROOT,
    OUT: out,
    PATH: `${bin}:${process.env.PATH}`,
    META_API_KEY: "meta-secret",
    CAPTURE_INSTALLER_ENVIRONMENT: installerEnvironment,
    CAPTURE_VERSION_ENVIRONMENT: versionEnvironment,
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(installerEnvironment, "utf8")).toBe("absent|absent");
  expect(readFileSync(versionEnvironment, "utf8")).toBe("absent|absent");
  expect(readFileSync(join(out, "author.env"), "utf8")).toContain("MUSE_CLI_VERSION=");
});

test("Muse authoring streams its key directly, installs local skills, and records Expo MCP settings", () => {
  const root = tempDir("muse-authoring-");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const out = join(root, "out");
  const config = join(root, "config");
  const data = join(root, "data");
  const plugin = join(root, "plugin");
  const capturedArgs = join(root, "args.txt");
  const capturedStdin = join(root, "stdin.txt");
  const capturedSettings = join(root, "settings.json");
  const capturedMetaEnvironment = join(root, "meta-environment.txt");
  const fakeMuse = join(bin, "muse");
  mkdirSync(bin, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(join(plugin, "skills", "expo-router"), { recursive: true });
  writeFileSync(fakeMuse, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "skills" ]; then
  printf '{"skills":[]}'
  exit 0
fi
printf '%s' "\${META_API_KEY-absent}" > "$CAPTURE_META_ENVIRONMENT"
printf '%s\\n' "$@" > "$CAPTURE_ARGS"
cat > "$CAPTURE_STDIN"
cp "$XDG_CONFIG_HOME/muse/settings.json" "$CAPTURE_SETTINGS"
`);
  chmodSync(fakeMuse, 0o755);
  writeFileSync(join(plugin, "skills", "expo-router", "SKILL.md"), "---\nname: expo-router\n---\n");
  writeFileSync(join(root, "prd.txt"), "Build a tiny app.");

  const result = runBash(`
    source "$0"
    eval::_agent_timeout() { :; }
    eval::gate() { return "$1"; }
    eval::run_coding_agent muse-code "$ROOT" "$WORKSPACE" "$PRD" "$OUT" muse-spark-1.2 high
  `, {
    ROOT: REPO_ROOT,
    WORKSPACE: workspace,
    OUT: out,
    PRD: join(root, "prd.txt"),
    PATH: `${bin}:${process.env.PATH}`,
    META_API_KEY: "meta-secret-only-on-stdin",
    META_PROXY_PORT: "8765",
    EXPO_MCP_BEARER_TOKEN: "expo-bearer-token",
    EXPO_TOKEN: "expo-bearer-token",
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    SKILL_PLUGIN_DIR: plugin,
    CAPTURE_ARGS: capturedArgs,
    CAPTURE_STDIN: capturedStdin,
    CAPTURE_SETTINGS: capturedSettings,
    CAPTURE_META_ENVIRONMENT: capturedMetaEnvironment,
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(capturedArgs, "utf8")).toContain("--api-key-stdin");
  expect(readFileSync(capturedArgs, "utf8")).not.toContain("--base-url");
  expect(readFileSync(capturedArgs, "utf8")).toContain("--no-foreign-personal-context");
  expect(readFileSync(capturedArgs, "utf8")).not.toContain("meta-secret-only-on-stdin");
  expect(readFileSync(capturedStdin, "utf8")).toBe("meta-secret-only-on-stdin\n");
  expect(readFileSync(capturedMetaEnvironment, "utf8")).toBe("absent");
  expect(readFileSync(capturedSettings, "utf8")).toContain('"schema_version": 1');
  expect(readFileSync(capturedSettings, "utf8")).toContain('"transport": "streamable_http"');
  expect(readFileSync(capturedSettings, "utf8")).toContain("expo-bearer-token");
  expect(existsSync(join(workspace, ".agents", "skills", "expo-router", "SKILL.md"))).toBe(true);
  expect(readFileSync(join(out, "c-plugin.log"), "utf8")).toContain(
    `muse skills list --source project --enabled-only --workspace ${workspace} --trust-workspace --json`,
  );
});

test("Muse skill setup subprocesses cannot see the key and exec receives it only on stdin", () => {
  const root = tempDir("muse-key-boundary-");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const out = join(root, "out");
  const npxEnvironment = join(root, "npx-environment.txt");
  const skillsEnvironment = join(root, "skills-environment.txt");
  const execEnvironment = join(root, "exec-environment.txt");
  const execStdin = join(root, "exec-stdin.txt");
  mkdirSync(bin, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(root, "prd.txt"), "Build a tiny app.");
  writeFileSync(join(bin, "npx"), `#!/usr/bin/env bash
printf '%s|%s' "\${META_API_KEY-absent}" "\${MUSE_API_KEY-absent}" > "$CAPTURE_NPX_ENVIRONMENT"
`);
  writeFileSync(join(bin, "muse"), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "skills" ]; then
  printf '%s|%s' "\${META_API_KEY-absent}" "\${MUSE_API_KEY-absent}" > "$CAPTURE_SKILLS_ENVIRONMENT"
  printf '{"skills":[]}'
  exit 0
fi
printf '%s|%s|%s|%s|%s|%s|%s' \
  "\${META_API_KEY-absent}" \
  "\${MUSE_API_KEY-absent}" \
  "\${CLAUDE_CODE_OAUTH_TOKEN-absent}" \
  "\${ANTHROPIC_API_KEY-absent}" \
  "\${OPENAI_API_KEY-absent}" \
  "\${BRAINTRUST_API_KEY-absent}" \
  "\${GCP_SA_KEY-absent}" > "$CAPTURE_EXEC_ENVIRONMENT"
cat > "$CAPTURE_EXEC_STDIN"
`);
  chmodSync(join(bin, "npx"), 0o755);
  chmodSync(join(bin, "muse"), 0o755);

  const result = runBash(`
    set -e
    source "$0"
    eval::_agent_timeout() { :; }
    eval::gate() { return "$1"; }
    eval::require_authoring_credentials muse-code "$ROOT"
    eval::run_coding_agent muse-code "$ROOT" "$WORKSPACE" "$PRD" "$OUT" muse-spark-1.2 high "$MUSE_API_KEY"
  `, {
    ROOT: REPO_ROOT,
    WORKSPACE: workspace,
    OUT: out,
    PRD: join(root, "prd.txt"),
    PATH: `${bin}:${process.env.PATH}`,
    META_API_KEY: "meta-secret-only-on-stdin",
    CLAUDE_CODE_OAUTH_TOKEN: "unrelated-claude-secret",
    ANTHROPIC_API_KEY: "unrelated-anthropic-secret",
    OPENAI_API_KEY: "unrelated-openai-secret",
    BRAINTRUST_API_KEY: "unrelated-braintrust-secret",
    GCP_SA_KEY: "unrelated-gcp-secret",
    CAPTURE_NPX_ENVIRONMENT: npxEnvironment,
    CAPTURE_SKILLS_ENVIRONMENT: skillsEnvironment,
    CAPTURE_EXEC_ENVIRONMENT: execEnvironment,
    CAPTURE_EXEC_STDIN: execStdin,
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(npxEnvironment, "utf8")).toBe("absent|absent");
  expect(readFileSync(skillsEnvironment, "utf8")).toBe("absent|absent");
  expect(readFileSync(execEnvironment, "utf8")).toBe(
    "absent|absent|absent|absent|absent|absent|absent",
  );
  expect(readFileSync(execStdin, "utf8")).toBe("meta-secret-only-on-stdin\n");
});

test("Muse negative-control scenario skips Expo skills and MCP settings", () => {
  const root = tempDir("muse-negative-");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const out = join(root, "out");
  const config = join(root, "config");
  const fakeMuse = join(bin, "muse");
  mkdirSync(bin, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(fakeMuse, `#!/usr/bin/env bash
set -euo pipefail
test ! -e "$XDG_CONFIG_HOME/muse/settings.json"
cat >/dev/null
`);
  chmodSync(fakeMuse, 0o755);
  writeFileSync(join(root, "prd.txt"), "Build a tiny app.");

  const result = runBash(`
    source "$0"
    eval::_agent_timeout() { :; }
    eval::gate() { return "$1"; }
    eval::run_coding_agent muse-code "$ROOT" "$WORKSPACE" "$PRD" "$OUT" model high
  `, {
    ROOT: REPO_ROOT,
    WORKSPACE: workspace,
    OUT: out,
    PRD: join(root, "prd.txt"),
    PATH: `${bin}:${process.env.PATH}`,
    META_API_KEY: "meta-key",
    EXPO_MCP_BEARER_TOKEN: "expo-token",
    XDG_CONFIG_HOME: config,
    SCENARIO: "skills_unavailable",
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(workspace, ".agents", "skills"))).toBe(false);
  expect(readFileSync(join(out, "c-plugin.log"), "utf8")).toContain("skills_unavailable scenario");
});

test("Muse EXIT cleanup removes settings without deleting session data", () => {
  const root = tempDir("muse-cleanup-");
  const settings = join(root, "settings");
  const data = join(root, "data");
  const result = runBash(`
    source "$0"
    mkdir -p "$MUSE_SETTINGS_ROOT/muse" "$MUSE_DATA_ROOT/muse/sessions"
    touch "$MUSE_SETTINGS_ROOT/muse/settings.json" "$MUSE_DATA_ROOT/muse/sessions/session.jsonl"
    eval::cleanup_muse_settings
    test ! -e "$SETTINGS" && test -e "$DATA/muse/sessions/session.jsonl"
  `, {
    MUSE_SETTINGS_ROOT: settings,
    MUSE_DATA_ROOT: data,
    MUSE_SETTINGS_OWNED: "1",
    SETTINGS: settings,
    DATA: data,
  });

  expect(result.exitCode).toBe(0);
});

test("Muse cleanup preserves ambient XDG config and removes only harness-owned settings", () => {
  const root = tempDir("muse-settings-ownership-");
  const ambient = join(root, "ambient-config");
  const sentinel = join(ambient, "keep.txt");
  mkdirSync(ambient, { recursive: true });
  writeFileSync(sentinel, "keep");

  const result = runBash(`
    set -e
    source "$0"
    eval::configure_muse_settings skills_unavailable
    owned_settings="$MUSE_SETTINGS_ROOT"
    test "$owned_settings" != "$XDG_CONFIG_HOME"
    test -e "$SENTINEL"
    eval::cleanup_muse_settings
    test -e "$SENTINEL"
    test ! -e "$owned_settings"
  `, {
    XDG_CONFIG_HOME: ambient,
    SENTINEL: sentinel,
  });

  expect(result.exitCode).toBe(0);
});

test("Muse artifact collection retains its normalized trace without raw session or proxy data", () => {
  const root = tempDir("muse-artifacts-");
  symlinkSync(join(REPO_ROOT, "eval_harness"), join(root, "eval_harness"), "dir");
  const runId = "muse-artifacts-test";
  const metadataRoot = join(root, "author-agent-metadata");
  const workspaceRoot = join(root, "author-agent-workspace");
  const artifact = join(root, "authored-app");
  const out = join(metadataRoot, runId);
  const workspace = join(workspaceRoot, runId);
  const settings = tempDir("muse-settings-");
  const data = join(out, "muse-xdg-data");
  const result = runBash(`
    set -e
    source "$0"
    mkdir -p "$MUSE_SETTINGS_ROOT/muse" "$MUSE_DATA_ROOT/muse/sessions" "$WORKSPACE"
    printf 'secret settings' > "$MUSE_SETTINGS_ROOT/muse/settings.json"
    printf '%s\n' '{"payload_type":"runtime.session","payload":{"kind":"run","run_id":"muse-run","event":{"kind":"started","prompt":"Build"}}}' > "$MUSE_DATA_ROOT/muse/sessions/session.jsonl"
    mkdir -p "$OUT/telemetry"
    printf 'proxy event\n' > "$OUT/telemetry/meta.jsonl"
    eval::cleanup_muse_settings
    test ! -e "$SETTINGS/muse/settings.json"
    test "$MUSE_DATA_ROOT" = "$DATA"
    bash "$COLLECT_AUTHOR_ARTIFACT" "$ROOT" "$RUN_ID" "$WORKSPACE_ROOT" "$METADATA_ROOT" "$ARTIFACT"
    test ! -e "$ARTIFACT/author-agent-metadata/$RUN_ID/telemetry/muse"
    test ! -e "$ARTIFACT/author-agent-metadata/$RUN_ID/telemetry/meta.jsonl"
    test ! -e "$ARTIFACT/author-agent-metadata/$RUN_ID/muse-xdg-data"
    test -e "$ARTIFACT/author-agent-metadata/$RUN_ID/telemetry/traces/muse-code-authoring.json"
    grep -q '"muse_cli_version": "muse-test-version"' "$ARTIFACT/manifest.json"
    ! grep -q '"proxy_meta"' "$ARTIFACT/manifest.json"
  `, {
    ROOT: root,
    RUN_ID: runId,
    OUT: out,
    WORKSPACE: workspace,
    WORKSPACE_ROOT: workspaceRoot,
    METADATA_ROOT: metadataRoot,
    ARTIFACT: artifact,
    SETTINGS: settings,
    MUSE_SETTINGS_ROOT: settings,
    MUSE_DATA_ROOT: data,
    MUSE_SETTINGS_OWNED: "1",
    DATA: data,
    AGENT: "muse-code",
    MUSE_CLI_VERSION: "muse-test-version",
    COLLECT_AUTHOR_ARTIFACT,
  });

  expect(result.exitCode).toBe(0);
});

test("Muse authoring config is outside output and Claude retains OTLP telemetry", () => {
  const authoring = readFileSync(AUTHORING_SCRIPT, "utf8");
  expect(authoring).toContain('MUSE_SETTINGS_ROOT="$(mktemp -d');
  expect(authoring).toContain('XDG_CONFIG_HOME="$MUSE_SETTINGS_ROOT"');
  expect(authoring).not.toContain('XDG_CONFIG_HOME="$OUT/muse-xdg-config"');
  expect(authoring).toMatch(
    /if \[ "\$AGENT" = "claude-code" \]; then[\s\S]*OTEL_EXPORTER_OTLP_ENDPOINT[\s\S]*OTEL_RESOURCE_ATTRIBUTES/,
  );
});

test("logging proxy joins an upstream path prefix and redacts credential headers", async () => {
  let receivedPath = "";
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      receivedPath = new URL(request.url).pathname;
      return Response.json({ ok: true });
    },
  });
  const root = tempDir("muse-proxy-");
  const logPath = join(root, "meta.jsonl");
  const port = 18_000 + Math.floor(Math.random() * 10_000);
  const child = Bun.spawn(["node", PROXY], {
    env: {
      ...process.env,
      PROXY_PORT: String(port),
      PROXY_LABEL: "meta",
      PROXY_UPSTREAM: `http://127.0.0.1:${upstream.port}/v1`,
      PROXY_LOG: logPath,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  processes.push(child);

  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/muse-code/models`, {
        headers: { authorization: "Bearer meta-secret", "x-api-key": "also-secret" },
      });
      if (response.ok) break;
    } catch {
      await Bun.sleep(25);
    }
  }
  await Bun.sleep(25);
  upstream.stop(true);

  expect(receivedPath).toBe("/v1/muse-code/models");
  const record = JSON.parse(readFileSync(logPath, "utf8"));
  expect(record.request_headers.authorization).toBe("<redacted>");
  expect(record.request_headers["x-api-key"]).toBe("<redacted>");
});
