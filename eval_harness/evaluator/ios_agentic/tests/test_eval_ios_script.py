import os
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
