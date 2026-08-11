import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
EVALUATOR_SH = ROOT / "eval_harness/utils/shell/evaluator.sh"
APP_RUNTIME_SH = ROOT / "eval_harness/utils/shell/app_runtime.sh"
IOS_COLLECTOR = ROOT / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
IOS_SANITIZER = ROOT / "eval_harness/utils/artifacts/sanitize_ios_artifact.py"


def copy_ios_collector(destination: Path) -> None:
    shutil.copy2(IOS_COLLECTOR, destination)
    shutil.copy2(IOS_SANITIZER, destination.with_name(IOS_SANITIZER.name))


def validate_result(contents: str | None) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as td:
        result_path = Path(td) / "result.json"
        if contents is not None:
            result_path.write_text(contents, encoding="utf-8")
        return subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; eval::require_evaluator_result "$2"',
                "bash",
                str(EVALUATOR_SH),
                str(result_path),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )


def resolve_ios_app_mode(mode: str | None = None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.pop("EVAL_IOS_APP_MODE", None)
    env.pop("EVAL_DEV_CLIENT_CLEAR_STATE", None)
    if mode is not None:
        env["EVAL_IOS_APP_MODE"] = mode
    return subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; eval::configure_ios_app_mode; '
            'printf "%s|%s" "$EVAL_IOS_APP_MODE" "${EVAL_DEV_CLIENT_CLEAR_STATE:-unset}"',
            "bash",
            str(APP_RUNTIME_SH),
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


class EvalIosScriptTests(unittest.TestCase):
    def run_prerequisite_failure(
        self,
        prerequisite: str,
        exit_code: int,
    ) -> tuple[subprocess.CompletedProcess[str], dict, Path, Path]:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        run_id = f"failed-{prerequisite}"
        script = root / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
        collector = root / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
        diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
        stages = root / "eval_harness/utils/shell/eval_stages.sh"
        identity = root / "eval_harness/utils/ios/normalize_ios_identity.mjs"
        author_env = root / "author-agent-metadata" / run_id / "author.env"
        workspace = root / "author-agent-workspace" / run_id
        artifact = root / "ios-eval-report"
        dependency_marker = root / "dependency-install-ran"
        native_marker = root / "native-build-ran"

        script.parent.mkdir(parents=True, exist_ok=True)
        collector.parent.mkdir(parents=True, exist_ok=True)
        stages.parent.mkdir(parents=True, exist_ok=True)
        identity.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SCRIPT, script)
        copy_ios_collector(collector)
        shutil.copy2(
            ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
            diagnostic,
        )
        identity.write_text(
            """import fs from 'node:fs';
const [, , workspace, runId, configPath, adjustmentsPath] = process.argv;
fs.writeFileSync(adjustmentsPath, JSON.stringify({source:'evaluator', adjustments:[]}));
""",
            encoding="utf-8",
        )
        stages.write_text(
            """eval::resolve_reasoning_effort() { printf '%s' "${1:-high}"; }
eval::fix_java_home() { :; }
eval::env_banner() { :; }
eval::stop_proxies() { :; }
eval::fail_prerequisite() {
  [ "$FAIL_PREREQUISITE" = "$1" ] || return 0
  out="$2"; log="$3"
  mkdir -p "$out"
  printf '%s\n' "$1 failed with $FAIL_RC" >"$out/$log"
  return "$FAIL_RC"
}
eval::install_agent_device() { eval::fail_prerequisite agent-device "$1" s1-agent-device.log; }
eval::install_maestro() { eval::fail_prerequisite maestro "$1" s2-maestro.log; }
eval::install_uv_and_evaluator() { eval::fail_prerequisite evaluator-dependencies "$2" s3-uv.log; }
eval::launch_proxy() { :; }
eval::wait_for_port() { return 0; }
eval::launch_otlp_receiver() { :; }
eval::run_authored() { "$@"; }
eval::npm_install() { touch "$DEPENDENCY_MARKER"; return 0; }
eval::configure_ios_app_mode() { EVAL_IOS_APP_MODE=release; export EVAL_IOS_APP_MODE; }
eval::boot_sim_and_runner() {
  if [ "$FAIL_PREREQUISITE" = simulator-runner ]; then
    printf '%s\n' 'ios-runner preparation failed' >"$1/s4-runner.log"
    unset EVAL_DEVNAME EVAL_DEV_UDID EVAL_IOS_RUNTIME_VERSION EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON
    EVAL_IOS_PREREQUISITE_REASON='evaluator ios-runner preparation failed'
    EVAL_IOS_PREREQUISITE_LOG='logs/s4-runner.log'
    export EVAL_IOS_PREREQUISITE_REASON EVAL_IOS_PREREQUISITE_LOG
    return "$FAIL_RC"
  fi
  EVAL_DEVNAME='iPhone 17 Pro'; EVAL_DEV_UDID='NEW-UDID'; EVAL_IOS_RUNTIME_VERSION=26.5
  EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON='["26.5"]'
  export EVAL_DEVNAME EVAL_DEV_UDID EVAL_IOS_RUNTIME_VERSION EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON
}
eval::build_release_ios_app() {
  touch "$NATIVE_MARKER"
  EVAL_IOS_NATIVE_BUILD_OUTCOME=passed; EVAL_IOS_INSTALL_OUTCOME=passed
  export EVAL_IOS_NATIVE_BUILD_OUTCOME EVAL_IOS_INSTALL_OUTCOME
  return 0
}
eval::probe_snapshot() { return 0; }
eval::run_evaluator() {
  printf '%s\n' '{"status":"completed","expected_plan_count":1,"terminal_plan_count":1,"evaluator_errors":[],"score":1,"full_points":1,"macro_avg_pct":100,"micro_pct":100,"test_plans":[]}' >"$4"
  printf '%s\n' '<html></html>' >"${4%.json}.html"
}
eval::require_evaluator_result() { return 0; }
""",
            encoding="utf-8",
        )
        author_env.parent.mkdir(parents=True, exist_ok=True)
        author_env.write_text(
            f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=claude-code
AGENT_MODEL=sonnet
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
            encoding="utf-8",
        )
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / "package.json").write_text("{}", encoding="utf-8")
        fake_bin = root / "bin"
        fake_bin.mkdir()
        (fake_bin / "npx").write_text(
            "#!/usr/bin/env bash\nprintf '%s\\n' '{\"scheme\":\"fixture\",\"ios\":{\"bundleIdentifier\":\"com.example.fixture\"}}'\n",
            encoding="utf-8",
        )
        (fake_bin / "bun").write_text(
            """#!/usr/bin/env bash
set -eu
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--out' ]; then out="$2"; break; fi
  shift
done
[ -z "$out" ] || { mkdir -p "$(dirname "$out")"; printf '{}\n' > "$out"; }
""",
            encoding="utf-8",
        )
        (fake_bin / "npx").chmod(0o755)
        (fake_bin / "bun").chmod(0o755)
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{fake_bin}:{env['PATH']}",
                "AUTHOR_ENV": str(author_env),
                "FAIL_PREREQUISITE": prerequisite,
                "FAIL_RC": str(exit_code),
                "DEPENDENCY_MARKER": str(dependency_marker),
                "NATIVE_MARKER": str(native_marker),
            }
        )
        result = subprocess.run(
            ["bash", str(script)],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
        return result, manifest, dependency_marker, native_marker

    def test_spec_release_is_default_and_dev_client_remains_available(self) -> None:
        """Specification: evaluation supports both builds with a stable default.

        Oracle: release is the product-like path; development-client is an
        explicit debug path whose shared launcher container is preserved.
        Catches: defaulting replays to Metro or destructively clearing launcher state.
        """
        default = resolve_ios_app_mode()
        development = resolve_ios_app_mode("dev-client")

        self.assertEqual(default.returncode, 0, default.stderr)
        self.assertEqual(default.stdout, "release|unset")
        self.assertEqual(development.returncode, 0, development.stderr)
        self.assertEqual(development.stdout, "dev-client|0")

    def test_regression_missing_authored_artifact_is_a_failed_evaluation(self) -> None:
        """Regression: missing evaluator input must not produce a green EAS job.

        Oracle: the workflow contract requires a valid authored-app artifact
        before iOS evaluation can complete.
        Catches: diagnostic early exits that incorrectly return status zero.
        """
        env = os.environ.copy()
        env["AUTHOR_ENV"] = "/definitely-missing/author.env"

        result = subprocess.run(
            ["bash", str(SCRIPT)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing author.env", result.stdout)

    def assert_incomplete_author_is_a_diagnostic_without_evaluator_setup(
        self, author_detail: str | None
    ) -> None:
        """An author failure is final evidence, not an iOS build input.

        Oracle: the iOS artifact preserves the author's failed state while
        every iOS execution stage stays not_run, even without author detail.
        Catches: attempting evaluator setup/builds for a workspace from a
        failed authoring run, which hides the source failure behind noise.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "incomplete-author"
            script = root / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
            diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            author_env = root / "author-agent-metadata" / run_id / "author.env"
            workspace = root / "author-agent-workspace" / run_id
            manifest = root / "manifest.json"
            script.parent.mkdir(parents=True, exist_ok=True)
            collector.parent.mkdir(parents=True, exist_ok=True)
            stages.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SCRIPT, script)
            copy_ios_collector(collector)
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )
            stages.write_text(
                """eval::resolve_reasoning_effort() { printf '%s' "${1:-high}"; }
eval::fix_java_home() { :; }
eval::env_banner() { :; }
eval::stop_proxies() { :; }
eval::install_agent_device() { touch "$EVAL_SETUP_MARKER"; exit 73; }
""",
                encoding="utf-8",
            )
            author_env.parent.mkdir(parents=True, exist_ok=True)
            author_env.write_text(
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=claude-code
AGENT_MODEL=sonnet
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
                encoding="utf-8",
            )
            (workspace / "package.json").parent.mkdir(parents=True, exist_ok=True)
            (workspace / "package.json").write_text("{}", encoding="utf-8")
            manifest.write_text(
                json.dumps(
                    {
                        "run_id": run_id,
                        "build_health": {
                            "app_authored": {
                                "status": "failed",
                                "detail": author_detail,
                                "log": "author-agent-metadata/incomplete-author/logs/c-agent.log",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_bun = fake_bin / "bun"
            fake_bun.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
            fake_bun.chmod(0o755)
            setup_marker = root / "evaluator-setup-ran"
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "AUTHOR_ENV": str(author_env),
                    "EVAL_SETUP_MARKER": str(setup_marker),
                }
            )

            result = subprocess.run(
                ["bash", str(script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stderr)
            expected_reason = (
                f"authoring did not complete: {author_detail}"
                if author_detail
                else "authoring did not complete; skipping build/eval"
            )
            self.assertIn(expected_reason, result.stdout)
            self.assertFalse(setup_marker.exists())
            artifact_manifest = json.loads(
                (root / "ios-eval-report" / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                artifact_manifest["build_health"]["app_authored"],
                {
                    "status": "failed",
                    "detail": author_detail,
                    "log": "author-agent-metadata/incomplete-author/logs/c-agent.log",
                },
            )
            for stage in ("dependency_install", "native_build", "app_launch", "evaluation"):
                self.assertEqual(artifact_manifest["build_health"][stage]["status"], "not_run")

    def test_regression_incomplete_author_is_a_diagnostic_without_evaluator_setup(self) -> None:
        """An absent author detail must use the truthful generic early-failure reason."""
        self.assert_incomplete_author_is_a_diagnostic_without_evaluator_setup(None)

    def test_regression_incomplete_author_detail_is_preserved_in_diagnostic(self) -> None:
        """A reported author failure detail must be preserved in the early diagnostic."""
        self.assert_incomplete_author_is_a_diagnostic_without_evaluator_setup(
            "author agent exited 17 while generating the app"
        )

    def assert_legacy_author_reaches_evaluator_setup(self, *, root_manifest: bool) -> None:
        """A replay without an explicit author failure must retain its old behavior."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "legacy-author"
            script = root / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
            diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            if root_manifest:
                author_env = root / "author-agent-metadata" / run_id / "author.env"
                workspace = root / "author-agent-workspace" / run_id
            else:
                author_env = root / "eval-out" / run_id / "author.env"
                workspace = root / "agent-workspace" / run_id
            script.parent.mkdir(parents=True, exist_ok=True)
            collector.parent.mkdir(parents=True, exist_ok=True)
            stages.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SCRIPT, script)
            copy_ios_collector(collector)
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )
            stages.write_text(
                """eval::resolve_reasoning_effort() { printf '%s' "${1:-high}"; }
eval::fix_java_home() { :; }
eval::env_banner() { :; }
eval::stop_proxies() { :; }
eval::install_agent_device() { touch "$EVAL_SETUP_MARKER"; exit 73; }
""",
                encoding="utf-8",
            )
            author_env.parent.mkdir(parents=True, exist_ok=True)
            author_env.write_text(
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=claude-code
AGENT_MODEL=sonnet
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
                encoding="utf-8",
            )
            workspace.mkdir(parents=True, exist_ok=True)
            (workspace / "package.json").write_text("{}", encoding="utf-8")
            if root_manifest:
                (root / "manifest.json").write_text(
                    json.dumps(
                        {
                            "schema_version": 2,
                            "artifact_type": "authored-app",
                            "run_id": run_id,
                            "artifacts": {
                                "workspace": f"author-agent-workspace/{run_id}/",
                                "author_env": f"author-agent-metadata/{run_id}/author.env",
                            },
                        }
                    ),
                    encoding="utf-8",
                )
            setup_marker = root / "evaluator-setup-ran"
            env = os.environ.copy()
            env.update(
                {
                    "AUTHOR_ENV": str(author_env),
                    "AUTHORED_ARTIFACT_ROOT": str(root),
                    "EVAL_SETUP_MARKER": str(setup_marker),
                }
            )

            result = subprocess.run(
                ["bash", str(script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
            self.assertTrue(setup_marker.exists())
            self.assertNotIn("authoring did not complete", result.stdout)

    def test_legacy_root_manifest_without_build_health_remains_replayable(self) -> None:
        """A pre-build-health canonical manifest is not evidence of author failure.

        Catches: treating a missing app_authored status as an explicit failure
        and rejecting previously produced canonical authored-app artifacts.
        """
        self.assert_legacy_author_reaches_evaluator_setup(root_manifest=True)

    def test_v1_layout_without_root_manifest_remains_replayable(self) -> None:
        """The historical agent-workspace/eval-out layout still reaches setup.

        Catches: making the author gate require a canonical root manifest and
        breaking the replay layout explicitly supported by the entrypoint.
        """
        self.assert_legacy_author_reaches_evaluator_setup(root_manifest=False)

    def assert_toolchain_failure_stops_as_preflight(
        self,
        prerequisite: str,
        exit_code: int,
        expected_reason: str,
        expected_log: str,
    ) -> None:
        result, manifest, dependency_marker, native_marker = self.run_prerequisite_failure(
            prerequisite,
            exit_code,
        )

        self.assertEqual(result.returncode, exit_code, result.stdout + result.stderr)
        self.assertIn(expected_reason, result.stdout)
        self.assertFalse(dependency_marker.exists())
        self.assertFalse(native_marker.exists())
        for stage in ("dependency_install", "native_build", "app_launch", "evaluation"):
            self.assertEqual(manifest["build_health"][stage]["status"], "not_run")
        artifact = Path(result.args[1]).parents[4] / "ios-eval-report"
        self.assertTrue((artifact / expected_log).is_file())

    def test_agent_device_install_failure_stops_as_preflight_infrastructure(self) -> None:
        self.assert_toolchain_failure_stops_as_preflight(
            "agent-device",
            71,
            "evaluator toolchain setup failed: agent-device",
            "logs/s1-agent-device.log",
        )

    def test_maestro_install_failure_stops_as_preflight_infrastructure(self) -> None:
        self.assert_toolchain_failure_stops_as_preflight(
            "maestro",
            72,
            "evaluator toolchain setup failed: Maestro",
            "logs/s2-maestro.log",
        )

    def test_evaluator_dependency_failure_stops_as_preflight_infrastructure(self) -> None:
        self.assert_toolchain_failure_stops_as_preflight(
            "evaluator-dependencies",
            73,
            "evaluator toolchain setup failed: evaluator dependencies",
            "logs/s3-uv.log",
        )

    def test_runner_failure_with_no_selected_device_stops_before_native_build(self) -> None:
        result, manifest, dependency_marker, native_marker = self.run_prerequisite_failure(
            "simulator-runner",
            74,
        )

        self.assertEqual(result.returncode, 74, result.stdout + result.stderr)
        self.assertIn("evaluator ios-runner preparation failed; see logs/s4-runner.log", result.stdout)
        self.assertTrue(dependency_marker.exists())
        self.assertFalse(native_marker.exists())
        self.assertEqual(manifest["build_health"]["dependency_install"]["status"], "passed")
        for stage in ("native_build", "app_launch", "evaluation"):
            self.assertEqual(manifest["build_health"][stage]["status"], "not_run")

    def test_authored_build_commands_cannot_copy_ambient_credentials_into_artifact(self) -> None:
        """Malicious package/config/native commands must not inherit evaluator secrets."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "credential-boundary"
            script = root / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
            diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            identity = root / "eval_harness/utils/ios/normalize_ios_identity.mjs"
            author_env = root / "author-agent-metadata" / run_id / "author.env"
            workspace = root / "author-agent-workspace" / run_id
            artifact = root / "ios-eval-report"
            fake_bin = root / "bin"

            script.parent.mkdir(parents=True, exist_ok=True)
            collector.parent.mkdir(parents=True, exist_ok=True)
            stages.parent.mkdir(parents=True, exist_ok=True)
            identity.parent.mkdir(parents=True, exist_ok=True)
            fake_bin.mkdir()
            secret = "EVALUATOR_SECRET_SENTINEL_73f1"
            shutil.copy2(SCRIPT, script)
            copy_ios_collector(collector)
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )
            identity.write_text(
                """import fs from 'node:fs';
const [, , workspace, runId, configPath, adjustmentsPath] = process.argv;
fs.writeFileSync(adjustmentsPath, JSON.stringify({source:'evaluator', adjustments:[]}));
""",
                encoding="utf-8",
            )
            stages.write_text(
                f"""_EVAL_STAGES_DIR={APP_RUNTIME_SH.parent!s}
source {APP_RUNTIME_SH!s}
eval::gate() {{ return "$1"; }}
eval::resolve_reasoning_effort() {{ printf '%s' "${{1:-high}}"; }}
eval::fix_java_home() {{ :; }}
eval::env_banner() {{ :; }}
eval::stop_proxies() {{ :; }}
eval::install_agent_device() {{ :; }}
eval::install_maestro() {{ :; }}
eval::install_uv_and_evaluator() {{ :; }}
eval::launch_proxy() {{
  [ "$ANTHROPIC_API_KEY" = {secret!r} ] || exit 90
  [ "$EXPECTED_EVALUATOR_SECRET" = {secret!r} ] || exit 91
}}
eval::wait_for_port() {{ return 0; }}
eval::launch_otlp_receiver() {{ :; }}
eval::boot_sim_and_runner() {{
  EVAL_DEVNAME='iPhone 17 Pro'; EVAL_DEV_UDID='SELECTED-UDID'; EVAL_IOS_RUNTIME_VERSION=26.5
  EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON='["26.5"]'
  export EVAL_DEVNAME EVAL_DEV_UDID EVAL_IOS_RUNTIME_VERSION EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON
}}
eval::probe_snapshot() {{ return 0; }}
eval::run_evaluator() {{
  [ "$CLAUDE_CODE_OAUTH_TOKEN" = {secret!r} ] || return 92
  [ "$BRAINTRUST_API_KEY" = {secret!r} ] || return 93
  [ "$EXPECTED_EVALUATOR_SECRET" = {secret!r} ] || return 94
  printf '%s\n' '{{"status":"completed","expected_plan_count":1,"terminal_plan_count":1,"evaluator_errors":[],"score":1,"full_points":1,"macro_avg_pct":100,"micro_pct":100,"test_plans":[]}}' >"$4"
  printf '%s\n' '<html></html>' >"${{4%.json}}.html"
}}
eval::require_evaluator_result() {{ return 0; }}
sleep() {{ :; }}
""",
                encoding="utf-8",
            )
            author_env.parent.mkdir(parents=True, exist_ok=True)
            author_env.write_text(
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=claude-code
AGENT_MODEL=sonnet
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
                encoding="utf-8",
            )
            workspace.mkdir(parents=True, exist_ok=True)
            (workspace / "package.json").write_text("{}", encoding="utf-8")

            (fake_bin / "npm").write_text(
                f"""#!/usr/bin/env bash
env | sort
mkdir -p "{artifact!s}/telemetry"
env | sort >"{artifact!s}/telemetry/authored-npm.txt"
""",
                encoding="utf-8",
            )
            (fake_bin / "npx").write_text(
                f"""#!/usr/bin/env bash
env | sort >&2
mkdir -p "{artifact!s}/telemetry"
env | sort >"{artifact!s}/telemetry/authored-expo.txt"
if [[ "$*" = *"expo config --json" ]]; then
  printf '%s\\n' '{{"scheme":"fixture","ios":{{"bundleIdentifier":"com.example.fixture"}}}}'
elif [ "$*" = "expo run:ios --help" ]; then
  printf '%s\\n' 'Usage: expo run:ios [options]' '  --output <dir>'
fi
""",
                encoding="utf-8",
            )
            (fake_bin / "bun").write_text(
                f"""#!/usr/bin/env bash
set -eu
trace_out=''; build_out=''; previous=''
for argument in "$@"; do
  [ "$previous" != '--out' ] || trace_out="$argument"
  [ "$previous" != '--output' ] || build_out="$argument"
  previous="$argument"
done
if [ -n "$trace_out" ]; then
  mkdir -p "$(dirname "$trace_out")"
  printf '%s\\n' '{{"n_sessions":0,"sessions":[]}}' >"$trace_out"
fi
if [ -n "$build_out" ]; then
  env | sort
  mkdir -p "{artifact!s}/telemetry"
  env | sort >"{artifact!s}/telemetry/authored-native.txt"
  mkdir -p "$build_out/Fixture.app"
  printf '%s\\n' '<?xml version="1.0"?><plist version="1.0"><dict><key>MinimumOSVersion</key><string>26.0</string></dict></plist>' >"$build_out/Fixture.app/Info.plist"
fi
""",
                encoding="utf-8",
            )
            (fake_bin / "agent-device").write_text(
                "#!/usr/bin/env bash\nexit 0\n",
                encoding="utf-8",
            )
            for executable_path in fake_bin.iterdir():
                executable_path.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "AUTHOR_ENV": str(author_env),
                    "EXPECTED_EVALUATOR_SECRET": secret,
                    "EXPO_PUBLIC_API_KEY": "public-build-marker",
                    "CLAUDE_CODE_OAUTH_TOKEN": secret,
                    "ANTHROPIC_API_KEY": secret,
                    "BRAINTRUST_API_KEY": secret,
                    "NPM_TOKEN": secret,
                    "SENTRY_AUTH_TOKEN": secret,
                    "GITHUB_TOKEN": secret,
                    "FUTURE_VENDOR_SECRET": secret,
                    "DATABASE_URL": secret,
                    "REDIS_URL": secret,
                    "MONGODB_URI": secret,
                    "AZURE_STORAGE_CONNECTION_STRING": secret,
                    "SENTRY_DSN": secret,
                    "OPAQUE_VENDOR_VALUE": secret,
                    "DATABASE_PASSWORD": secret,
                    "SIGNING_PRIVATE_MATERIAL": secret,
                    "GOOGLE_APPLICATION_CREDENTIALS": secret,
                    "GCS_BUCKET": secret,
                }
            )
            result = subprocess.run(
                ["bash", str(script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            retained = "\n".join(
                path.read_text(encoding="utf-8", errors="ignore")
                for path in artifact.rglob("*")
                if path.is_file()
            )
            self.assertNotIn(secret, retained)
            for sensitive_name in (
                "NPM_TOKEN",
                "SENTRY_AUTH_TOKEN",
                "GITHUB_TOKEN",
                "FUTURE_VENDOR_SECRET",
                "EXPECTED_EVALUATOR_SECRET",
                "DATABASE_URL",
                "REDIS_URL",
                "MONGODB_URI",
                "AZURE_STORAGE_CONNECTION_STRING",
                "SENTRY_DSN",
                "OPAQUE_VENDOR_VALUE",
            ):
                self.assertNotIn(f"{sensitive_name}=", retained)
            self.assertIn("CI=1", retained)
            self.assertIn("public-build-marker", retained)

    def test_dev_client_dependency_install_uses_authored_credential_boundary(self) -> None:
        """Dev-client provisioning can execute package hooks and must be scrubbed."""
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn(
            'eval::run_authored npx --yes expo install expo-dev-client',
            source,
        )

    def test_spec_completed_result_requires_numeric_score_fields(self) -> None:
        """Specification: a green evaluation contains a usable score artifact.

        Oracle: the documented result contract consumed by collaborators.
        Catches: status-zero evaluator exits with missing or diagnostic JSON.
        """
        valid = validate_result(
            '{"status":"completed","expected_plan_count":1,'
            '"terminal_plan_count":1,"evaluator_errors":[],'
            '"score":5,"full_points":10,"macro_avg_pct":50.0}',
        )
        missing = validate_result(None)
        incomplete = validate_result('{"status": "diagnostic"}')

        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertNotEqual(missing.returncode, 0)
        self.assertNotEqual(incomplete.returncode, 0)

    def test_regression_incomplete_subset_is_a_failed_eas_result(self) -> None:
        """Regression: partial plan output cannot satisfy the EAS success gate.

        Oracle: every expected plan must terminate without evaluator errors.
        Catches: accepting numeric aggregate fields from a partially run suite.
        """
        partial = validate_result(
            '{"status":"incomplete","expected_plan_count":2,'
            '"terminal_plan_count":2,"evaluator_errors":['
            '{"test_plan":"test_delete.txt","stage":"restart"}],'
            '"score":3,"full_points":3,"macro_avg_pct":100.0}',
        )

        self.assertNotEqual(partial.returncode, 0)
        self.assertIn("incomplete", partial.stdout)

    def test_runtime_gap_is_collected_as_unsupported_without_behavioral_score(self) -> None:
        """A newer deployment target is evaluator capacity, not authored build quality.

        Catches: collapsing a successful compile plus incompatible simulator
        into native_build=failed or a fabricated zero behavioral score.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "runtime-gap"
            script = root / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
            diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            identity = root / "eval_harness/utils/ios/normalize_ios_identity.mjs"
            author_env = root / "author-agent-metadata" / run_id / "author.env"
            workspace = root / "author-agent-workspace" / run_id
            artifact = root / "ios-eval-report"
            script.parent.mkdir(parents=True, exist_ok=True)
            collector.parent.mkdir(parents=True, exist_ok=True)
            stages.parent.mkdir(parents=True, exist_ok=True)
            identity.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SCRIPT, script)
            copy_ios_collector(collector)
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )
            identity.write_text(
                """import fs from 'node:fs';
const [, , workspace, runId, configPath, adjustmentsPath] = process.argv;
fs.writeFileSync(adjustmentsPath, JSON.stringify({source:'evaluator', adjustments:[]}));
""",
                encoding="utf-8",
            )
            stages.write_text(
                """eval::resolve_reasoning_effort() { printf '%s' "${1:-high}"; }
eval::fix_java_home() { :; }
eval::env_banner() { :; }
eval::stop_proxies() { :; }
eval::install_agent_device() { :; }
eval::install_maestro() { :; }
eval::install_uv_and_evaluator() { :; }
eval::launch_proxy() { :; }
eval::wait_for_port() { return 0; }
eval::launch_otlp_receiver() { :; }
eval::run_authored() { "$@"; }
eval::npm_install() { return 0; }
eval::configure_ios_app_mode() { EVAL_IOS_APP_MODE=release; export EVAL_IOS_APP_MODE; }
eval::boot_sim_and_runner() {
  EVAL_DEVNAME='iPhone 17 Pro'; EVAL_DEV_UDID='NEW-UDID'; EVAL_IOS_RUNTIME_VERSION=26.5
  EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON='["26.5", "18.6"]'
  export EVAL_DEVNAME EVAL_DEV_UDID EVAL_IOS_RUNTIME_VERSION EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON
}
eval::build_release_ios_app() {
  EVAL_IOS_NATIVE_BUILD_OUTCOME=passed
  EVAL_IOS_INSTALL_OUTCOME=warning
  EVAL_IOS_RESULT_STATUS=unsupported_environment
  EVAL_IOS_REQUIRED_VERSION=27.0
  EVAL_IOS_FAILURE_REASON='authored app requires iOS 27.0; available iOS simulator runtimes: 26.5, 18.6'
  export EVAL_IOS_NATIVE_BUILD_OUTCOME EVAL_IOS_INSTALL_OUTCOME EVAL_IOS_RESULT_STATUS EVAL_IOS_REQUIRED_VERSION EVAL_IOS_FAILURE_REASON
  return 42
}
""",
                encoding="utf-8",
            )
            author_env.parent.mkdir(parents=True, exist_ok=True)
            author_env.write_text(
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=codex
AGENT_MODEL=gpt-5.6-sol
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/pool/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
                encoding="utf-8",
            )
            workspace.mkdir(parents=True, exist_ok=True)
            (workspace / "package.json").write_text("{}", encoding="utf-8")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_bun = fake_bin / "bun"
            fake_bun.write_text(
                """#!/usr/bin/env bash
set -eu
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--out' ]; then out="$2"; break; fi
  shift
done
[ -z "$out" ] || { mkdir -p "$(dirname "$out")"; printf '{}\n' > "$out"; }
""",
                encoding="utf-8",
            )
            fake_npx = fake_bin / "npx"
            fake_npx.write_text(
                "#!/usr/bin/env bash\nprintf '%s\\n' '{\"scheme\":\"fixture\",\"ios\":{\"bundleIdentifier\":\"com.example.fixture\"}}'\n",
                encoding="utf-8",
            )
            fake_bun.chmod(0o755)
            fake_npx.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {"PATH": f"{fake_bin}:{env['PATH']}", "AUTHOR_ENV": str(author_env)}
            )

            result = subprocess.run(
                ["bash", str(script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
            payload = json.loads((artifact / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "unsupported_environment")
            self.assertIsNone(payload["macro_avg_pct"])
            self.assertEqual(payload["evaluator_errors"], [])
            self.assertEqual(
                payload["environment"],
                {"required_ios": "27.0", "available_ios": ["26.5", "18.6"]},
            )
            manifest = json.loads(
                (artifact / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["build_health"]["native_build"]["status"], "passed")
            self.assertEqual(manifest["build_health"]["app_launch"]["status"], "warning")
            self.assertEqual(
                manifest["build_health"]["app_launch"]["log"],
                "logs/s6-release.log",
            )
            self.assertEqual(manifest["build_health"]["evaluation"]["status"], "not_run")


if __name__ == "__main__":
    unittest.main()
