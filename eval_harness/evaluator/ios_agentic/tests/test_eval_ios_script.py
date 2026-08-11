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

    def test_regression_incomplete_author_is_a_diagnostic_without_evaluator_setup(self) -> None:
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
            shutil.copy2(
                ROOT / "eval_harness/utils/artifacts/collect_ios_artifact.sh",
                collector,
            )
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
                                "detail": None,
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
            self.assertIn("authoring did not complete; skipping build/eval", result.stdout)
            self.assertFalse(setup_marker.exists())
            artifact_manifest = json.loads(
                (root / "ios-eval-report" / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                artifact_manifest["build_health"]["app_authored"],
                {
                    "status": "failed",
                    "detail": None,
                    "log": "author-agent-metadata/incomplete-author/logs/c-agent.log",
                },
            )
            for stage in ("dependency_install", "native_build", "app_launch", "evaluation"):
                self.assertEqual(artifact_manifest["build_health"][stage]["status"], "not_run")

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


if __name__ == "__main__":
    unittest.main()
