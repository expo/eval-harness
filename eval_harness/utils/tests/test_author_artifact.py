import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "eval_harness/utils/artifacts/collect_author_artifact.sh"
PACKAGER = ROOT / "eval_harness/utils/artifacts/package_artifact.sh"


def write(path: Path, contents: str = "fixture") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


class AuthorArtifactTests(unittest.TestCase):
    def test_canonical_artifact_has_one_sanitized_source_and_metadata_tree(self) -> None:
        """A collector regression must not duplicate source or ship transient secrets."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "author_20260810"
            workspace_root = root / "author-agent-workspace"
            metadata_root = root / "author-agent-metadata"
            workspace = workspace_root / run_id
            metadata = metadata_root / run_id
            artifact = root / "authored-app"

            write(workspace / "package.json", '{"name":"fixture"}')
            write(workspace / "App.tsx")
            write(workspace / "ios" / "Authored" / "AppDelegate.swift")
            for excluded in (
                workspace / "node_modules" / "dependency.js",
                workspace / ".expo" / "state.json",
                workspace / ".mcp.json",
                workspace / "ios" / "Pods" / "pod.bin",
                workspace / "ios" / "build" / "app.bin",
                workspace / "ios" / "DerivedData" / "cache.bin",
                workspace / "android" / ".gradle" / "cache.bin",
                workspace / "android" / "build" / "app.bin",
            ):
                write(excluded, "must-not-ship")

            write(metadata / "author.env", f"RUN_ID={run_id}\n")
            write(metadata / "c-agent.log", "author log")
            write(metadata / "telemetry" / "openai.jsonl", "{}\n")
            write(metadata / "telemetry" / "otel" / "index.jsonl", "{}\n")
            write(
                metadata / "telemetry" / "traces" / "claude-code-authoring.json",
                '{"n_sessions":1}',
            )
            write(metadata / "bundle" / "manifest.json", "{}")
            write(metadata / f"{run_id}.tgz", "legacy nested archive")
            write(metadata / "muse-xdg-data" / "muse" / "sessions" / "session.jsonl")
            write(metadata / "muse-bin" / "muse")
            write(metadata / "codex-home" / "config.toml", "settings")
            write(metadata / "codex-home" / "state_1.sqlite", "state")

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
                    "AGENT": "muse-code",
                    "AGENT_MODEL": "muse-spark-1.2",
                    "AGENT_REASONING_EFFORT": "high",
                    "RUN_START_MTIME": "0",
                    "GCS_BUCKET": "",
                    "MUSE_DATA_ROOT": str(metadata / "muse-xdg-data"),
                }
            )
            result = subprocess.run(
                [
                    "bash",
                    str(COLLECTOR),
                    str(root),
                    run_id,
                    str(workspace_root),
                    str(metadata_root),
                    str(artifact),
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((artifact / "manifest.json").is_file())
            self.assertTrue(
                (artifact / "author-agent-workspace" / run_id / "package.json").is_file()
            )
            self.assertTrue(
                (
                    artifact
                    / "author-agent-metadata"
                    / run_id
                    / "telemetry"
                    / "traces"
                    / "muse-code-authoring.json"
                ).is_file()
            )
            self.assertTrue(
                (artifact / "author-agent-metadata" / run_id / "logs" / "c-agent.log").is_file()
            )
            self.assertFalse((artifact / "bundle").exists())
            self.assertFalse(any(path.name == "bundle" for path in artifact.rglob("bundle")))
            self.assertFalse(any(artifact.rglob("*.tgz")))
            self.assertFalse(any(artifact.rglob("node_modules")))
            self.assertFalse(any(artifact.rglob(".expo")))
            self.assertFalse(any(artifact.rglob(".mcp.json")))
            self.assertFalse(any(artifact.rglob("codex-home")))
            self.assertFalse(any(artifact.rglob("muse-xdg-data")))
            self.assertFalse(any(artifact.rglob("muse-bin")))
            self.assertFalse(any(artifact.rglob("claude-code-authoring.json")))
            self.assertFalse((artifact / "author-agent-workspace" / run_id / "ios" / "Pods").exists())
            self.assertFalse(workspace_root.exists(), "runtime workspace must be moved, not copied")
            self.assertFalse(metadata_root.exists(), "runtime metadata must be moved, not copied")

            manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["agent"], "muse-code")
            self.assertEqual(manifest["agent_model"], "muse-spark-1.2")
            self.assertEqual(manifest["agent_reasoning_effort"], "high")
            self.assertEqual(
                manifest["artifacts"]["workspace"],
                f"author-agent-workspace/{run_id}/",
            )

    def test_packager_mirrors_the_same_archive_and_cleans_service_account(self) -> None:
        """GCS mirroring must reuse the EAS archive and remove temporary credentials."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "authored-app"
            archive = root / "authored-app.tar.gz"
            fake_bin = root / "bin"
            calls = root / "gcloud-calls.txt"
            write(source / "manifest.json", "{}")
            write(
                fake_bin / "gcloud",
                """#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$GCLOUD_CALLS"
if [ "$1" = "auth" ]; then test -f "$GOOGLE_APPLICATION_CREDENTIALS"; fi
""",
            )
            (fake_bin / "gcloud").chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "GCS_BUCKET": "fixture-bucket",
                    "GCP_SA_KEY": '{"private_key":"fixture"}',
                    "GCLOUD_CALLS": str(calls),
                }
            )
            result = subprocess.run(
                [
                    "bash",
                    str(PACKAGER),
                    str(source),
                    str(archive),
                    "authored-app.tar.gz",
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(archive.is_file())
            with tarfile.open(archive) as tar:
                self.assertIn("./manifest.json", tar.getnames())
            call_log = calls.read_text(encoding="utf-8")
            self.assertIn(
                f"storage cp {archive.resolve()} gs://fixture-bucket/authored-app.tar.gz",
                call_log,
            )
            self.assertFalse((root / ".gcp-sa.json").exists())


if __name__ == "__main__":
    unittest.main()
