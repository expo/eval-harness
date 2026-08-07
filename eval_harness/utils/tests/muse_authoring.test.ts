import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
const AGENTS_SH = join(REPO_ROOT, "eval_harness/utils/shell/agents.sh");
const PROXY = join(REPO_ROOT, "eval_harness/utils/telemetry/proxy/logging-proxy.mjs");
const COLLECT_ARTIFACTS = join(REPO_ROOT, "eval_harness/utils/artifacts/collect_artifacts.sh");
const AUTHORING_SCRIPT = join(REPO_ROOT, "eval_harness/app_builder/scripts/author-app.sh");
const tempDirs: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runBash(script: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", "-c", script, AGENTS_SH], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
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

test("Muse authoring streams its key, installs local skills, and records Expo MCP settings", () => {
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
    eval::run_coding_agent muse-code "$ROOT" "$WORKSPACE" "$PRD" "$OUT" muse-spark-1.2
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
  expect(readFileSync(capturedArgs, "utf8")).toContain("--base-url\nhttp://127.0.0.1:8765");
  expect(readFileSync(capturedArgs, "utf8")).toContain("--no-foreign-personal-context");
  expect(readFileSync(capturedArgs, "utf8")).not.toContain("meta-secret-only-on-stdin");
  expect(readFileSync(capturedStdin, "utf8")).toBe("meta-secret-only-on-stdin\n");
  expect(readFileSync(capturedMetaEnvironment, "utf8")).toBe("absent");
  expect(readFileSync(capturedSettings, "utf8")).toContain('"schema_version": 1');
  expect(readFileSync(capturedSettings, "utf8")).toContain('"transport": "streamable_http"');
  expect(readFileSync(capturedSettings, "utf8")).toContain("expo-bearer-token");
  expect(existsSync(join(workspace, ".agents", "skills", "expo-router", "SKILL.md"))).toBe(true);
  expect(readFileSync(join(out, "c-plugin.log"), "utf8")).toContain("muse skills list --source project --enabled-only --json");
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
    eval::run_coding_agent muse-code "$ROOT" "$WORKSPACE" "$PRD" "$OUT" model
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
    MUSE_SETTINGS_CREATED: "1",
    SETTINGS: settings,
    DATA: data,
  });

  expect(result.exitCode).toBe(0);
});

test("Muse artifact collection retains normalized telemetry without shipping raw session data", () => {
  const root = tempDir("muse-artifacts-");
  const out = join(root, "out");
  const workspace = join(root, "workspace");
  const settings = tempDir("muse-settings-");
  const data = join(out, "muse-data");
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
    bash "$COLLECT_ARTIFACTS" "$ROOT" "$RUN_ID" "$OUT" "$WORKSPACE" "$ROOT" "$OUT/telemetry"
    test ! -e "$OUT/bundle/telemetry/muse"
    test -e "$OUT/bundle/telemetry/meta.jsonl"
    test -e "$OUT/bundle/telemetry/traces/muse-code-authoring.json"
    grep -q '"muse_cli_version": "muse-test-version"' "$OUT/bundle/manifest.json"
  `, {
    ROOT: REPO_ROOT,
    RUN_ID: "muse-artifacts-test",
    OUT: out,
    WORKSPACE: workspace,
    SETTINGS: settings,
    MUSE_SETTINGS_ROOT: settings,
    MUSE_DATA_ROOT: data,
    MUSE_SETTINGS_CREATED: "1",
    DATA: data,
    AGENT: "muse-code",
    MUSE_CLI_VERSION: "muse-test-version",
    COLLECT_ARTIFACTS,
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
