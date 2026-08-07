import os
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
AGENTS_SH = ROOT / "eval_harness/utils/shell/agents.sh"


def run_agents(command: str, **env: str) -> subprocess.CompletedProcess[str]:
    process_env = os.environ.copy()
    process_env.update(env)
    process_env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    process_env.pop("ANTHROPIC_API_KEY", None)
    process_env.pop("ANTHROPIC_AUTH_TOKEN", None)
    process_env.pop("OPENAI_API_KEY", None)
    process_env.pop("META_API_KEY", None)
    process_env.update(env)
    return subprocess.run(
        ["bash", "-c", f'source "{AGENTS_SH}"; {command}'],
        cwd=ROOT,
        env=process_env,
        text=True,
        capture_output=True,
        check=False,
    )


class AuthoringAgentConfigTests(unittest.TestCase):
    def test_normalizes_muse_alias_and_resolves_provider_defaults(self) -> None:
        result = run_agents(
            'eval::normalize_authoring_agent muse; '
            'eval::resolve_authoring_model muse-code ""; '
            'eval::resolve_authoring_model claude-code ""; '
            'eval::resolve_authoring_model codex ""',
            CODEX_MODEL="gpt-5.7-test",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.splitlines(),
            ["muse-code", "muse-spark-1.2", "sonnet", "gpt-5.7-test"],
        )

    def test_rejects_unsupported_authoring_agent(self) -> None:
        result = run_agents("eval::normalize_authoring_agent unsupported-agent")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported authoring agent: unsupported-agent", result.stderr)

    def test_requires_only_the_selected_provider_credential(self) -> None:
        cases = [
            ("claude-code", {"CLAUDE_CODE_OAUTH_TOKEN": "test-claude"}),
            ("codex", {"OPENAI_API_KEY": "test-openai"}),
            ("muse-code", {"META_API_KEY": "test-meta"}),
        ]
        for agent, credentials in cases:
            with self.subTest(agent=agent):
                result = run_agents(
                    f'eval::require_authoring_credentials {agent} "{ROOT}"',
                    **credentials,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

        missing = run_agents(
            f'eval::require_authoring_credentials muse-code "{ROOT}"',
            OPENAI_API_KEY="wrong-provider-key",
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("META_API_KEY is missing", missing.stderr)
