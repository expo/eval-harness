import json
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


def workflow_job(name: str, job: str) -> str:
    contents = workflow(name)
    match = re.search(
        rf"^  {re.escape(job)}:\n(?P<body>.*?)(?=^  \w+:\n|\Z)",
        contents,
        re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"workflow {name} has no {job} job")
    return match.group(0)


def workflow_dispatch_input_names(name: str) -> tuple[str, ...]:
    contents = workflow(name)
    match = re.search(
        r"^  workflow_dispatch:\n    inputs:\n(?P<inputs>(?:^      .*\n|^        .*\n|^\s*$)+)",
        contents,
        re.MULTILINE,
    )
    if match is None:
        return ()
    return tuple(
        input_match.group(1)
        for input_match in re.finditer(
            r"^      ([A-Za-z0-9_]+):\s*$",
            match.group("inputs"),
            re.MULTILINE,
        )
    )


class WorkflowContractTests(unittest.TestCase):
    def test_active_dispatches_stay_within_eas_ten_input_limit(self) -> None:
        """Adding an eleventh declared input makes EAS reject the run before creation."""
        for name in ACTIVE_WORKFLOWS:
            with self.subTest(workflow=name):
                input_names = workflow_dispatch_input_names(name)
                self.assertTrue(input_names)
                self.assertLessEqual(len(input_names), 10, input_names)

        e2e_inputs = workflow_dispatch_input_names("eval-e2e.yml")
        self.assertEqual(len(e2e_inputs), 10, e2e_inputs)

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

    def test_ios_workflows_expose_and_pass_pinned_evaluator_model(self) -> None:
        for name in ("eval-e2e.yml", "eval-ios-app.yml"):
            with self.subTest(workflow=name):
                contents = workflow(name)
                self.assertRegex(
                    contents,
                    r"evaluator_model:\n(?:\s+.*\n)*?\s+default: claude-opus-4-8",
                )
                self.assertIn("EVALUATOR_MODEL: ${{ inputs.evaluator_model || 'claude-opus-4-8' }}", contents)

    def test_e2e_fixes_ios_mode_and_evaluator_effort_while_replay_keeps_controls(self) -> None:
        e2e = workflow("eval-e2e.yml")
        self.assertNotIn("evaluator_reasoning_effort", workflow_dispatch_input_names("eval-e2e.yml"))
        self.assertNotIn("ios_app_mode", workflow_dispatch_input_names("eval-e2e.yml"))
        self.assertIn("EVALUATOR_REASONING_EFFORT: high", e2e)
        self.assertIn("EVAL_IOS_APP_MODE: release", e2e)

        replay = workflow("eval-ios-app.yml")
        replay_inputs = workflow_dispatch_input_names("eval-ios-app.yml")
        self.assertIn("evaluator_reasoning_effort", replay_inputs)
        self.assertIn("ios_app_mode", replay_inputs)
        self.assertIn(
            "EVALUATOR_REASONING_EFFORT: ${{ inputs.evaluator_reasoning_effort || 'high' }}",
            replay,
        )
        self.assertIn("EVAL_IOS_APP_MODE: ${{ inputs.ios_app_mode || 'release' }}", replay)

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

    def test_harness_declares_identity_normalizer_loader_directly(self) -> None:
        """The identity helper's loader must not survive only as a transitive dependency."""
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        declared_dependencies = {
            **package.get("dependencies", {}),
            **package.get("devDependencies", {}),
        }
        self.assertIn("@expo/require-utils", declared_dependencies)

    def test_ios_workflows_provision_harness_dependencies_before_running_helpers(self) -> None:
        """A clean EAS evaluator checkout must install before using harness code.

        Catches: relying on authored-workspace dependencies or running
        materialization before the harness's own dependencies are installed.
        """
        for name in ("eval-e2e.yml", "eval-ios-app.yml"):
            with self.subTest(workflow=name):
                ios_job = workflow_job(name, "eval_ios")
                checkout = ios_job.index("uses: eas/checkout")
                install = ios_job.find("uses: eas/install_node_modules")
                materialize = ios_job.index("artifacts/materialize.ts")
                evaluate = ios_job.index("ios_agentic/scripts/eval-ios-app.sh")
                self.assertLess(checkout, install)
                self.assertLess(install, materialize)
                self.assertLess(install, evaluate)

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
                        f"package_artifact.sh {root} {archive} '${{{{ workflow.id }}}}/{archive}'",
                        contents,
                    )
                    self.assertIn(f"name: {root}", contents)
                    self.assertIn(f"path: {archive}", contents)

    def test_optional_gcs_mirrors_are_namespaced_by_workflow_run(self) -> None:
        """Two workflow runs must not mirror their canonical archives to the same GCS key."""
        for name in ACTIVE_WORKFLOWS:
            with self.subTest(workflow=name):
                contents = workflow(name)
                invocations = re.findall(
                    r"package_artifact\.sh\s+\S+\s+(\S+\.tar\.gz)\s+(.+)$",
                    contents,
                    re.MULTILINE,
                )
                self.assertTrue(invocations)
                for archive, object_name in invocations:
                    self.assertEqual(
                        object_name.strip(),
                        f"'${{{{ workflow.id }}}}/{archive}'",
                    )

    def test_active_workflows_fit_eas_size_limit(self) -> None:
        for name in ACTIVE_WORKFLOWS:
            with self.subTest(workflow=name):
                self.assertLess((WORKFLOW_ROOT / name).stat().st_size, 16 * 1024)


if __name__ == "__main__":
    unittest.main()
