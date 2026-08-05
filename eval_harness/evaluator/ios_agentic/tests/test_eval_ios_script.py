import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
EVALUATOR_SH = ROOT / "eval_harness/utils/shell/evaluator.sh"


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


class EvalIosScriptTests(unittest.TestCase):
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
            '{"score": 5, "full_points": 10, "macro_avg_pct": 50.0}',
        )
        missing = validate_result(None)
        incomplete = validate_result('{"status": "diagnostic"}')

        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertNotEqual(missing.returncode, 0)
        self.assertNotEqual(incomplete.returncode, 0)


if __name__ == "__main__":
    unittest.main()
