import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / "eval_harness/utils/artifacts/collect_author_artifact.sh"
AUTHOR_SANITIZER = ROOT / "eval_harness/utils/artifacts/sanitize_author_workspace.py"
PACKAGER = ROOT / "eval_harness/utils/artifacts/package_artifact.sh"
AUTHOR_SCRIPT = ROOT / "eval_harness/app_builder/scripts/author-app.sh"
PROMPT_RESOLVER = ROOT / "eval_harness/utils/shell/resolve_prompt.sh"


def write(path: Path, contents: str = "fixture") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")


def collector_env(root: Path) -> dict[str, str]:
    fake_bin = root / "bin"
    write(
        fake_bin / "bun",
        """#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then mkdir -p "$(dirname "$2")"; printf '{}\n' > "$2"; exit; fi
  shift
done
""",
    )
    (fake_bin / "bun").chmod(0o755)
    env = os.environ.copy()
    env.update({"PATH": f"{fake_bin}:{env['PATH']}", "GCS_BUCKET": ""})
    return env


def run_collector(
    root: Path,
    run_id: str,
    *,
    collector: Path = COLLECTOR,
    artifact: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash",
            str(collector),
            str(root),
            run_id,
            str(root / "author-agent-workspace"),
            str(root / "author-agent-metadata"),
            str(artifact or root / "authored-app"),
        ],
        cwd=ROOT,
        env=collector_env(root),
        capture_output=True,
        text=True,
        check=False,
    )


def run_author_with_failing_collector(
    root: Path, *, successful_authoring: bool
) -> subprocess.CompletedProcess[str]:
    author_script = root / "eval_harness/app_builder/scripts/author-app.sh"
    collector = root / "eval_harness/utils/artifacts/collect_author_artifact.sh"
    prompt_resolver = root / "eval_harness/utils/shell/resolve_prompt.sh"
    stages = root / "eval_harness/utils/shell/eval_stages.sh"
    for source, target in ((AUTHOR_SCRIPT, author_script), (PROMPT_RESOLVER, prompt_resolver)):
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    write(collector, "#!/usr/bin/env bash\nexit 73\n")
    (root / "dataset").symlink_to(ROOT / "dataset", target_is_directory=True)
    stage_functions = """eval::normalize_authoring_agent() { printf '%s\\n' "$1"; }
eval::resolve_authoring_model() { printf '%s\\n' "${2:-muse-spark-1.2}"; }
eval::resolve_reasoning_effort() { printf '%s\\n' "${1:-high}"; }
eval::stop_proxies() { :; }
eval::cleanup_muse_settings() { :; }
"""
    env = os.environ.copy()
    if successful_authoring:
        stage_functions += """eval::env_banner() { :; }
eval::require_authoring_credentials() { :; }
eval::install_uv_and_evaluator() { :; }
eval::install_muse_cli() { :; }
eval::gate() { return "$1"; }
eval::configure_expo_mcp() { return 1; }
eval::configure_muse_settings() { :; }
eval::run_coding_agent() { mkdir -p "$3"; printf '{"name":"fixture"}\\n' > "$3/package.json"; }
eval::require_authored_app() { test "$1" = 0 && test -f "$2/package.json"; }
"""
        fake_bin = root / "bin"
        write(
            fake_bin / "bun",
            """#!/usr/bin/env bash
workspace="${!#}"
printf '%s\n' '{"ok":true}' > "$workspace/.eval-build-health-bundle.json"
""",
        )
        write(fake_bin / "npm", "#!/usr/bin/env bash\nexit 0\n")
        write(fake_bin / "eas", "#!/usr/bin/env bash\nexit 0\n")
        for executable in (fake_bin / "bun", fake_bin / "npm", fake_bin / "eas"):
            executable.chmod(0o755)
        env.update(
            {
                "PATH": f"{fake_bin}:{env['PATH']}",
                "AGENT": "muse-code",
                "RUN_ID": "collector-failure-after-author",
                "PRD": "dataset/prds/notes/prd/mvp.txt",
            }
        )
    else:
        env.update(
            {
                "RUN_ID": "original-failure",
                "PROMPT_VARIANT": "not-a-real-prompt",
                "HOME": str(root / "home"),
            }
        )
    write(stages, stage_functions)
    return subprocess.run(
        ["bash", str(author_script)],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


class AuthorArtifactTests(unittest.TestCase):
    def test_invalid_prompt_preflight_still_collects_failed_author_artifact(self) -> None:
        """A fallible preflight must run inside the diagnostic collection lifetime."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "invalid-prompt-preflight"
            author_script = root / "eval_harness/app_builder/scripts/author-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_author_artifact.sh"
            prompt_resolver = root / "eval_harness/utils/shell/resolve_prompt.sh"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            fake_bin = root / "bin"
            for source, target in (
                (AUTHOR_SCRIPT, author_script),
                (COLLECTOR, collector),
                (AUTHOR_SANITIZER, collector.parent / "sanitize_author_workspace.py"),
                (PROMPT_RESOLVER, prompt_resolver),
            ):
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            (root / "dataset").symlink_to(ROOT / "dataset", target_is_directory=True)
            write(
                stages,
                """eval::normalize_authoring_agent() { printf '%s\\n' "$1"; }
eval::resolve_authoring_model() { printf '%s\\n' "${2:-sonnet}"; }
eval::resolve_reasoning_effort() { printf '%s\\n' "${1:-high}"; }
eval::stop_proxies() { :; }
eval::cleanup_muse_settings() { :; }
""",
            )
            write(
                fake_bin / "bun",
                """#!/usr/bin/env bash
set -eu
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    mkdir -p "$(dirname "$2")"
    printf '%s\\n' '{"n_sessions":0,"sessions":[]}' > "$2"
    exit 0
  fi
  shift
done
exit 0
""",
            )
            (fake_bin / "bun").chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "RUN_ID": run_id,
                    "PROMPT_VARIANT": "not-a-real-prompt",
                    "HOME": str(root / "home"),
                }
            )
            result = subprocess.run(
                ["bash", str(author_script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            artifact = root / "authored-app"
            manifest_path = artifact / "manifest.json"
            self.assertTrue(manifest_path.is_file(), result.stderr)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["run_id"], run_id)
            self.assertEqual(manifest["build_health"]["app_authored"]["status"], "failed")
            self.assertIsNone(manifest["prompt_variant"])
            self.assertEqual(manifest["requested_prompt_variant"], "not-a-real-prompt")
            self.assertIsNone(manifest["prompt_file"])
            self.assertTrue(
                (artifact / "author-agent-metadata" / run_id / "author.env").is_file()
            )
            self.assertFalse(any(artifact.rglob(".mcp.json")))

    def test_authoring_records_a_failed_structured_export_as_warning(self) -> None:
        """An `ok: false` export result must not become a passed manifest stage."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "export-failure"
            author_script = root / "eval_harness/app_builder/scripts/author-app.sh"
            collector = root / "eval_harness/utils/artifacts/collect_author_artifact.sh"
            prompt_resolver = root / "eval_harness/utils/shell/resolve_prompt.sh"
            stages = root / "eval_harness/utils/shell/eval_stages.sh"
            fake_bin = root / "bin"
            author_script.parent.mkdir(parents=True)
            collector.parent.mkdir(parents=True)
            prompt_resolver.parent.mkdir(parents=True)
            shutil.copy2(AUTHOR_SCRIPT, author_script)
            shutil.copy2(COLLECTOR, collector)
            shutil.copy2(AUTHOR_SANITIZER, collector.parent / "sanitize_author_workspace.py")
            shutil.copy2(PROMPT_RESOLVER, prompt_resolver)
            (root / "dataset").symlink_to(ROOT / "dataset", target_is_directory=True)
            write(
                stages,
                """eval::normalize_authoring_agent() { printf '%s\\n' "$1"; }
eval::resolve_authoring_model() { printf '%s\\n' "${2:-muse-spark-1.2}"; }
eval::resolve_reasoning_effort() { printf '%s\\n' "${1:-high}"; }
eval::env_banner() { :; }
eval::stop_proxies() { :; }
eval::cleanup_muse_settings() { :; }
eval::require_authoring_credentials() { :; }
eval::install_uv_and_evaluator() { :; }
eval::install_muse_cli() { :; }
eval::gate() { return "$1"; }
eval::configure_expo_mcp() { return 1; }
eval::configure_muse_settings() { :; }
eval::run_coding_agent() {
  mkdir -p "$3"
  printf '{"name":"fixture"}\\n' > "$3/package.json"
  printf 'author log\\n' > "$5/c-agent.log"
}
eval::require_authored_app() { test "$1" = 0 && test -f "$2/package.json"; }
""",
            )
            write(
                fake_bin / "bun",
                """#!/usr/bin/env bash
set -eu
for arg in "$@"; do
  case "$arg" in
    bundle-check)
      workspace="${!#}"
      printf '%s\\n' '{"ok":false,"reason":"fixture export failure"}' > "$workspace/.eval-build-health-bundle.json"
      printf '%s\\n' 'bundle check: fixture export failure'
      exit 0
      ;;
  esac
done
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    mkdir -p "$(dirname "$2")"
    printf '%s\\n' '{"n_sessions":1,"sessions":[]}' > "$2"
    exit 0
  fi
  shift
done
""",
            )
            write(fake_bin / "npm", "#!/usr/bin/env bash\nexit 0\n")
            write(fake_bin / "eas", "#!/usr/bin/env bash\nexit 0\n")
            for executable in (fake_bin / "bun", fake_bin / "npm", fake_bin / "eas"):
                executable.chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "AGENT": "muse-code",
                    "RUN_ID": run_id,
                    "PRD": "dataset/prds/notes/prd/mvp.txt",
                }
            )
            result = subprocess.run(
                ["bash", str(author_script)],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads(
                (root / "authored-app/manifest.json").read_text(encoding="utf-8")
            )
            export_stage = manifest["build_health"]["expo_export"]
            self.assertEqual(export_stage["status"], "warning")
            self.assertEqual(
                export_stage["log"],
                f"author-agent-metadata/{run_id}/logs/d-expo-export.log",
            )
            self.assertIn(
                "fixture export failure",
                (
                    root
                    / "authored-app"
                    / "author-agent-metadata"
                    / run_id
                    / "logs/d-expo-export.log"
                ).read_text(encoding="utf-8"),
            )

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
                    "AUTHOR_APP_AUTHORED_STATUS": "passed",
                    "AUTHOR_EXPO_EXPORT_STATUS": "warning",
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
            self.assertEqual(manifest["build_health"]["app_authored"]["status"], "passed")
            self.assertIsNone(manifest["build_health"]["app_authored"]["detail"])
            self.assertEqual(
                manifest["build_health"]["app_authored"]["log"],
                f"author-agent-metadata/{run_id}/logs/c-agent.log",
            )
            self.assertEqual(manifest["build_health"]["expo_export"]["status"], "warning")
            self.assertIsNone(manifest["build_health"]["expo_export"]["detail"])
            self.assertEqual(
                manifest["build_health"]["expo_export"]["log"],
                f"author-agent-metadata/{run_id}/logs/d-expo-export.log",
            )

    def test_collector_excludes_installed_skill_context_but_preserves_app_files(self) -> None:
        """Skills installer outputs must not make the authored app unsafe to materialize."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "installed-skill-context"
            workspace_root = root / "author-agent-workspace"
            metadata_root = root / "author-agent-metadata"
            workspace = workspace_root / run_id
            metadata = metadata_root / run_id
            artifact = root / "authored-app"

            write(workspace / "package.json", '{"name":"fixture"}')
            write(workspace / "src" / "App.tsx", "export default function App() {}")
            write(workspace / ".agents" / "skills" / "expo-ui" / "SKILL.md")
            write(workspace / "agent" / "skills" / "expo-ui" / "SKILL.md")
            (workspace / ".claude" / "skills").mkdir(parents=True)
            (workspace / ".claude" / "skills" / "expo-ui").symlink_to(
                Path("../../.agents/skills/expo-ui"), target_is_directory=True
            )
            write(workspace / "skills-lock.json", '{"skills":{}}')

            # These similarly named paths belong to the authored app and must survive.
            write(workspace / ".claude" / "app-rules.md", "keep")
            write(workspace / "agent" / "runtime.ts", "export const keep = true")
            write(metadata / "author.env", f"RUN_ID={run_id}\n")

            fake_bin = root / "bin"
            write(
                fake_bin / "bun",
                """#!/usr/bin/env bash
set -eu
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    mkdir -p "$(dirname "$2")"
    printf '%s\n' '{"n_sessions":1,"sessions":[]}' > "$2"
    exit 0
  fi
  shift
done
exit 0
""",
            )
            (fake_bin / "bun").chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "AGENT": "muse-code",
                    "RUN_START_MTIME": "0",
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
            collected = artifact / "author-agent-workspace" / run_id
            self.assertFalse((collected / ".agents" / "skills").exists())
            self.assertFalse((collected / ".claude" / "skills").exists())
            self.assertFalse((collected / "agent" / "skills").exists())
            self.assertFalse((collected / "skills-lock.json").exists())
            self.assertTrue((collected / "src" / "App.tsx").is_file())
            self.assertEqual(
                (collected / ".claude" / "app-rules.md").read_text(encoding="utf-8"),
                "keep",
            )
            self.assertEqual(
                (collected / "agent" / "runtime.ts").read_text(encoding="utf-8"),
                "export const keep = true",
            )

    def test_collector_applies_exclusions_through_internal_directory_aliases(self) -> None:
        """An internal symlink alias must not rename excluded content into the artifact."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "aliased-exclusions"
            workspace = root / "author-agent-workspace" / run_id
            metadata = root / "author-agent-metadata" / run_id
            artifact = root / "authored-app"
            workspace_secret = b"workspace-alias-secret"
            metadata_secret = b"metadata-alias-secret"

            write(workspace / "package.json", "{}")
            write(workspace / ".agents" / "skills" / "SECRET", workspace_secret.decode())
            (workspace / "alias-agents").symlink_to(".agents", target_is_directory=True)
            write(metadata / "author.env", f"RUN_ID={run_id}\n")
            write(metadata / "telemetry" / "meta.jsonl", metadata_secret.decode())
            (metadata / "alias-telemetry").symlink_to("telemetry", target_is_directory=True)

            result = run_collector(root, run_id)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(
                (artifact / "author-agent-workspace" / run_id / "alias-agents/skills").exists()
            )
            self.assertFalse(
                (artifact / "author-agent-metadata" / run_id / "alias-telemetry/meta.jsonl").exists()
            )
            shipped_secrets = [
                path.relative_to(artifact).as_posix()
                for path in artifact.rglob("*")
                if path.is_file()
                and any(secret in path.read_bytes() for secret in (workspace_secret, metadata_secret))
            ]
            self.assertEqual(shipped_secrets, [])

    def test_collector_emits_a_materializable_tree_from_authored_filesystem_quirks(self) -> None:
        """Producer output must satisfy the same physical-tree contract as its readers."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "filesystem-quirks"
            workspace_root = root / "author-agent-workspace"
            metadata_root = root / "author-agent-metadata"
            workspace = workspace_root / run_id
            metadata = metadata_root / run_id
            artifact = root / "authored-app"
            archive = root / "authored-app.tar.gz"
            materialized = root / "materialized"

            write(workspace / "package.json", '{"name":"fixture"}')
            write(workspace / "shared" / "view.tsx", "export const View = 1")
            write(workspace / "src" / "target.ts", "export const target = 1")
            (workspace / "src" / "alias.ts").symlink_to("target.ts")
            (workspace / "src" / "shared").symlink_to("../shared", target_is_directory=True)
            os.link(workspace / "src" / "target.ts", workspace / "src" / "hard.ts")
            outside = root / "outside-secret.txt"
            write(outside, "must-not-ship")
            (workspace / "src" / "outside.ts").symlink_to(outside)
            os.mkfifo(workspace / "src" / "runtime.pipe")
            (workspace / "shared" / "cycle").symlink_to("..", target_is_directory=True)
            write(metadata / "author.env", f"RUN_ID={run_id}\n")
            write(metadata / "shared" / "trace.json", '{"safe":true}\n')
            (metadata / "trace-alias.json").symlink_to("shared/trace.json")
            os.link(metadata / "shared" / "trace.json", metadata / "trace-hardlink.json")
            (metadata / "outside-metadata.json").symlink_to(outside)
            os.mkfifo(metadata / "metadata.pipe")

            collected = run_collector(root, run_id)
            self.assertEqual(collected.returncode, 0, collected.stderr)

            env = collector_env(root)
            packaged = subprocess.run(
                ["bash", str(PACKAGER), str(artifact), str(archive), "fixture/authored-app.tar.gz"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(packaged.returncode, 0, packaged.stderr)
            consumed = subprocess.run(
                [
                    "bun",
                    str(ROOT / "node_modules/.bin/skill-analyzer"),
                    "materialize",
                    "--artifact",
                    str(archive),
                    "--dest",
                    str(materialized),
                    "--root-name",
                    "authored-app",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(consumed.returncode, 0, consumed.stderr)

            source = materialized / "author-agent-workspace" / run_id
            for relative in ("src/target.ts", "src/alias.ts", "src/hard.ts", "src/shared/view.tsx"):
                path = source / relative
                self.assertTrue(path.is_file(), relative)
                self.assertFalse(path.is_symlink(), relative)
                self.assertEqual(path.stat().st_nlink, 1, relative)
            self.assertFalse((source / "src" / "outside.ts").exists())
            self.assertFalse((source / "src" / "runtime.pipe").exists())
            self.assertFalse((source / "shared" / "cycle").exists())
            collected_metadata = materialized / "author-agent-metadata" / run_id
            for relative in ("shared/trace.json", "trace-alias.json", "trace-hardlink.json"):
                path = collected_metadata / relative
                self.assertTrue(path.is_file(), relative)
                self.assertFalse(path.is_symlink(), relative)
                self.assertEqual(path.stat().st_nlink, 1, relative)
            self.assertFalse((collected_metadata / "outside-metadata.json").exists())
            self.assertFalse((collected_metadata / "metadata.pipe").exists())
            self.assertFalse(
                any(
                    "must-not-ship" in path.read_text(encoding="utf-8", errors="ignore")
                    for path in materialized.rglob("*")
                    if path.is_file()
                )
            )
            sanitization_log = (
                materialized
                / "author-agent-metadata"
                / run_id
                / "logs"
                / "e-author-artifact-sanitize.log"
            )
            self.assertTrue(sanitization_log.is_file())
            log = sanitization_log.read_text(encoding="utf-8")
            self.assertIn("materialized_symlink", log)
            self.assertIn("removed_external_symlink", log)
            self.assertIn("removed_special", log)
            self.assertIn("removed_cycle", log)
            manifest = json.loads((materialized / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["artifacts"]["workspace_sanitization"],
                f"author-agent-metadata/{run_id}/logs/e-author-artifact-sanitize.log",
            )

    def test_collector_does_not_follow_nested_links_while_excluding_runtime_paths(self) -> None:
        """Pruning must be a copy policy, not mutation through an authored link parent."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "linked-exclusion-parent"
            workspace_root = root / "author-agent-workspace"
            metadata_root = root / "author-agent-metadata"
            workspace = workspace_root / run_id
            metadata = metadata_root / run_id
            artifact = root / "authored-app"
            external_ios = root / "external-ios"
            external_telemetry = root / "external-telemetry"
            write(workspace / "package.json", "{}")
            write(external_ios / "Pods" / "sentinel", "workspace-parent-link")
            (workspace / "ios").symlink_to(external_ios, target_is_directory=True)
            write(metadata / "author.env", f"RUN_ID={run_id}\n")
            write(external_telemetry / "meta.jsonl", "metadata-parent-link")
            (metadata / "telemetry").symlink_to(external_telemetry, target_is_directory=True)

            result = run_collector(root, run_id)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (external_ios / "Pods" / "sentinel").read_text(encoding="utf-8"),
                "workspace-parent-link",
            )
            self.assertEqual(
                (external_telemetry / "meta.jsonl").read_text(encoding="utf-8"),
                "metadata-parent-link",
            )
            self.assertFalse((artifact / "author-agent-workspace" / run_id / "ios").exists())
            self.assertFalse(
                (artifact / "author-agent-metadata" / run_id / "telemetry").is_symlink()
            )

    def test_collector_rejects_linked_run_roots_before_writing_or_pruning(self) -> None:
        """The exact run roots must be physical directories before collector side effects."""
        for linked_root in ("workspace", "metadata"):
            with self.subTest(linked_root=linked_root), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                run_id = "linked-run-root"
                workspace_root = root / "author-agent-workspace"
                metadata_root = root / "author-agent-metadata"
                workspace_root.mkdir()
                metadata_root.mkdir()
                external = root / f"external-{linked_root}"
                if linked_root == "workspace":
                    sentinel = external / "ios" / "Pods" / "sentinel"
                    write(sentinel, "keep")
                    (workspace_root / run_id).symlink_to(external, target_is_directory=True)
                    write(metadata_root / run_id / "author.env", f"RUN_ID={run_id}\n")
                else:
                    write(workspace_root / run_id / "package.json", "{}")
                    sentinel = external / "telemetry" / "sentinel"
                    write(sentinel, "keep")
                    (metadata_root / run_id).symlink_to(external, target_is_directory=True)

                result = run_collector(root, run_id)

                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(sentinel.is_file(), "collector mutated a linked run root")
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
                self.assertFalse((root / "authored-app").exists())

    def test_collector_replaces_untrusted_log_links_without_touching_their_targets(self) -> None:
        """Collector-owned logs must never truncate a pre-planted link target."""
        for link_kind in ("symlink", "hardlink"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                run_id = "owned-log-link"
                workspace_root = root / "author-agent-workspace"
                metadata_root = root / "author-agent-metadata"
                workspace = workspace_root / run_id
                metadata = metadata_root / run_id
                artifact = root / "authored-app"
                write(workspace / "package.json", "{}")
                write(metadata / "author.env", f"RUN_ID={run_id}\n")
                write(metadata / "logs", "untrusted path collision")
                outside = root / "outside-sentinel"
                write(outside, "keep")
                log = metadata / "e-author-artifact-sanitize.log"
                if link_kind == "symlink":
                    log.symlink_to(outside)
                else:
                    os.link(outside, log)

                result = run_collector(root, run_id)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(outside.read_text(encoding="utf-8"), "keep")
                published_log = (
                    artifact / "author-agent-metadata" / run_id / "logs"
                    / "e-author-artifact-sanitize.log"
                )
                self.assertTrue(published_log.is_file())
                self.assertFalse(published_log.is_symlink())
                self.assertEqual(published_log.stat().st_nlink, 1)

    def test_collector_copies_a_readonly_workspace_without_requiring_source_mutation(self) -> None:
        """A readable source tree must publish even when its directories cannot be pruned."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "readonly-workspace"
            workspace_root = root / "author-agent-workspace"
            metadata_root = root / "author-agent-metadata"
            workspace = workspace_root / run_id
            metadata = metadata_root / run_id
            artifact = root / "authored-app"
            app_file = workspace / "src" / "App.tsx"
            write(app_file, "export default function App() {}")
            write(metadata / "author.env", f"RUN_ID={run_id}\n")
            retained_log = metadata / "logs" / "existing.log"
            write(retained_log, "existing diagnostics")
            app_file.chmod(0o444)
            (workspace / "src").chmod(0o555)
            workspace.chmod(0o555)
            retained_log.chmod(0o444)
            retained_log.parent.chmod(0o555)

            try:
                result = run_collector(root, run_id)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    (artifact / "author-agent-workspace" / run_id / "src/App.tsx").read_text(
                        encoding="utf-8"
                    ),
                    "export default function App() {}",
                )
                self.assertEqual(
                    (artifact / "author-agent-metadata" / run_id / "logs/existing.log").read_text(
                        encoding="utf-8"
                    ),
                    "existing diagnostics",
                )
            finally:
                if workspace.exists():
                    workspace.chmod(0o755)
                    if (workspace / "src").exists():
                        (workspace / "src").chmod(0o755)
                    if app_file.exists():
                        app_file.chmod(0o644)
                if retained_log.parent.exists():
                    retained_log.parent.chmod(0o755)
                    if retained_log.exists():
                        retained_log.chmod(0o644)

    def test_collector_rejects_artifact_root_outside_repository(self) -> None:
        """A caller-supplied artifact path must not delete an unrelated directory."""
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)
            root = parent / "repository"
            run_id = "path-escape"
            workspace_root = root / "author-agent-workspace"
            metadata_root = root / "author-agent-metadata"
            outside = parent / "caller-owned"
            write(workspace_root / run_id / "package.json", "{}")
            write(metadata_root / run_id / "author.env", f"RUN_ID={run_id}\n")
            write(outside / "sentinel.txt", "keep")
            fake_bin = root / "bin"
            write(
                fake_bin / "bun",
                """#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then mkdir -p "$(dirname "$2")"; printf '{}\n' > "$2"; exit; fi
  shift
done
""",
            )
            (fake_bin / "bun").chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"

            result = subprocess.run(
                [
                    "bash",
                    str(COLLECTOR),
                    str(root),
                    run_id,
                    str(workspace_root),
                    str(metadata_root),
                    str(outside),
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((outside / "sentinel.txt").read_text(encoding="utf-8"), "keep")

    def test_collector_reports_required_workspace_sanitization_failure(self) -> None:
        """A failed structural copy must make collection fail instead of publishing partial output."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            run_id = "sanitization-failure"
            workspace_root = root / "author-agent-workspace"
            metadata_root = root / "author-agent-metadata"
            artifact = root / "authored-app"
            collector = root / "eval_harness/utils/artifacts/collect_author_artifact.sh"
            collector.parent.mkdir(parents=True)
            shutil.copy2(COLLECTOR, collector)
            write(
                collector.parent / "sanitize_author_workspace.py",
                "#!/usr/bin/env python3\nraise SystemExit(73)\n",
            )
            write(workspace_root / run_id / "package.json", "{}")
            write(metadata_root / run_id / "author.env", f"RUN_ID={run_id}\n")
            result = run_collector(root, run_id, collector=collector)

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(artifact.exists(), "failed collection must not leave a packageable tree")

    def test_author_script_propagates_collection_failure_after_successful_authoring(self) -> None:
        """A successful agent stage cannot hide a failed canonical artifact publication."""
        with tempfile.TemporaryDirectory() as td:
            result = run_author_with_failing_collector(Path(td), successful_authoring=True)

            self.assertEqual(result.returncode, 73, result.stderr)

    def test_author_script_preserves_original_failure_when_collection_also_fails(self) -> None:
        """Artifact cleanup failure must not replace the author stage's original error."""
        with tempfile.TemporaryDirectory() as td:
            result = run_author_with_failing_collector(Path(td), successful_authoring=False)

            self.assertEqual(result.returncode, 1, result.stderr)

    def test_packager_mirrors_the_same_archive_and_cleans_service_account(self) -> None:
        """GCS mirroring must reuse the EAS archive and remove temporary credentials."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "authored-app"
            archive = root / "authored-app.tar.gz"
            fake_bin = root / "bin"
            calls = root / "gcloud-calls.txt"
            credential_capture = root / "credential-capture.txt"
            caller_file = root / ".gcp-sa.json"
            write(source / "manifest.json", "{}")
            write(caller_file, "caller-owned")
            write(
                fake_bin / "gcloud",
                """#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$GCLOUD_CALLS"
if [ "$1" = "auth" ]; then
  test -f "$GOOGLE_APPLICATION_CREDENTIALS"
  mode="$(stat -c %a "$GOOGLE_APPLICATION_CREDENTIALS" 2>/dev/null || stat -f %Lp "$GOOGLE_APPLICATION_CREDENTIALS")"
  printf '%s|%s|%s\n' "$GOOGLE_APPLICATION_CREDENTIALS" "$mode" "$(cat "$GOOGLE_APPLICATION_CREDENTIALS")" > "$GCS_CREDENTIAL_CAPTURE"
fi
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
                    "GCS_CREDENTIAL_CAPTURE": str(credential_capture),
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
            credential_path, mode, contents = credential_capture.read_text(encoding="utf-8").strip().split("|", 2)
            self.assertNotEqual(Path(credential_path), caller_file)
            self.assertEqual(mode, "600")
            self.assertEqual(contents, '{"private_key":"fixture"}')
            self.assertFalse(Path(credential_path).exists())
            self.assertEqual(caller_file.read_text(encoding="utf-8"), "caller-owned")

    def test_packager_rejects_a_source_alias_that_resolves_to_root(self) -> None:
        """Canonical validation must reject '/' even when the caller uses a symlink alias."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source_alias = root / "root-alias"
            source_alias.symlink_to("/", target_is_directory=True)
            archive = root / "unsafe.tar.gz"
            fake_bin = root / "bin"
            tar_called = root / "tar-called"
            write(
                fake_bin / "tar",
                """#!/usr/bin/env bash
touch "$TAR_CALLED"
touch "$2"
""",
            )
            (fake_bin / "tar").chmod(0o755)
            env = os.environ.copy()
            env.update({"PATH": f"{fake_bin}:{env['PATH']}", "TAR_CALLED": str(tar_called)})

            result = subprocess.run(
                ["bash", str(PACKAGER), str(source_alias), str(archive), "unsafe.tar.gz"],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(tar_called.exists())


if __name__ == "__main__":
    unittest.main()
