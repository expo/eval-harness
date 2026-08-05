import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
AGENTS_SH = ROOT / "eval_harness/utils/shell/agents.sh"


def classify_log(contents: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as td:
        log_path = Path(td) / "claude.log"
        log_path.write_text(contents, encoding="utf-8")
        return subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; eval::reject_claude_quota_exhaustion "$2"',
                "bash",
                str(AGENTS_SH),
                str(log_path),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )


class ClaudeLimitTests(unittest.TestCase):
    def test_regression_session_limit_response_is_a_distinct_failure(self) -> None:
        """Regression: a successful CLI exit cannot hide exhausted Claude usage.

        Oracle: the observed Claude Max terminal response explicitly states that
        no more model work can run until reset.
        Catches: quota text being treated as authored/evaluated output.
        """
        result = classify_log(
            "You've hit your session limit · resets 2:50pm (UTC)\n",
        )

        self.assertEqual(result.returncode, 75)
        self.assertIn("Claude subscription usage limit exhausted", result.stdout)

    def test_non_quota_output_remains_successful(self) -> None:
        result = classify_log("Completed the requested app changes.\n")

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
