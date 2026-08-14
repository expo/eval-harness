import tempfile
import unittest
from pathlib import Path

from eval_harness.evaluator.ios_agentic.core.scoring import (
    AssertionResult,
    SoftAssertionResult,
    StepResult,
    TestPlanResult,
)
from eval_harness.evaluator.ios_agentic.main import _serialize_plan_result
from eval_harness.evaluator.ios_agentic.report import write_html_report


class WriteHtmlReportTests(unittest.TestCase):
    def _write(self, output: dict) -> str:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "result.html"
            write_html_report(output, path)
            return path.read_text(encoding="utf-8")

    def test_serialized_step_renders_counts_and_safe_evidence(self):
        """Regression: migrated assertion arrays remain compact and legible.

        Oracle: the public serializer's count fields drive the table while its
        assertion and screenshot fields render as escaped, structured evidence.
        Catches: escaping an entire Python list/dict repr into a count cell.
        """
        result = TestPlanResult(
            score=0,
            full_points=2,
            status="completed",
            steps=[
                StepResult(
                    name="unsafe <step>",
                    max_points=2,
                    earned_points=0,
                    passed=False,
                    assertions=[
                        AssertionResult(
                            "assert_visible: <script>alert(1)</script>",
                            fatal=True,
                            passed=False,
                        )
                    ],
                    soft_assertions=[
                        SoftAssertionResult(
                            "title contains <b>markup</b>",
                            fatal=False,
                            passed=True,
                            evidence="AT showed <img src=x onerror=alert(1)>",
                        )
                    ],
                    screenshot_path="screenshots/step-01-final.png",
                )
            ],
        )
        record = _serialize_plan_result(Path("test_render.txt"), 1, result)

        rendered = self._write({"test_overview": "x", "test_plans": [record]})

        self.assertEqual(rendered.count('<span class="assertion-count">1</span>'), 2)
        self.assertIn("assert_visible: &lt;script&gt;alert(1)&lt;/script&gt;", rendered)
        self.assertIn("title contains &lt;b&gt;markup&lt;/b&gt;", rendered)
        self.assertIn("AT showed &lt;img src=x onerror=alert(1)&gt;", rendered)
        self.assertIn("screenshots/step-01-final.png", rendered)
        self.assertNotIn("<script>alert(1)</script>", rendered)
        self.assertNotIn("[{&#x27;command&#x27;:", rendered)

    def test_evaluator_error_renders_prior_serialized_step_evidence(self):
        """Regression: evaluator errors do not hide completed-step evidence.

        Oracle: a plan failing at step two retains its serialized step-one row,
        assertion details, and screenshot alongside the plan error.
        Catches: the evaluator-error plan-row branch continuing before steps.
        """
        result = TestPlanResult(
            score=2,
            full_points=4,
            status="evaluator_error",
            error_stage="step_2",
            error_reason="driver disconnected",
            steps=[
                StepResult(
                    name="completed first step",
                    max_points=2,
                    earned_points=2,
                    passed=True,
                    assertions=[
                        AssertionResult(
                            "assert_visible: note-title",
                            fatal=True,
                            passed=True,
                        )
                    ],
                    screenshot_path="screenshots/step-01-final.png",
                )
            ],
        )
        record = _serialize_plan_result(Path("test_partial.txt"), 1, result)

        rendered = self._write({"test_overview": "x", "test_plans": [record]})

        self.assertIn("evaluator_error", rendered)
        self.assertIn("step_2: driver disconnected", rendered)
        self.assertIn("PASSED: completed first step", rendered)
        self.assertIn("assert_visible: note-title", rendered)
        self.assertIn("screenshots/step-01-final.png", rendered)

    def test_renders_passed_and_failed_steps(self):
        html = self._write({
            "test_overview": "Adaptive evaluation: 1 test plan(s), macro avg 50.0% (micro 50.0%, 5/10 points)",
            "score": 5, "full_points": 10, "macro_avg_pct": 50.0, "micro_pct": 50.0,
            "n_not_applicable": 0,
            "test_plans": [
                {
                    "test_plan": "test_insert.txt", "run_index": 1,
                    "score": 5, "full_points": 10, "macro_pct": 50.0,
                    "steps": [
                        {"description": "PASSED: step_0", "points": 5, "max_points": 5,
                         "iterations": 10, "hard_assertions": 3, "soft_assertions": 2},
                        {"description": "FAILED: step_1", "points": 0, "max_points": 5,
                         "iterations": 12, "hard_assertions": 1, "soft_assertions": 4},
                    ],
                },
            ],
        })
        self.assertIn("test_insert.txt", html)
        self.assertIn("5/10", html)
        self.assertIn('class="pass"', html)
        self.assertIn('class="fail"', html)
        self.assertIn("PASSED: step_0", html)
        self.assertIn("FAILED: step_1", html)
        self.assertIn('<span class="assertion-count">3</span>', html)
        self.assertIn('<span class="assertion-count">4</span>', html)

    def test_not_applicable_plan_shows_reason_and_no_steps(self):
        html = self._write({
            "test_overview": "Adaptive evaluation: 1 test plan(s), 1 N/A, macro avg 0.0% (micro 0.0%, 0/0 points)",
            "score": 0, "full_points": 0, "macro_avg_pct": 0.0, "micro_pct": 0.0,
            "n_not_applicable": 1,
            "test_plans": [
                {
                    "test_plan": "test_pull_to_refresh.txt", "run_index": 1,
                    "status": "not_applicable", "na_reason": "app has no refreshable list",
                    "score": 0, "full_points": 0, "macro_pct": None, "steps": [],
                },
            ],
        })
        self.assertIn("not_applicable", html)
        self.assertIn("app has no refreshable list", html)
        # not_applicable plans contribute no per-step rows to the detail table
        self.assertNotIn("PASSED", html)
        self.assertNotIn("FAILED", html)

    def test_escapes_html_in_step_description_and_reason(self):
        html = self._write({
            "test_overview": "x",
            "score": 0, "full_points": 0, "macro_avg_pct": 0.0, "micro_pct": 0.0,
            "n_not_applicable": 0,
            "test_plans": [
                {
                    "test_plan": "<script>alert(1)</script>", "run_index": 1,
                    "score": 0, "full_points": 1, "macro_pct": 0.0,
                    "steps": [
                        {"description": "FAILED: <b>bold</b>", "points": 0, "max_points": 1,
                         "iterations": 1, "hard_assertions": 0, "soft_assertions": 0},
                    ],
                },
            ],
        })
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertNotIn("<b>bold</b>", html)

    def test_empty_test_plans_produces_valid_shell(self):
        html = self._write({
            "test_overview": "no test plans", "score": 0, "full_points": 0,
            "macro_avg_pct": 0.0, "micro_pct": 0.0, "n_not_applicable": 0, "test_plans": [],
        })
        self.assertIn("<table>", html)
        self.assertIn("no test plans", html)


if __name__ == "__main__":
    unittest.main()
