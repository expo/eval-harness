import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "eval_harness/utils/artifacts/collect_artifacts.sh"


class CollectArtifactsTests(unittest.TestCase):
    def test_regression_bundle_keeps_source_and_excludes_reproducible_build_trees(self) -> None:
        """Regression: evaluator artifacts contain evidence, not build caches.

        Oracle: authored source and result/log evidence are required for review;
        dependencies and native build products can be regenerated.
        Catches: multi-gigabyte evaluator uploads dominated by Pods/build trees.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "artifact-test"
            output = root / "eval-out" / run_id
            workspace = root / "workspace"
            evaluator = root / "evaluator"
            telemetry = output / "telemetry"
            output.mkdir(parents=True)
            workspace.mkdir()
            evaluator.mkdir()
            telemetry.mkdir()

            stale_pod = output / "bundle" / "app" / "ios" / "Pods" / "stale.bin"
            stale_pod.parent.mkdir(parents=True)
            stale_pod.write_text("inherited build cache", encoding="utf-8")

            keep = [
                workspace / "App.tsx",
                workspace / "package.json",
                workspace / "ios" / "Authored" / "AppDelegate.swift",
            ]
            exclude = [
                workspace / "node_modules" / "dependency.js",
                workspace / ".expo" / "state.json",
                workspace / "ios" / "Pods" / "pod.bin",
                workspace / "ios" / "build" / "app.bin",
                workspace / "android" / ".gradle" / "cache.bin",
                workspace / "android" / "build" / "app.bin",
            ]
            for path in keep + exclude:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture", encoding="utf-8")
            (output / "result.json").write_text(
                '{"status":"incomplete","score":0,"full_points":0}',
                encoding="utf-8",
            )
            (output / "s7-eval.log").write_text("diagnostic", encoding="utf-8")

            env = os.environ.copy()
            env.update(
                {
                    "TRACE_PHASE": "evaluate",
                    "RUN_START_MTIME": "0",
                    "TRACE_SINCE_MTIME": "0",
                    "GCS_BUCKET": "",
                }
            )
            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPT),
                    str(root),
                    run_id,
                    str(output),
                    str(workspace),
                    str(evaluator),
                    str(telemetry),
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            bundle_app = output / "bundle" / "app"

            self.assertEqual(result.returncode, 0, result.stderr)
            for source_path in keep:
                relative = source_path.relative_to(workspace)
                self.assertTrue((bundle_app / relative).is_file(), relative)
            for derived_path in exclude:
                relative = derived_path.relative_to(workspace)
                self.assertFalse((bundle_app / relative).exists(), relative)
            self.assertFalse(stale_pod.exists(), "stale bundle content must be removed")
            self.assertTrue((output / "bundle" / "eval" / "result.json").is_file())
            self.assertTrue((output / "bundle" / "logs" / "s7-eval.log").is_file())


if __name__ == "__main__":
    unittest.main()
