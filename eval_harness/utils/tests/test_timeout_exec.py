from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
TIMEOUT_EXEC = REPO_ROOT / "eval_harness" / "utils" / "shell" / "timeout_exec.py"


def run_timeout_cli(*args: str, timeout: float = 5) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TIMEOUT_EXEC), *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class TimeoutExecTests(unittest.TestCase):
    def test_characterization_missing_arguments_prints_usage(self) -> None:
        """Characterization: preserve Python's current missing-argument response.

        Oracle: observed Python exit code and stderr.
        """
        result = run_timeout_cli()

        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(
            result.stderr,
            "usage: timeout_exec.py <seconds> <cmd> [args...]\n",
        )

    def test_characterization_invalid_timeout_returns_exit_2(self) -> None:
        """Characterization: preserve Python's non-numeric-timeout response.

        Oracle: observed Python exit code and stderr.
        """
        result = run_timeout_cli("not-a-number", "true")

        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "invalid timeout: not-a-number\n")

    def test_characterization_child_exit_code_passes_through(self) -> None:
        """Characterization: preserve the child command's ordinary exit code.

        Oracle: the literal exit code requested from the child process.
        """
        result = run_timeout_cli(
            "2",
            sys.executable,
            "-c",
            "raise SystemExit(7)",
        )

        self.assertEqual(result.returncode, 7)

    def test_characterization_child_streams_pass_through(self) -> None:
        """Characterization: preserve child stdout and stderr unchanged.

        Oracle: literal text written independently by the child process.
        """
        result = run_timeout_cli(
            "2",
            sys.executable,
            "-c",
            'import sys; print("child-out"); print("child-err", file=sys.stderr)',
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "child-out\n")
        self.assertEqual(result.stderr, "child-err\n")

    def test_characterization_timeout_returns_124_and_diagnostic(self) -> None:
        """Characterization: preserve Python's timeout exit and diagnostic.

        Oracle: observed Python exit code and stderr for a sleeping child.
        """
        result = run_timeout_cli(
            "0.05",
            sys.executable,
            "-c",
            "import time; time.sleep(30)",
        )

        self.assertEqual(result.returncode, 124)
        self.assertEqual(result.stdout, "")
        self.assertEqual(
            result.stderr,
            "timeout_exec.py: command exceeded 0.05s; "
            "terminating process group\n",
        )

    @unittest.expectedFailure
    def test_spec_timed_out_descendants_do_not_survive(self) -> None:
        """Property: a timed-out process group leaves no descendant running.

        Oracle: the recorded descendant PID no longer exists after wrapper exit.
        Catches: orphaned processes and incomplete process-group cleanup.

        Existing Python defect: the direct child exits on SIGTERM, so the wrapper
        returns without killing a descendant that deliberately ignores SIGTERM.
        """
        descendant_code = (
            "import signal, time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "time.sleep(30)"
        )
        parent_code = (
            "from pathlib import Path\n"
            "import subprocess, sys, time\n"
            "child = subprocess.Popen(\n"
            f"    [sys.executable, '-c', {descendant_code!r}],\n"
            "    stdin=subprocess.DEVNULL,\n"
            "    stdout=subprocess.DEVNULL,\n"
            "    stderr=subprocess.DEVNULL,\n"
            ")\n"
            "Path(sys.argv[1]).write_text(str(child.pid), encoding='utf-8')\n"
            "time.sleep(30)\n"
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            pid_path = Path(temp_dir) / "descendant.pid"
            result = run_timeout_cli(
                "1",
                sys.executable,
                "-c",
                parent_code,
                str(pid_path),
                timeout=15,
            )
            descendant_pid = int(pid_path.read_text(encoding="utf-8"))

            try:
                deadline = time.monotonic() + 0.5
                while pid_exists(descendant_pid) and time.monotonic() < deadline:
                    time.sleep(0.01)

                self.assertEqual(result.returncode, 124)
                self.assertFalse(
                    pid_exists(descendant_pid),
                    f"descendant process {descendant_pid} survived wrapper exit",
                )
            finally:
                if pid_exists(descendant_pid):
                    os.kill(descendant_pid, signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
