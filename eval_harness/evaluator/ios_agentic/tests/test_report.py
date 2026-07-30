import tempfile
import unittest
from pathlib import Path

from eval_harness.evaluator.ios_agentic.report import write_html_report


class WriteHtmlReportTests(unittest.TestCase):
    def _write(self, output: dict) -> str:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "result.html"
            write_html_report(output, path)
            return path.read_text(encoding="utf-8")

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
