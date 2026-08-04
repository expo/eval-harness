"""Migration characterization for the Python skill-evaluator CLI."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO_ROOT = Path(__file__).parents[4]
PYTHON_CLI = [
    sys.executable,
    "-m",
    "eval_harness.evaluator.skill_invocation.main",
]


class SkillEvalCliCharacterizationTests(unittest.TestCase):
    def test_characterization_help_exposes_analyze_artifacts_command(self) -> None:
        """Oracle: the observed Python argparse help surface."""
        result = subprocess.run(
            [*PYTHON_CLI, "--help"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertIn("Expo skill-eval helpers", result.stdout)
        self.assertIn("analyze-artifacts", result.stdout)

    def test_characterization_missing_required_option_is_usage_error(self) -> None:
        """Oracle: Python argparse's current exit class and diagnostic fields."""
        result = subprocess.run(
            [*PYTHON_CLI, "analyze-artifacts"],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("usage:", result.stderr)
        self.assertIn("--authored-artifact", result.stderr)
        self.assertIn("--scenario", result.stderr)
        self.assertIn("--out-dir", result.stderr)

    def test_characterization_cli_writes_report_and_summary(self) -> None:
        """Oracle: observed Python CLI artifacts and stable summary fields.

        Catches: argument propagation, sentinel handling, missing reports, and
        a CLI that returns success without emitting the metrics contract.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            authored, prd_skills, checks_dir = _write_fixture(root)
            out_dir = root / "out"

            result = subprocess.run(
                [
                    *PYTHON_CLI,
                    "analyze-artifacts",
                    "--authored-artifact",
                    str(authored),
                    "--eval-artifact",
                    "null",
                    "--scenario",
                    "skills_available_unmentioned",
                    "--out-dir",
                    str(out_dir),
                    "--prd-skills",
                    str(prd_skills),
                    "--checks-dir",
                    str(checks_dir),
                ],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(
                result.stdout,
                "----- skill-eval summary -----\n"
                "app=test-app\n"
                "scenario=skills_available_unmentioned\n"
                "expected_skills=expo-test\n"
                "detected_skills=expo-test\n"
                "uptake_rate=1.0\n"
                "evaluator_pct=None\n"
                "trigger_recall=1.0\n"
                "trigger_precision=1.0\n"
                "trigger_exact_match=True\n",
            )
            metrics = json.loads((out_dir / "metrics.json").read_text())
            self.assertEqual(metrics["app"], "test-app")
            self.assertEqual(metrics["expected_skills"], ["expo-test"])
            self.assertEqual(metrics["outcome_status"], "pending")
            self.assertEqual(metrics["warnings"], [])
            self.assertEqual(metrics["skills"]["expo-test"]["uptake_rate"], 1.0)
            self.assertTrue((out_dir / "report.html").read_text().startswith("<!doctype html>"))


def _write_fixture(root: Path) -> tuple[Path, Path, Path]:
    authored = root / "authored"
    app = authored / "agent-workspace" / "run-1"
    bundle = authored / "eval-out" / "run-1" / "bundle"
    traces = bundle / "telemetry" / "traces"
    app.mkdir(parents=True)
    traces.mkdir(parents=True)
    (app / "package.json").write_text("{}")
    (app / "index.ts").write_text("export const ready = true;\n")
    (app / "ready").write_text("yes\n")
    (bundle / "manifest.json").write_text(
        json.dumps({"prd": "dataset/prds/test-app/prd/mvp.txt"})
    )
    trace = {
        "agent": "claude-code",
        "sessions": [
            {
                "turns": [
                    {
                        "steps": [
                            {
                                "tool_calls": [
                                    {
                                        "name": "Skill",
                                        "args": {"skill": "expo:expo-test"},
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ],
    }
    (traces / "claude-code-authoring.json").write_text(json.dumps(trace))

    prd_skills = root / "prd_skills.json"
    prd_skills.write_text(json.dumps({"test-app": ["expo-test"]}))
    checks_dir = root / "checks"
    checks_dir.mkdir()
    (checks_dir / "checks_data.json").write_text(
        json.dumps(
            {
                "checks": [
                    {
                        "id": "ready-file",
                        "category": "structural",
                        "kind": "path_exists",
                        "target": ["ready"],
                    }
                ]
            }
        )
    )
    (checks_dir / "skill_map.json").write_text(
        json.dumps({"expo-test": ["ready-file"]})
    )
    return authored, prd_skills, checks_dir


if __name__ == "__main__":
    unittest.main()
