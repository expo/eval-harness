import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
EVAL_SCRIPT = ROOT / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"


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

    def test_evaluator_phase_clears_stale_output_before_an_early_failure(self) -> None:
        """A failed evaluator startup must not publish result data from a prior run."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "stale-output"
            script = root / "eval_harness/evaluator/ios_agentic/scripts/eval-ios-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_ios_artifact.sh"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            author_env = root / "author-agent-metadata" / run_id / "author.env"
            workspace = root / "author-agent-workspace" / run_id
            artifact = root / "ios-eval-report"
            script.parent.mkdir(parents=True, exist_ok=True)
            collector.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(EVAL_SCRIPT, script)
            shutil.copy2(COLLECTOR, collector)
            write(
                stages,
                """eval::resolve_reasoning_effort() { printf '%s' "${1:-high}"; }
eval::fix_java_home() { :; }
eval::env_banner() { :; }
eval::stop_proxies() { :; }
eval::install_agent_device() { exit 23; }
""",
            )
            write(
                author_env,
                f"""RUN_ID={run_id}
RUN_START_MTIME=0
AGENT=claude-code
AGENT_MODEL=sonnet
AGENT_REASONING_EFFORT=high
PRD=dataset/prds/notes/prd/mvp.txt
METRO_MODE=release
SCENARIO=skills_available_unmentioned
""",
            )
            write(workspace / "package.json", "{}")
            write(artifact / "result.json", '{"score":99,"full_points":99,"macro_avg_pct":100}')
            write(artifact / "report.html", "stale report")
            write(artifact / "traces" / "agentic-evaluator.json", "stale trace")
            write(artifact / "telemetry" / "anthropic.jsonl", "stale telemetry")
            fake_bin = root / "bin"
            write(fake_bin / "bun", "#!/usr/bin/env bash\nexit 1\n")
            (fake_bin / "bun").chmod(0o755)
            env = os.environ.copy()
            env.update({"PATH": f"{fake_bin}:{env['PATH']}", "AUTHOR_ENV": str(author_env)})

            result = subprocess.run(
                ["bash", str(script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 23, result.stderr)
            self.assertFalse((artifact / "result.json").exists())
            self.assertFalse((artifact / "report.html").exists())
            self.assertFalse((artifact / "traces" / "agentic-evaluator.json").exists())
            self.assertFalse((artifact / "telemetry" / "anthropic.jsonl").exists())
            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            self.assertIsNone(manifest["score"])

    def test_collector_rejects_output_root_outside_repository(self) -> None:
        """The collector must not mutate an arbitrary caller-supplied directory."""
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            root = parent / "repository"
            outside = parent / "caller-owned"
            fake_bin = root / "bin"
            write(outside / "result.html", "keep")
            write(fake_bin / "bun", "#!/usr/bin/env bash\nexit 1\n")
            (fake_bin / "bun").chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"

            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), "path-escape", str(outside)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((outside / "result.html").read_text(encoding="utf-8"), "keep")

    def test_collector_reports_manifest_write_failure(self) -> None:
        """Manifest serialization is structural and must not fail open."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            artifact = root / "ios-eval-report"
            fake_bin = root / "bin"
            artifact.mkdir(parents=True)
            write(
                fake_bin / "bun",
                """#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then mkdir -p "$(dirname "$2")"; printf '{}\n' > "$2"; exit; fi
  shift
done
""",
            )
            write(fake_bin / "python3", "#!/usr/bin/env bash\nexit 74\n")
            (fake_bin / "bun").chmod(0o755)
            (fake_bin / "python3").chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"

            result = subprocess.run(
                ["bash", str(COLLECTOR), str(root), "manifest-failure", str(artifact)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((artifact / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
