import json
import tempfile
import unittest
from pathlib import Path

from eval_harness.evaluator.ios_agentic.core.scoring import (
    AssertionResult,
    SoftAssertionResult,
    StepResult,
    TestPlanResult,
)
from eval_harness.evaluator.ios_agentic.main import (
    _build_parser,
    _build_suite_output,
    _run_suite,
    _serialize_plan_result,
)


def completed_plan(score: int = 3, full_points: int = 3) -> TestPlanResult:
    return TestPlanResult(
        score=score,
        full_points=full_points,
        status="completed",
        steps=[
            StepResult(
                name="step_0",
                max_points=full_points,
                earned_points=score,
                passed=score == full_points,
                iterations_used=4,
                completed_by_llm=True,
            )
        ],
    )


class SuiteOutputTests(unittest.TestCase):
    def test_spec_plan_serialization_preserves_assertion_and_screenshot_evidence(self) -> None:
        """Specification: public results retain evidence needed for postmortems.

        Oracle: commands/checks, fatality, outcomes, soft evidence, screenshot,
        and compatibility counts all survive serialization.
        Catches: reducing assertions back to opaque integer counts.
        """
        result = TestPlanResult(
            score=0,
            full_points=3,
            status="completed",
            steps=[
                StepResult(
                    name="delete note",
                    max_points=3,
                    earned_points=0,
                    passed=False,
                    assertions=[
                        AssertionResult(
                            "assert_visible: note-title",
                            fatal=True,
                            passed=False,
                        )
                    ],
                    soft_assertions=[
                        SoftAssertionResult(
                            "destructive action is clearly communicated",
                            fatal=False,
                            passed=False,
                            evidence="Delete label absent from the latest accessibility tree",
                        )
                    ],
                    screenshot_path="screenshots/step-01-final.png",
                    screenshot_error=None,
                )
            ],
        )

        record = _serialize_plan_result(Path("test_delete.txt"), 1, result)
        step = record["steps"][0]

        self.assertEqual(
            step["hard_assertions"],
            [{"command": "assert_visible: note-title", "fatal": True, "passed": False}],
        )
        self.assertEqual(
            step["soft_assertions"],
            [
                {
                    "check": "destructive action is clearly communicated",
                    "fatal": False,
                    "passed": False,
                    "evidence": "Delete label absent from the latest accessibility tree",
                }
            ],
        )
        self.assertEqual(step["hard_assertion_count"], 1)
        self.assertEqual(step["soft_assertion_count"], 1)
        self.assertEqual(step["screenshot"], "screenshots/step-01-final.png")
        self.assertIsNone(step["screenshot_error"])

    def test_spec_completed_and_not_applicable_plans_complete_the_suite(self) -> None:
        """Specification: N/A is a legitimate terminal plan outcome.

        Oracle: N/A plans are excluded from score denominators but satisfy the
        expected-plan completeness contract.
        Catches: treating N/A as missing work or adding its points to totals.
        """
        records = [
            {
                "test_plan": "test_insert.txt",
                "run_index": 1,
                "status": "completed",
                "score": 3,
                "full_points": 3,
                "macro_pct": 100.0,
                "steps": [],
            },
            {
                "test_plan": "test_pull_to_refresh.txt",
                "run_index": 1,
                "status": "not_applicable",
                "na_reason": "no refreshable collection",
                "score": 0,
                "full_points": 0,
                "macro_pct": None,
                "steps": [],
            },
        ]

        output = _build_suite_output(records, expected_plan_count=2)

        self.assertEqual(output["status"], "completed")
        self.assertEqual(output["expected_plan_count"], 2)
        self.assertEqual(output["terminal_plan_count"], 2)
        self.assertEqual(output["score"], 3)
        self.assertEqual(output["full_points"], 3)
        self.assertEqual(output["n_not_applicable"], 1)
        self.assertEqual(output["evaluator_errors"], [])

    def test_spec_any_evaluator_error_makes_suite_incomplete_and_is_not_scored(self) -> None:
        """Specification: evaluator faults cannot become app-score zeros.

        Oracle: only completed plan judgments contribute to app scoring.
        Catches: empty restart/SDK failures reducing the app score in a green job.
        """
        records = [
            {
                "test_plan": "test_insert.txt",
                "run_index": 1,
                "status": "completed",
                "score": 3,
                "full_points": 3,
                "macro_pct": 100.0,
                "steps": [],
            },
            {
                "test_plan": "test_delete.txt",
                "run_index": 1,
                "status": "evaluator_error",
                "error_stage": "restart",
                "error_reason": "launcher never reached authored app",
                "score": None,
                "full_points": None,
                "macro_pct": None,
                "steps": [],
            },
        ]

        output = _build_suite_output(records, expected_plan_count=2)

        self.assertEqual(output["status"], "incomplete")
        self.assertEqual(output["terminal_plan_count"], 2)
        self.assertEqual(output["score"], 3)
        self.assertEqual(output["full_points"], 3)
        self.assertEqual(
            output["evaluator_errors"],
            [
                {
                    "test_plan": "test_delete.txt",
                    "run_index": 1,
                    "stage": "restart",
                    "reason": "launcher never reached authored app",
                }
            ],
        )


class CliArgumentTests(unittest.TestCase):
    def test_parses_evaluator_model_and_reasoning_effort(self) -> None:
        args = _build_parser().parse_args(
            [
                "--prd",
                "dataset/prds/notes/prd/mvp.txt",
                "--model",
                "claude-opus-4-8",
                "--reasoning-effort",
                "high",
            ]
        )

        self.assertEqual(args.model, "claude-opus-4-8")
        self.assertEqual(args.reasoning_effort, "high")


class RecordingBridge:
    def __init__(self) -> None:
        self.cleanup_calls = 0

    def cleanup(self) -> None:
        self.cleanup_calls += 1


class CompleteThenRaiseEvaluator:
    def __init__(self) -> None:
        self.calls = 0
        self.bridge = RecordingBridge()

    def evaluate_test_plan(self, plan_path: Path) -> TestPlanResult:
        self.calls += 1
        if self.calls == 1:
            return completed_plan()
        raise RuntimeError("SDK stream disconnected")


class SuiteCheckpointTests(unittest.TestCase):
    def test_regression_checkpoint_survives_later_plan_exception_and_cleanup_runs(self) -> None:
        """Regression: later infrastructure failure preserves earlier evidence.

        Oracle: each terminal plan is a durable checkpoint and owned bridge
        resources are always cleaned up.
        Catches: one final write after the loop and cleanup only on the happy path.
        """
        evaluator = CompleteThenRaiseEvaluator()

        with tempfile.TemporaryDirectory() as td:
            output_path = Path(td) / "result.json"
            output, exit_code = _run_suite(
                evaluator=evaluator,
                test_plans=[Path("test_insert.txt"), Path("test_delete.txt")],
                repeat=1,
                output_path=output_path,
            )
            on_disk = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 1)
        self.assertEqual(output["status"], "incomplete")
        self.assertEqual(on_disk, output)
        self.assertEqual(
            [plan["status"] for plan in on_disk["test_plans"]],
            ["completed", "evaluator_error"],
        )
        self.assertEqual(on_disk["test_plans"][1]["error_stage"], "unexpected_exception")
        self.assertEqual(on_disk["test_plans"][1]["error_reason"], "SDK stream disconnected")
        self.assertEqual(evaluator.bridge.cleanup_calls, 1)


if __name__ == "__main__":
    unittest.main()
