import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
SANITIZER = ROOT / "eval_harness/utils/artifacts/sanitize_ios_artifact.py"
EVAL_SCRIPT = ROOT / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"


def write(path: Path, contents: str = "fixture") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


class IosArtifactTests(unittest.TestCase):
    def test_collector_recreates_trace_log_without_mutating_linked_targets(self) -> None:
        """Collector-owned redirections must never truncate an outside inode."""
        for link_kind in ("symlink", "hardlink"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                run_id = f"unsafe-trace-log-{link_kind}"
                artifact = root / "ios-eval-report"
                outside = root / "outside"
                outside_log = outside / "collector.log"
                outside_manifest = outside / "manifest.json"
                write(outside_log, "outside must remain unchanged\n")
                write(outside_manifest, '{"outside":true}\n')
                artifact.mkdir(parents=True)
                if link_kind == "symlink":
                    (artifact / "collect-evaluator-trace.log").symlink_to(outside_log)
                    (artifact / "manifest.json").symlink_to(outside_manifest)
                else:
                    os.link(outside_log, artifact / "collect-evaluator-trace.log")
                    os.link(outside_manifest, artifact / "manifest.json")

                diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
                diagnostic.parent.mkdir(parents=True)
                shutil.copy2(
                    ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                    diagnostic,
                )
                fake_bin = root / "bin"
                write(
                    fake_bin / "bun",
                    """#!/usr/bin/env bash
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; break; fi
  shift
done
mkdir -p "$(dirname "$out")"
printf '%s\n' '{"n_sessions":0,"sessions":[]}' > "$out"
printf '%s\n' 'fresh collector trace log'
""",
                )
                (fake_bin / "bun").chmod(0o755)
                env = os.environ.copy()
                env.update({"PATH": f"{fake_bin}:{env['PATH']}", "RUN_START_MTIME": "0"})

                result = subprocess.run(
                    ["bash", str(COLLECTOR), str(root), run_id, str(artifact)],
                    cwd=ROOT,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=10,
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    outside_log.read_text(encoding="utf-8"),
                    "outside must remain unchanged\n",
                )
                self.assertEqual(
                    outside_manifest.read_text(encoding="utf-8"),
                    '{"outside":true}\n',
                )
                retained = artifact / "logs" / "collect-evaluator-trace.log"
                self.assertEqual(
                    retained.read_text(encoding="utf-8"),
                    "fresh collector trace log\n",
                )
                self.assertFalse(retained.is_symlink())
                self.assertEqual(retained.stat().st_nlink, 1)

    def test_collector_does_not_follow_or_publish_unsafe_evidence_nodes(self) -> None:
        """Linked/special evidence cannot escape or contaminate the producer root.

        Catches: trusting an allowed basename while following a symlinked
        evidence directory, archiving hardlinked secret bytes, or retaining a
        FIFO that can hang a later reader.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "unsafe-evidence-nodes"
            artifact = root / "ios-eval-report"
            outside = root / "outside"
            external_traces = outside / "traces"
            secret = "CREDENTIAL_SENTINEL_ae84f1"
            artifact.mkdir(parents=True)
            diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
            diagnostic.parent.mkdir(parents=True)
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )

            write(outside / "result.json", '{"status":"completed","macro_avg_pct":100}')
            os.link(outside / "result.json", artifact / "result.json")
            write(outside / "report.html", "outside report")
            (artifact / "report.html").symlink_to(outside / "report.html")
            write(external_traces / "do-not-touch.txt", secret)
            (artifact / "traces").parent.mkdir(parents=True, exist_ok=True)
            (artifact / "traces").symlink_to(external_traces, target_is_directory=True)

            write(outside / "evaluator.log", secret)
            os.link(outside / "evaluator.log", artifact / "s7-eval.log")
            write(outside / "anthropic.jsonl", secret)
            (artifact / "telemetry").mkdir()
            os.link(
                outside / "anthropic.jsonl",
                artifact / "telemetry" / "anthropic.jsonl",
            )
            write(artifact / "telemetry" / "otel" / "index.jsonl", "{}\n")
            write(artifact / "telemetry" / "otel" / "credential-dump.txt", secret)
            os.mkfifo(artifact / "telemetry" / "unsafe.fifo")
            (artifact / "telemetry" / "unsafe-link").symlink_to(
                outside / "report.html"
            )

            fake_bin = root / "bin"
            fake_bun = fake_bin / "bun"
            write(
                fake_bun,
                """#!/usr/bin/env bash
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; break; fi
  shift
done
mkdir -p "$(dirname "$out")"
printf '%s\n' '{"n_sessions":0,"sessions":[]}' > "$out"
""",
            )
            fake_bun.chmod(0o755)

            env = os.environ.copy()
            env.update({"PATH": f"{fake_bin}:{env['PATH']}", "RUN_START_MTIME": "0"})
            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), run_id, str(artifact)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (external_traces / "do-not-touch.txt").read_text(encoding="utf-8"),
                secret,
            )
            self.assertEqual(
                sorted(path.name for path in external_traces.iterdir()),
                ["do-not-touch.txt"],
            )
            self.assertEqual(
                (outside / "result.json").read_text(encoding="utf-8"),
                '{"status":"completed","macro_avg_pct":100}',
            )
            self.assertEqual(
                (outside / "report.html").read_text(encoding="utf-8"),
                "outside report",
            )
            for required_dir in ("traces", "telemetry", "logs"):
                path = artifact / required_dir
                self.assertTrue(path.is_dir(), required_dir)
                self.assertFalse(path.is_symlink(), required_dir)
            for required_file in ("result.json", "report.html"):
                path = artifact / required_file
                self.assertTrue(path.is_file(), required_file)
                self.assertFalse(path.is_symlink(), required_file)
                self.assertEqual(path.stat().st_nlink, 1, required_file)
            for path in artifact.rglob("*"):
                self.assertFalse(path.is_symlink(), str(path))
                if path.is_file():
                    self.assertEqual(path.stat().st_nlink, 1, str(path))
                    self.assertNotIn(secret, path.read_bytes().decode("utf-8", "ignore"))
                else:
                    self.assertTrue(path.is_dir(), str(path))

            payload = json.loads((artifact / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "failed")
            self.assertFalse((artifact / "telemetry" / "otel" / "credential-dump.txt").exists())
            self.assertFalse((artifact / "telemetry" / "unsafe.fifo").exists())
            self.assertFalse((artifact / "logs" / "s7-eval.log").exists())

    def test_collector_enforces_canonical_inventory_without_config_or_device_secrets(self) -> None:
        """Only safe, evaluator-owned evidence may cross the iOS artifact boundary."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "canonical-inventory"
            artifact = root / "ios-eval-report"
            secret = "CONFIG_SECRET_SENTINEL_9d34c2"

            write(artifact / "result.json", '{"status":"failed","macro_avg_pct":null}')
            write(artifact / "result.html", "<html>report</html>")
            write(artifact / "s7-eval.log", "evaluator log")
            write(artifact / "d-expo-config.err", "Expo config diagnostic\n")
            write(artifact / "s4-simctl-devices.err", "simctl diagnostic\n")
            write(
                artifact / "d-ios-identity-adjustments.json",
                '{"source":"evaluator","adjustments":[]}',
            )
            write(artifact / "telemetry" / "anthropic.jsonl", "{}\n")
            write(artifact / "telemetry" / "otel" / "index.jsonl", "{}\n")

            # These files are necessary while evaluating, but are unsafe or
            # unbounded scratch and must never enter the producer artifact.
            write(
                artifact / "d-expo-config.json",
                json.dumps({"extra": {"apiKey": secret}}),
            )
            write(
                artifact / "d-expo-config.normalized.json",
                json.dumps({"extra": {"apiKey": secret}}),
            )
            write(
                artifact / "s4-simctl-devices.json",
                json.dumps({"devices": [{"name": secret}]}),
            )
            write(artifact / "unrecognized-secret.log", secret)
            write(artifact / "logs" / "stale-secret.json", secret)
            write(artifact / "scratch" / "resolved-environment.txt", secret)

            fake_bin = root / "bin"
            fake_bun = fake_bin / "bun"
            write(
                fake_bun,
                """#!/usr/bin/env bash
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; break; fi
  shift
done
mkdir -p "$(dirname "$out")"
printf '%s\n' '{"n_sessions":0,"sessions":[]}' > "$out"
""",
            )
            fake_bun.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "RUN_START_MTIME": "0",
                    "IOS_NATIVE_BUILD_STATUS": "failed",
                    "IOS_NATIVE_BUILD_LOG": "logs/d-expo-config.err",
                    "IOS_FAILURE_STAGE": "native_build",
                    "IOS_FAILURE_REASON": "Expo config could not be resolved",
                    "EVAL_IOS_RUNTIME_VERSION": "26.5",
                    "IOS_REQUIRED_VERSION": "27.0",
                    "EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON": '["18.6","26.5"]',
                }
            )
            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), run_id, str(artifact)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                sorted(path.name for path in artifact.iterdir()),
                ["logs", "manifest.json", "report.html", "result.json", "telemetry", "traces"],
            )
            self.assertEqual(
                sorted(
                    str(path.relative_to(artifact))
                    for path in artifact.rglob("*")
                    if path.is_file()
                ),
                [
                    "logs/collect-evaluator-trace.log",
                    "logs/d-expo-config.err",
                    "logs/d-ios-identity-adjustments.json",
                    "logs/s4-simctl-devices.err",
                    "logs/s7-eval.log",
                    "manifest.json",
                    "report.html",
                    "result.json",
                    "telemetry/anthropic.jsonl",
                    "telemetry/otel/index.jsonl",
                    "traces/agentic-evaluator.json",
                ],
            )
            for path in artifact.rglob("*"):
                if path.is_file():
                    self.assertNotIn(secret, path.read_text(encoding="utf-8"), str(path))

            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            native_build = manifest["build_health"]["native_build"]
            self.assertEqual(native_build["log"], "logs/d-expo-config.err")
            self.assertTrue((artifact / native_build["log"]).is_file())
            self.assertEqual(manifest["environment"]["selected_ios"], "26.5")
            self.assertEqual(manifest["environment"]["required_ios"], "27.0")
            self.assertEqual(manifest["environment"]["available_ios"], ["18.6", "26.5"])
            self.assertEqual(
                manifest["artifacts"]["identity_adjustments"],
                "logs/d-ios-identity-adjustments.json",
            )

    def test_canonical_report_has_one_copy_of_evaluator_owned_evidence(self) -> None:
        """The iOS producer must not retain author evidence or duplicate its own output."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "ios_20260810"
            artifact = root / "ios-eval-report"
            author_manifest = root / "authored-app" / "manifest.json"
            plan_traces = root / "evaluator-traces"
            plan_run = plan_traces / "test_insert_20260810"

            write(
                artifact / "result.json",
                '{"status":"completed","score":1,"full_points":1,"macro_avg_pct":100}',
            )
            write(artifact / "result.html", "<html>report</html>")
            write(artifact / "s7-eval.log", "evaluator log")
            write(artifact / "telemetry" / "anthropic.jsonl", "{}\n")
            write(artifact / "telemetry" / "otel" / "index.jsonl", "{}\n")
            write(
                artifact / "telemetry" / "traces" / "claude-code-authoring.json",
                '{"n_sessions":1}',
            )
            write(plan_run / "summary.json", "{}")
            write(plan_run / "conversation.jsonl", "{}\n")
            write(plan_run / "console.log", "trace log")
            write(plan_run / "screenshots" / "step-01-final.png", "png")
            write(
                author_manifest,
                json.dumps(
                    {
                        "build_health": {
                            "app_authored": {
                                "status": "passed",
                                "detail": None,
                                "log": f"author-agent-metadata/{run_id}/logs/c-agent.log",
                            },
                            "expo_export": {
                                "status": "warning",
                                "detail": None,
                                "log": f"author-agent-metadata/{run_id}/logs/d-expo-export.log",
                            },
                        }
                    }
                ),
            )

            fake_bin = root / "bin"
            fake_bun = fake_bin / "bun"
            write(
                fake_bun,
                """#!/usr/bin/env bash
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; break; fi
  shift
done
mkdir -p "$(dirname "$out")"
printf '%s\n' '{"n_sessions":1,"sessions":[]}' > "$out"
""",
            )
            fake_bun.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "RUN_START_MTIME": "0",
                    "TRACE_SINCE_MTIME": "0",
                    "EVALUATOR_TRACES_ROOT": str(plan_traces),
                    "EVALUATOR_MODEL": "claude-opus-4-8",
                    "EVALUATOR_REASONING_EFFORT": "high",
                    "IOS_DEPENDENCY_INSTALL_STATUS": "passed",
                    "IOS_NATIVE_BUILD_STATUS": "passed",
                    "IOS_NATIVE_BUILD_LOG": "logs/s6-release.log",
                    "IOS_APP_LAUNCH_STATUS": "failed",
                    "IOS_EVALUATION_STATUS": "not_run",
                    "AUTHOR_MANIFEST": str(author_manifest),
                }
            )
            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), run_id, str(artifact)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((artifact / "manifest.json").is_file())
            self.assertTrue((artifact / "result.json").is_file())
            self.assertTrue((artifact / "report.html").is_file())
            self.assertTrue((artifact / "traces" / "agentic-evaluator.json").is_file())
            self.assertTrue(
                (
                    artifact
                    / "traces"
                    / "test-plans"
                    / "test_insert_20260810"
                    / "summary.json"
                ).is_file()
            )
            self.assertTrue((artifact / "logs" / "s7-eval.log").is_file())
            self.assertFalse((artifact / "result.html").exists())
            self.assertFalse((artifact / "s7-eval.log").exists())
            self.assertFalse((artifact / "bundle").exists())
            self.assertFalse((artifact / "author-agent-workspace").exists())
            self.assertFalse(any(artifact.rglob("claude-code-authoring.json")))
            self.assertFalse(any(artifact.rglob("*.tgz")))

            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["evaluator_model"], "claude-opus-4-8")
            self.assertEqual(manifest["evaluator_reasoning_effort"], "high")
            self.assertEqual(manifest["artifacts"]["result"], "result.json")
            self.assertEqual(manifest["artifacts"]["test_plan_traces"], "traces/test-plans/")
            self.assertEqual(manifest["build_health"]["dependency_install"]["status"], "passed")
            self.assertEqual(manifest["build_health"]["native_build"]["status"], "passed")
            self.assertEqual(manifest["build_health"]["app_launch"]["status"], "failed")
            self.assertEqual(manifest["build_health"]["evaluation"]["status"], "not_run")
            self.assertEqual(
                manifest["build_health"]["app_launch"]["log"], "logs/s6b-open.log"
            )
            self.assertIsNone(manifest["build_health"]["evaluation"]["detail"])
            self.assertEqual(manifest["build_health"]["app_authored"]["status"], "passed")
            self.assertEqual(manifest["build_health"]["expo_export"]["status"], "warning")

    def test_evaluator_phase_replaces_stale_output_with_an_early_failure_result(self) -> None:
        """A failed evaluator startup must publish this run's diagnostic, never stale data."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "stale-output"
            script = root / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
            diagnostic = root / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            author_env = root / "author-agent-metadata" / run_id / "author.env"
            workspace = root / "author-agent-workspace" / run_id
            artifact = root / "ios-eval-report"
            script.parent.mkdir(parents=True, exist_ok=True)
            collector.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(EVAL_SCRIPT, script)
            shutil.copy2(COLLECTOR, collector)
            shutil.copy2(SANITIZER, collector.with_name(SANITIZER.name))
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )
            write(
                stages,
                """eval::resolve_reasoning_effort() { printf '%s' "${1:-high}"; }
eval::fix_java_home() { :; }
eval::env_banner() { :; }
eval::stop_proxies() { :; }
eval::install_agent_device() { exit 23; }
""",
            )
            write(
                author_env,
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=claude-code
AGENT_MODEL=sonnet
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
            )
            write(workspace / "package.json", "{}")
            write(artifact / "result.json", '{"score":99,"full_points":99,"macro_avg_pct":100}')
            write(artifact / "report.html", "stale report")
            write(artifact / "traces" / "agentic-evaluator.json", "stale trace")
            write(artifact / "telemetry" / "anthropic.jsonl", "stale telemetry")
            fake_bin = root / "bin"
            write(fake_bin / "bun", "#!/usr/bin/env bash\nexit 1\n")
            (fake_bin / "bun").chmod(0o755)
            env = os.environ.copy()
            env.update({"PATH": f"{fake_bin}:{env['PATH']}", "AUTHOR_ENV": str(author_env)})

            result = subprocess.run(
                ["bash", str(script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 23, result.stderr)
            self.assertTrue((artifact / "result.json").is_file())
            self.assertTrue((artifact / "report.html").is_file())
            self.assertFalse((artifact / "traces" / "agentic-evaluator.json").exists())
            self.assertFalse((artifact / "telemetry" / "anthropic.jsonl").exists())
            payload = json.loads((artifact / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "failed")
            self.assertIsNone(payload["macro_avg_pct"])
            self.assertEqual(
                payload["evaluator_errors"],
                [
                    {
                        "stage": "preflight",
                        "reason": "iOS evaluator exited before producing result.json (exit status 23)",
                    }
                ],
            )
            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            self.assertIsNone(manifest["score"])
            self.assertEqual(manifest["build_health"]["dependency_install"]["status"], "not_run")
            self.assertEqual(manifest["build_health"]["native_build"]["status"], "not_run")
            self.assertEqual(manifest["build_health"]["app_launch"]["status"], "not_run")
            self.assertEqual(manifest["build_health"]["evaluation"]["status"], "not_run")

    def test_missing_expo_ios_config_receives_evaluator_identity_before_native_build(self) -> None:
        """A valid authored app without identity must progress with evaluator-owned values.

        Catches: treating bundle ID/scheme omissions as an author failure instead
        of a deterministic evaluator adjustment, or losing its diagnostics.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "missing-ios-config"
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
            identity.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(EVAL_SCRIPT, script)
            shutil.copy2(COLLECTOR, collector)
            shutil.copy2(SANITIZER, collector.with_name(SANITIZER.name))
            shutil.copy2(ROOT / "eval_harness/utils/ios/normalize_ios_identity.mjs", identity)
            harness_expo = root / "node_modules" / "@expo"
            harness_expo.mkdir(parents=True, exist_ok=True)
            (harness_expo / "require-utils").symlink_to(
                ROOT / "node_modules" / "@expo" / "require-utils",
                target_is_directory=True,
            )
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )
            write(
                stages,
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
eval::configure_ios_app_mode() { EVAL_IOS_APP_MODE=release; EVAL_DEVNAME='iPhone 16'; export EVAL_IOS_APP_MODE EVAL_DEVNAME; }
eval::boot_sim_and_runner() { :; }
eval::build_release_ios_app() { :; }
eval::probe_snapshot() { return 1; }
""",
            )
            write(
                author_env,
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=muse-code
AGENT_MODEL=muse-spark-1.2
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
            )
            write(workspace / "package.json", "{}")
            write(workspace / "app.json", '{"expo":{"scheme":"notes","ios":{}}}')
            fake_bin = root / "bin"
            write(
                fake_bin / "bun",
                """#!/usr/bin/env bash
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; break; fi
  shift
done
[ -z "$out" ] || { mkdir -p "$(dirname "$out")"; printf '{}\n' > "$out"; }
""",
            )
            write(
                fake_bin / "npx",
                """#!/usr/bin/env bash
node -e 'const fs = require("node:fs"); console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).expo));' "$PWD/app.json"
""",
            )
            (fake_bin / "bun").chmod(0o755)
            (fake_bin / "npx").chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "AUTHOR_ENV": str(author_env),
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

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            payload = json.loads((artifact / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["status"], "failed")
            self.assertIsNone(payload["macro_avg_pct"])
            self.assertEqual(
                payload["evaluator_errors"],
                [
                    {"stage": "app_launch", "reason": "authored app failed launch readiness probe; skipping evaluator"}
                ],
                result.stdout + result.stderr,
            )
            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["build_health"]["dependency_install"]["status"], "passed")
            self.assertEqual(manifest["build_health"]["native_build"]["status"], "passed")
            self.assertEqual(manifest["build_health"]["app_launch"]["status"], "failed")
            self.assertEqual(manifest["build_health"]["evaluation"]["status"], "not_run")
            self.assertEqual(
                manifest["artifacts"].get("identity_adjustments"),
                "logs/d-ios-identity-adjustments.json",
            )
            adjustment = json.loads(
                (artifact / "logs" / "d-ios-identity-adjustments.json").read_text(encoding="utf-8")
            )
            self.assertEqual(adjustment["source"], "evaluator")
            self.assertEqual(
                adjustment["adjustments"],
                [
                    {
                        "field": "ios.bundleIdentifier",
                        "from": None,
                        "to": "com.evalharness.6198f6327e24",
                    },
                ],
            )

    def test_failed_ios_identity_normalization_does_not_advertise_missing_adjustment_log(self) -> None:
        """A failed normalizer cannot create artifact evidence it never wrote.

        Catches: publishing `artifacts.identity_adjustments` based only on an
        exported intended path rather than the collected file.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "identity-normalization-failure"
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
            identity.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(EVAL_SCRIPT, script)
            shutil.copy2(COLLECTOR, collector)
            shutil.copy2(SANITIZER, collector.with_name(SANITIZER.name))
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py",
                diagnostic,
            )
            write(identity, "process.exit(19);\n")
            write(
                stages,
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
""",
            )
            write(
                author_env,
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=claude-code
AGENT_MODEL=sonnet
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
            )
            write(workspace / "package.json", "{}")
            fake_bin = root / "bin"
            write(fake_bin / "bun", "#!/usr/bin/env bash\nexit 1\n")
            write(fake_bin / "npx", "#!/usr/bin/env bash\nprintf '%s\\n' '{\"scheme\":\"notes\",\"ios\":{}}'\n")
            (fake_bin / "bun").chmod(0o755)
            (fake_bin / "npx").chmod(0o755)
            env = os.environ.copy()
            env.update({"PATH": f"{fake_bin}:{env['PATH']}", "AUTHOR_ENV": str(author_env)})

            result = subprocess.run(
                ["bash", str(script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["build_health"]["native_build"]["status"], "failed")
            self.assertEqual(
                manifest["build_health"]["native_build"]["detail"],
                "evaluator could not normalize the iOS app identity; see logs/d-ios-identity-normalize.log",
            )
            self.assertIsNone(manifest["artifacts"].get("identity_adjustments"))
            self.assertFalse((artifact / "logs" / "d-ios-identity-adjustments.json").exists())

    def test_collector_rejects_output_root_outside_repository(self) -> None:
        """The collector must not mutate an arbitrary caller-supplied directory."""
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            root = parent / "repository"
            outside = parent / "caller-owned"
            fake_bin = root / "bin"
            write(outside / "result.html", "keep")
            write(fake_bin / "bun", "#!/usr/bin/env bash\nexit 1\n")
            (fake_bin / "bun").chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"

            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), "path-escape", str(outside)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((outside / "result.html").read_text(encoding="utf-8"), "keep")

    def test_collector_reports_manifest_write_failure(self) -> None:
        """Manifest serialization is structural and must not fail open."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "ios-eval-report"
            fake_bin = root / "bin"
            artifact.mkdir(parents=True)
            write(
                fake_bin / "bun",
                """#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then mkdir -p "$(dirname "$2")"; printf '{}\n' > "$2"; exit; fi
  shift
done
""",
            )
            write(fake_bin / "python3", "#!/usr/bin/env bash\nexit 74\n")
            (fake_bin / "bun").chmod(0o755)
            (fake_bin / "python3").chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"

            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), "manifest-failure", str(artifact)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((artifact / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
