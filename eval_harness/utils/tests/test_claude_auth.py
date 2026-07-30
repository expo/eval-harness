import os
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CHECK_AUTH = ROOT / "eval_harness" / "utils" / "shell" / "check_claude_auth.sh"


def run_check(**env_overrides: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    for name in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ):
        env.pop(name, None)
    env.update(env_overrides)
    return subprocess.run(
        ["bash", str(CHECK_AUTH)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


class ClaudeAuthCheckTests(unittest.TestCase):
    def test_accepts_subscription_oauth_token(self) -> None:
        result = run_check(CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-test")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN bound", result.stdout)

    def test_rejects_missing_subscription_oauth_token(self) -> None:
        result = run_check()

        self.assertEqual(result.returncode, 1)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN is missing", result.stderr)

    def test_rejects_api_key_that_would_override_subscription_oauth(self) -> None:
        result = run_check(
            CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-test",
            ANTHROPIC_API_KEY="sk-ant-api03-test",
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("ANTHROPIC_API_KEY must be unset", result.stderr)

    def test_rejects_bearer_token_that_would_override_subscription_oauth(self) -> None:
        result = run_check(
            CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-test",
            ANTHROPIC_AUTH_TOKEN="test-bearer",
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("ANTHROPIC_AUTH_TOKEN must be unset", result.stderr)


if __name__ == "__main__":
    unittest.main()
