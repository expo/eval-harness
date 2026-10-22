import json
import os
import re
import subprocess
import tempfile
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


def workflow_run_step(name: str, step_name: str) -> str:
    contents = workflow(name)
    match = re.search(
        rf"^      - name: {re.escape(step_name)}\n(?P<body>.*?)(?=^      - (?:name:|uses:)|\Z)",
        contents,
        re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"workflow {name} has no step named {step_name}")

    lines = match.group("body").splitlines()
    try:
        run_index = lines.index("        run: |")
    except ValueError as exc:
        raise AssertionError(f"workflow step {step_name} has no multiline run script") from exc

    script_lines: list[str] = []
    for line in lines[run_index + 1 :]:
        if line and not line.startswith("          "):
            break
        script_lines.append(line[10:] if line else "")
    return "\n".join(script_lines) + "\n"


def workflow_run_scripts(name: str) -> tuple[str, ...]:
    lines = workflow(name).splitlines()
    scripts: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r"^        run:\s*(.*)$", lines[index])
        if match is None:
            index += 1
            continue
        if match.group(1) != "|":
            scripts.append(match.group(1))
            index += 1
            continue

        script_lines: list[str] = []
        index += 1
        while index < len(lines) and (not lines[index] or lines[index].startswith("          ")):
            script_lines.append(lines[index][10:] if lines[index] else "")
            index += 1
        scripts.append("\n".join(script_lines))
    return tuple(scripts)


_INPUT_EXPRESSION = re.compile(
    r"\$\{\{\s*inputs\.([A-Za-z0-9_]+)(?:\s*\|\|\s*'([^']*)')?\s*\}\}"
)


def _render_input_expressions(value: str, inputs: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        input_name, fallback = match.groups()
        supplied = inputs.get(input_name, "")
        return supplied or fallback or ""

    return _INPUT_EXPRESSION.sub(replace, value)


def workflow_job_input_env(name: str, job: str, inputs: dict[str, str]) -> dict[str, str]:
    job_contents = workflow_job(name, job)
    env_match = re.search(
        r"^    env:\n(?P<env>(?:^      [A-Z0-9_]+:.*\n)+)",
        job_contents,
        re.MULTILINE,
    )
    if env_match is None:
        return {}

    resolved: dict[str, str] = {}
    for key, value in re.findall(r"^      ([A-Z0-9_]+):\s*(.*)$", env_match.group("env"), re.MULTILINE):
        resolved[key] = _render_input_expressions(value, inputs)
    return resolved


def expanded_workflow_run_step(
    name: str,
    job: str,
    step_name: str,
    inputs: dict[str, str],
) -> tuple[str, dict[str, str]]:
    script = _render_input_expressions(workflow_run_step(name, step_name), inputs)
    script = re.sub(r"\$\{\{\s*steps\.[^}]+\}\}", "", script)
    script = script.replace("${{ workflow.id }}", "test-workflow")
    if "${{" in script:
        raise AssertionError(f"unexpanded workflow expression in {step_name}: {script}")
    return script, workflow_job_input_env(name, job, inputs)


def write_executable(path: Path, contents: str) -> None:
    path.write_text(contents, encoding="utf-8")
    path.chmod(0o755)


def install_workflow_command_fakes(root: Path) -> Path:
    fake_bin = root / "bin"
    fake_bin.mkdir()
    write_executable(
        fake_bin / "curl",
        """#!/bin/bash
printf '%s\n' "$@" > "$CURL_ARGS_PATH"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    mkdir -p "$(dirname "$1")"
    : > "$1"
    exit 0
  fi
  shift
done
exit 2
""",
    )
    write_executable(fake_bin / "set-output", "#!/bin/bash\nexit 0\n")
    write_executable(
        fake_bin / "bash",
        """#!/bin/bash
printf '%s\n' "$SCENARIO" > "$BASH_SCENARIO_PATH"
printf '%s\n' "$@" > "$BASH_ARGS_PATH"
exit 0
""",
    )
    write_executable(
        fake_bin / "python3",
        """#!/bin/bash
printf '%s\n' "$@" > "$PYTHON_ARGS_PATH"
exit 0
""",
    )
    return fake_bin


class WorkflowContractTests(unittest.TestCase):
    def test_signed_url_steps_treat_dispatch_urls_as_data(self) -> None:
        cases = (
            ("eval-ios-app.yml", "eval_ios", "Download authored app by signed URL", "authored_app_url"),
            ("eval-skill-use.yml", "skill_eval", "Download authored app by signed URL", "authored_app_url"),
            ("eval-skill-use.yml", "skill_eval", "Download iOS eval report by signed URL", "ios_eval_report_url"),
        )
        malicious_url = "'; touch \"$INJECTION_MARKER\"; : '"

        for workflow_name, job, step_name, input_name in cases:
            with self.subTest(workflow=workflow_name, step=step_name):
                inputs = {input_name: malicious_url}
                script, input_env = expanded_workflow_run_step(workflow_name, job, step_name, inputs)
                with tempfile.TemporaryDirectory() as temporary_directory:
                    root = Path(temporary_directory)
                    fake_bin = install_workflow_command_fakes(root)
                    marker = root / "injected"
                    curl_args = root / "curl-args"
                    environment = {
                        **os.environ,
                        **input_env,
                        "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
                        "INJECTION_MARKER": str(marker),
                        "CURL_ARGS_PATH": str(curl_args),
                        "BASH_SCENARIO_PATH": str(root / "bash-scenario"),
                        "BASH_ARGS_PATH": str(root / "bash-args"),
                        "PYTHON_ARGS_PATH": str(root / "python-args"),
                    }
                    completed = subprocess.run(
                        ["/bin/bash", "-e", "-c", script],
                        cwd=root,
                        env=environment,
                        capture_output=True,
                        text=True,
                    )

                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertFalse(marker.exists(), "dispatch URL executed as shell code")
                    self.assertIn(malicious_url, curl_args.read_text(encoding="utf-8").splitlines())

    def test_skill_input_check_treats_artifact_inputs_as_data(self) -> None:
        malicious_value = "' ]; then touch \"$INJECTION_MARKER\"; fi; if [ -z 'x"
        for input_name in ("authored_app_artifact_id", "authored_app_url"):
            with self.subTest(input=input_name):
                inputs = {input_name: malicious_value}
                script, input_env = expanded_workflow_run_step(
                    "eval-skill-use.yml", "skill_eval", "Check artifact input", inputs
                )
                with tempfile.TemporaryDirectory() as temporary_directory:
                    root = Path(temporary_directory)
                    marker = root / "injected"
                    completed = subprocess.run(
                        ["/bin/bash", "-e", "-c", script],
                        cwd=root,
                        env={**os.environ, **input_env, "INJECTION_MARKER": str(marker)},
                        capture_output=True,
                        text=True,
                    )

                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertFalse(marker.exists(), "artifact input executed as shell code")

    def test_skill_scenario_is_data_in_analyze_and_diagnostic_steps(self) -> None:
        malicious_scenario = "'; touch \"$INJECTION_MARKER\"; : '"
        cases = (
            ("eval-skill-use.yml", "skill_eval", "Analyze skill-eval artifacts", "bash-scenario"),
            ("eval-skill-use.yml", "skill_eval", "Package skill-eval report", "python-args"),
            ("eval-e2e.yml", "eval_skill", "Analyze authored app for skill eval", "bash-scenario"),
            ("eval-e2e.yml", "eval_skill", "Package skill-eval report", "python-args"),
        )

        for workflow_name, job, step_name, capture_name in cases:
            with self.subTest(workflow=workflow_name, step=step_name):
                inputs = {"scenario": malicious_scenario}
                if workflow_name == "eval-e2e.yml":
                    inputs = {"skill_scenario": malicious_scenario}
                script, input_env = expanded_workflow_run_step(
                    workflow_name, job, step_name, inputs
                )
                with tempfile.TemporaryDirectory() as temporary_directory:
                    root = Path(temporary_directory)
                    fake_bin = install_workflow_command_fakes(root)
                    marker = root / "injected"
                    environment = {
                        **os.environ,
                        **input_env,
                        "PATH": f"{fake_bin}:{os.environ.get('PATH', '')}",
                        "INJECTION_MARKER": str(marker),
                        "CURL_ARGS_PATH": str(root / "curl-args"),
                        "BASH_SCENARIO_PATH": str(root / "bash-scenario"),
                        "BASH_ARGS_PATH": str(root / "bash-args"),
                        "PYTHON_ARGS_PATH": str(root / "python-args"),
                    }
                    completed = subprocess.run(
                        ["/bin/bash", "-e", "-c", script],
                        cwd=root,
                        env=environment,
                        capture_output=True,
                        text=True,
                    )

                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertFalse(marker.exists(), "scenario input executed as shell code")
                    captured = (root / capture_name).read_text(encoding="utf-8").splitlines()
                    self.assertIn(malicious_scenario, captured)

    def test_skill_artifact_input_fallback_accepts_id_or_url_and_rejects_neither(self) -> None:
        cases = (
            ({"authored_app_artifact_id": "artifact-123"}, 0),
            ({"authored_app_url": "https://example.invalid/artifact.tar.gz"}, 0),
            ({}, 1),
        )
        for inputs, expected_returncode in cases:
            with self.subTest(inputs=inputs):
                script, input_env = expanded_workflow_run_step(
                    "eval-skill-use.yml", "skill_eval", "Check artifact input", inputs
                )
                completed = subprocess.run(
                    ["/bin/bash", "-e", "-c", script],
                    env={**os.environ, **input_env},
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, expected_returncode, completed.stderr)

    def test_active_run_scripts_do_not_splice_dispatch_inputs(self) -> None:
        for workflow_name in ACTIVE_WORKFLOWS:
            for script in workflow_run_scripts(workflow_name):
                with self.subTest(workflow=workflow_name, script=script):
                    self.assertNotIn("${{ inputs.", script)

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
        self.assertGreaterEqual(contents.count("skill-analyzer materialize"), 2)
        self.assertIn("artifacts/create_diagnostic_artifact.py", contents)

    def test_ios_workflows_materialize_before_auth_and_emit_truthful_diagnostics(self) -> None:
        for name in ("eval-e2e.yml", "eval-ios-app.yml"):
            with self.subTest(workflow=name):
                contents = workflow(name)
                materialize = contents.index("skill-analyzer materialize")
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
                materialize = ios_job.index("skill-analyzer materialize")
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
