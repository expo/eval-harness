import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_ROOT = ROOT / ".eas/workflows"
ACTIVE_WORKFLOWS = (
    "eval-e2e.yml",
    "author-app.yml",
    "eval-ios-app.yml",
    "eval-skill-use.yml",
)


def workflow(name: str) -> str:
    return (WORKFLOW_ROOT / name).read_text(encoding="utf-8")


class WorkflowContractTests(unittest.TestCase):
    def test_active_workflows_use_only_canonical_runtime_and_artifact_names(self) -> None:
        """The active EAS surface must not recreate a legacy transport layout."""
        for name in ACTIVE_WORKFLOWS:
            with self.subTest(workflow=name):
                contents = workflow(name)
                self.assertNotIn("agent-workspace", contents)
                self.assertNotIn("eval-out", contents)
                self.assertNotIn("eval-e2e-output", contents)
                self.assertNotIn("tar -xzf", contents)

    def test_author_workflows_expose_and_pass_reasoning_effort(self) -> None:
        for name in ("eval-e2e.yml", "author-app.yml"):
            with self.subTest(workflow=name):
                contents = workflow(name)
                self.assertRegex(
                    contents,
                    r"agent_reasoning_effort:\n"
                    r"(?:\s+.*\n)*?\s+options:\n"
                    r"\s+- low\n\s+- medium\n\s+- high\n"
                    r"\s+default: high",
                )
                self.assertIn(
                    "AGENT_REASONING_EFFORT: ${{ inputs.agent_reasoning_effort || 'high' }}",
                    contents,
                )

    def test_ios_workflows_expose_and_pass_pinned_evaluator_controls(self) -> None:
        for name in ("eval-e2e.yml", "eval-ios-app.yml"):
            with self.subTest(workflow=name):
                contents = workflow(name)
                self.assertRegex(
                    contents,
                    r"evaluator_model:\n(?:\s+.*\n)*?\s+default: claude-opus-4-8",
                )
                self.assertRegex(
                    contents,
                    r"evaluator_reasoning_effort:\n"
                    r"(?:\s+.*\n)*?\s+options:\n"
                    r"\s+- low\n\s+- medium\n\s+- high\n"
                    r"\s+default: high",
                )
                self.assertIn("EVALUATOR_MODEL: ${{ inputs.evaluator_model || 'claude-opus-4-8' }}", contents)
                self.assertIn(
                    "EVALUATOR_REASONING_EFFORT: ${{ inputs.evaluator_reasoning_effort || 'high' }}",
                    contents,
                )

    def test_e2e_runs_evaluators_after_author_completion_and_consolidates(self) -> None:
        contents = workflow("eval-e2e.yml")
        for job in ("eval_ios", "eval_skill"):
            block = re.search(rf"^  {job}:\n(?P<body>.*?)(?=^  \w+:\n|\Z)", contents, re.MULTILINE | re.DOTALL)
            self.assertIsNotNone(block)
            assert block is not None
            self.assertIn(f"if: ${{{{ inputs.run_{job} }}}}", block.group(0))
            self.assertIn("after: [author_app]", block.group("body"))
            self.assertNotIn("needs: [author_app]", block.group("body"))
            self.assertGreaterEqual(block.group("body").count("if: ${{ always() }}"), 2)

        report = re.search(r"^  report:\n(?P<body>.*)\Z", contents, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(report)
        assert report is not None
        body = report.group("body")
        self.assertIn("after: [eval_ios, eval_skill]", body)
        self.assertIn("runs_on: linux-medium", body)
        self.assertIn("name: eval-report", body)
        self.assertIn("path: eval-report.tar.gz", body)
        self.assertIn("--authored-artifact", body)
        self.assertIn("--ios-job-status '${{ after.eval_ios.status }}'", body)
        self.assertIn("--skill-job-status '${{ after.eval_skill.status }}'", body)
        self.assertNotRegex(body, r"--(?:skill|ios)-artifact\s+[^\n]*undefined")
        self.assertIn(
            "if: ${{ always() && inputs.run_eval_ios && after.eval_ios.status != 'skipped' }}",
            body,
        )
        self.assertIn(
            "if: ${{ always() && inputs.run_eval_skill && after.eval_skill.status != 'skipped' }}",
            body,
        )
        self.assertGreaterEqual(body.count("if: ${{ always() }}"), 3)
        self.assertGreaterEqual(contents.count("artifacts/materialize.ts"), 2)
        self.assertIn("artifacts/create_diagnostic_artifact.py", contents)

    def test_ios_workflows_materialize_before_auth_and_emit_truthful_diagnostics(self) -> None:
        for name in ("eval-e2e.yml", "eval-ios-app.yml"):
            with self.subTest(workflow=name):
                contents = workflow(name)
                materialize = contents.index("artifacts/materialize.ts")
                auth = contents.index("utils/shell/check_claude_auth.sh")
                evaluate = contents.index("ios_agentic/scripts/eval-ios-app.sh")
                diagnostic = contents.index("artifacts/create_diagnostic_artifact.py")
                self.assertLess(materialize, auth)
                self.assertLess(auth, evaluate)
                self.assertLess(evaluate, diagnostic)

    def test_all_producers_use_the_shared_packager_and_stable_names(self) -> None:
        expected = {
            "eval-e2e.yml": (
                ("authored-app", "authored-app.tar.gz"),
                ("ios-eval-report", "ios-eval-report.tar.gz"),
                ("skill-eval-report", "skill-eval-report.tar.gz"),
                ("eval-report", "eval-report.tar.gz"),
            ),
            "author-app.yml": (("authored-app", "authored-app.tar.gz"),),
            "eval-ios-app.yml": (("ios-eval-report", "ios-eval-report.tar.gz"),),
            "eval-skill-use.yml": (("skill-eval-report", "skill-eval-report.tar.gz"),),
        }
        for name, artifacts in expected.items():
            contents = workflow(name)
            with self.subTest(workflow=name):
                for root, archive in artifacts:
                    self.assertIn(
                        f"package_artifact.sh {root} {archive} {archive}",
                        contents,
                    )
                    self.assertIn(f"name: {root}", contents)
                    self.assertIn(f"path: {archive}", contents)

    def test_active_workflows_fit_eas_size_limit(self) -> None:
        for name in ACTIVE_WORKFLOWS:
            with self.subTest(workflow=name):
                self.assertLess((WORKFLOW_ROOT / name).stat().st_size, 16 * 1024)


if __name__ == "__main__":
    unittest.main()
