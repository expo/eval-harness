import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "eval_harness/utils/artifacts/collect_ios_artifact.sh"


def write(path: Path, contents: str = "fixture") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


class IosArtifactTests(unittest.TestCase):
    def test_canonical_report_has_one_copy_of_evaluator_owned_evidence(self) -> None:
        """The iOS producer must not retain author evidence or duplicate its own output."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "ios_20260810"
            artifact = root / "ios-eval-report"
            plan_traces = root / "evaluator-traces"
            plan_run = plan_traces / "test_insert_20260810"

            write(
                artifact / "result.json",
                '{"status":"completed","score":1,"full_points":1,"macro_avg_pct":100}',
            )
            write(artifact / "result.html", "<html>report</html>")
            write(artifact / "s7-eval.log", "evaluator log")
            write(artifact / "telemetry" / "anthropic.jsonl", "{}\n")
            write(artifact / "telemetry" / "otel" / "index.jsonl", "{}\n")
            write(
                artifact / "telemetry" / "traces" / "claude-code-authoring.json",
                '{"n_sessions":1}',
            )
            write(plan_run / "summary.json", "{}")
            write(plan_run / "conversation.jsonl", "{}\n")
            write(plan_run / "console.log", "trace log")
            write(plan_run / "screenshots" / "step-01-final.png", "png")

            fake_bin = root / "bin"
            fake_bun = fake_bin / "bun"
            write(
                fake_bun,
                """#!/usr/bin/env bash
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then out="$2"; break; fi
  shift
done
mkdir -p "$(dirname "$out")"
printf '%s\n' '{"n_sessions":1,"sessions":[]}' > "$out"
""",
            )
            fake_bun.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "RUN_START_MTIME": "0",
                    "TRACE_SINCE_MTIME": "0",
                    "EVALUATOR_TRACES_ROOT": str(plan_traces),
                    "EVALUATOR_MODEL": "claude-opus-4-8",
                    "EVALUATOR_REASONING_EFFORT": "high",
                }
            )
            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), run_id, str(artifact)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((artifact / "manifest.json").is_file())
            self.assertTrue((artifact / "result.json").is_file())
            self.assertTrue((artifact / "report.html").is_file())
            self.assertTrue((artifact / "traces" / "agentic-evaluator.json").is_file())
            self.assertTrue(
                (
                    artifact
                    / "traces"
                    / "test-plans"
                    / "test_insert_20260810"
                    / "summary.json"
                ).is_file()
            )
            self.assertTrue((artifact / "logs" / "s7-eval.log").is_file())
            self.assertFalse((artifact / "result.html").exists())
            self.assertFalse((artifact / "s7-eval.log").exists())
            self.assertFalse((artifact / "bundle").exists())
            self.assertFalse((artifact / "author-agent-workspace").exists())
            self.assertFalse(any(artifact.rglob("claude-code-authoring.json")))
            self.assertFalse(any(artifact.rglob("*.tgz")))

            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["evaluator_model"], "claude-opus-4-8")
            self.assertEqual(manifest["evaluator_reasoning_effort"], "high")
            self.assertEqual(manifest["artifacts"]["result"], "result.json")
            self.assertEqual(manifest["artifacts"]["test_plan_traces"], "traces/test-plans/")


if __name__ == "__main__":
    unittest.main()
