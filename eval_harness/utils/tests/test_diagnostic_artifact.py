import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "eval_harness/utils/artifacts/create_diagnostic_artifact.py"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class DiagnosticArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.author = self.root / "authored"
        write_json(
            self.author / "manifest.json",
            {
                "schema_version": 2,
                "artifact_type": "authored-app",
                "run_id": "author-run-7",
                "prd": "dataset/prds/notes/prd/mvp.txt",
                "agent": "muse-code",
                "agent_model": "muse-spark-1.2",
                "agent_reasoning_effort": "high",
                "scenario": "skills_available_unmentioned",
                "build_health": {
                    "app_authored": {"status": "passed", "detail": None, "log": "author.log"},
                    "expo_export": {"status": "warning", "detail": "probe failed", "log": "export.log"},
                },
            },
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_helper(self, kind: str, output: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "--kind",
                kind,
                "--author-artifact-root",
                str(self.author),
                "--out-dir",
                str(output),
                "--stage",
                "preflight",
                "--reason",
                "missing <credential> & unavailable",
                "--evaluator-model",
                "claude-opus-4-8",
                "--evaluator-reasoning-effort",
                "high",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_ios_diagnostic_is_structurally_valid_and_preserves_author_provenance(self) -> None:
        output = self.root / "ios-eval-report"
        result = self.run_helper("ios", output)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(path.name for path in output.iterdir()), ["manifest.json", "report.html", "result.json"])
        payload = json.loads((output / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(
            payload,
            {
                "status": "failed",
                "expected_plan_count": 0,
                "terminal_plan_count": 0,
                "macro_avg_pct": None,
                "evaluator_errors": [
                    {"stage": "preflight", "reason": "missing <credential> & unavailable"}
                ],
                "test_plans": [],
            },
        )
        manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["run_id"], "author-run-7")
        self.assertEqual(manifest["prd"], "dataset/prds/notes/prd/mvp.txt")
        self.assertEqual(manifest["agent"], "muse-code")
        self.assertEqual(manifest["evaluator_model"], "claude-opus-4-8")
        self.assertEqual(manifest["build_health"]["evaluation"]["status"], "failed")
        self.assertEqual(
            manifest["build_health"]["evaluation"]["detail"],
            "preflight: missing <credential> & unavailable",
        )
        self.assertIn("missing &lt;credential&gt; &amp; unavailable", (output / "report.html").read_text(encoding="utf-8"))

    def test_skill_diagnostic_has_truthful_exact_inventory_and_pending_scores(self) -> None:
        output = self.root / "skill-eval-report"
        result = self.run_helper("skill", output)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(path.name for path in output.iterdir()), ["manifest.json", "metrics.json", "report.html"])
        manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["run_id"], "author-run-7")
        self.assertEqual(manifest["artifacts"], {"metrics": "metrics.json", "report": "report.html"})
        metrics = json.loads((output / "metrics.json").read_text(encoding="utf-8"))
        self.assertEqual(metrics["scenario"], "skills_available_unmentioned")
        self.assertEqual(metrics["outcome_status"], "pending")
        self.assertIsNone(metrics["score"]["trigger_quality"]["recall"])
        self.assertIsNone(metrics["score"]["context_uptake"]["uptake_rate"])
        self.assertEqual(metrics["skills"], {})
        self.assertIn("preflight: missing <credential> & unavailable", metrics["warnings"])


if __name__ == "__main__":
    unittest.main()
