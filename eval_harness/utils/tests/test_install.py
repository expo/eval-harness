import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PRIMITIVES = ROOT / "eval_harness" / "utils" / "shell" / "primitives.sh"
INSTALL = ROOT / "eval_harness" / "utils" / "shell" / "install.sh"


def executable(path: Path, contents: str) -> None:
    path.write_text(textwrap.dedent(contents), encoding="utf-8")
    path.chmod(0o755)


class EvaluatorToolchainInstallTests(unittest.TestCase):
    def run_installer(self, function: str, *, failed_command: str, exit_code: int) -> subprocess.CompletedProcess[str]:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        out = root / "out"
        bin_dir = root / "bin"
        evaluator = root / "evaluator"
        out.mkdir()
        bin_dir.mkdir()
        evaluator.mkdir()

        for command in ("npm", "agent-device", "curl", "maestro", "uv"):
            command_exit = exit_code if command == failed_command else 0
            executable(
                bin_dir / command,
                f"""\
                #!/usr/bin/env bash
                exit {command_exit}
                """,
            )

        script = textwrap.dedent(
            f"""\
            set -uo pipefail
            source {PRIMITIVES!s}
            source {INSTALL!s}
            {function} {evaluator!s} {out!s}
            """
            if function == "eval::install_uv_and_evaluator"
            else f"""\
            set -uo pipefail
            source {PRIMITIVES!s}
            source {INSTALL!s}
            {function} {out!s}
            """
        )
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        return subprocess.run(
            ["bash", "-c", script],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_agent_device_installer_failure_is_not_hidden_by_a_stale_binary(self) -> None:
        """A failed pinned install must not pass because an older CLI answers --version."""
        result = self.run_installer(
            "eval::install_agent_device",
            failed_command="npm",
            exit_code=31,
        )

        self.assertEqual(result.returncode, 31, result.stdout + result.stderr)

    def test_maestro_installer_failure_is_not_hidden_by_a_stale_binary(self) -> None:
        """A failed official installer must not pass because Maestro is already on PATH."""
        result = self.run_installer(
            "eval::install_maestro",
            failed_command="curl",
            exit_code=32,
        )

        self.assertEqual(result.returncode, 32, result.stdout + result.stderr)

    def test_uv_installer_failure_is_not_hidden_by_a_stale_binary(self) -> None:
        """A failed uv installer must stop before a stale uv can satisfy dependency sync."""
        result = self.run_installer(
            "eval::install_uv_and_evaluator",
            failed_command="curl",
            exit_code=33,
        )

        self.assertEqual(result.returncode, 33, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
