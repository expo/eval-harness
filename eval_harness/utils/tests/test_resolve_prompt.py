import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
RESOLVE_PROMPT = ROOT / "eval_harness" / "utils" / "shell" / "resolve_prompt.sh"


def run_resolve(*args: str, **env_overrides: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.pop("PROMPT_VARIANT", None)
    env.pop("PROMPT_REGISTRY", None)
    env.update(env_overrides)
    return subprocess.run(
        ["bash", str(RESOLVE_PROMPT), *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


class ResolvePromptTests(unittest.TestCase):
    def test_defaults_to_baseline(self) -> None:
        result = run_resolve()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "dataset/prompts/baseline.md")

    def test_resolves_a_named_variant(self) -> None:
        result = run_resolve(PROMPT_VARIANT="minimal")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "dataset/prompts/minimal.md")

    def test_realistic_prompt_is_registered_verbatim(self) -> None:
        result = run_resolve(PROMPT_VARIANT="realistic")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "dataset/prompts/realistic.md")
        self.assertEqual(
            (ROOT / result.stdout.strip()).read_text().strip(),
            "Can you build this as an Expo app based on the product brief below?\n"
            "I want the core experience to feel complete, with the main actions easy to find and the important details handled thoughtfully.\n"
            "It should feel polished enough to give to a real user, not like a demo or rough prototype.",
        )

    def test_every_registered_variant_resolves(self) -> None:
        # Guards the registry itself: an entry whose file was renamed or deleted
        # must fail here, not mid-run on a paid worker.
        registry = json.loads((ROOT / "dataset" / "prompts.json").read_text())
        variants = registry["variants"]
        self.assertTrue(variants, "registry has no variants")
        for variant_id in variants:
            with self.subTest(variant=variant_id):
                result = run_resolve(PROMPT_VARIANT=variant_id)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((ROOT / result.stdout.strip()).is_file())

    def test_announces_when_no_variant_was_specified(self) -> None:
        # The whole point: a defaulted prompt must never be silent, or a run
        # scored against the wrong base instructions looks like a real result.
        result = run_resolve()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no prompt variant specified", result.stderr)
        self.assertIn("baseline", result.stderr)
        # The log goes to stderr so stdout stays capturable as just the path.
        self.assertEqual(result.stdout.strip(), "dataset/prompts/baseline.md")

    def test_announces_default_when_baseline_requested_explicitly(self) -> None:
        result = run_resolve(PROMPT_VARIANT="baseline")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("using default prompt variant", result.stderr)

    def test_announces_non_default_variant_without_calling_it_default(self) -> None:
        result = run_resolve(PROMPT_VARIANT="minimal")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("using prompt variant 'minimal'", result.stderr)
        self.assertNotIn("default", result.stderr)

    def test_variant_flag_reports_effective_id_quietly(self) -> None:
        self.assertEqual(run_resolve("--variant").stdout.strip(), "baseline")
        self.assertEqual(
            run_resolve("--variant", PROMPT_VARIANT="minimal").stdout.strip(), "minimal"
        )
        # Quiet, so the announcement isn't duplicated by the second call.
        self.assertEqual(run_resolve("--variant").stderr.strip(), "")

    def test_variant_flag_does_not_assume_id_matches_filename(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "some-file.md").write_text("prompt body")
            registry = Path(td) / "prompts.json"
            registry.write_text(
                json.dumps({"variants": {"terse": {"file": "some-file.md"}}})
            )

            result = run_resolve(
                "--variant", PROMPT_VARIANT="terse", PROMPT_REGISTRY=str(registry)
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "terse")

    def test_rejects_unknown_variant_and_lists_known_ids(self) -> None:
        result = run_resolve(PROMPT_VARIANT="does-not-exist")

        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown prompt_variant", result.stderr)
        # The failure should be self-service: name the valid options.
        self.assertIn("baseline", result.stderr)

    def test_rejects_variant_pointing_at_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            registry = Path(td) / "prompts.json"
            registry.write_text(json.dumps({"variants": {"ghost": {"file": "nope.md"}}}))

            result = run_resolve(PROMPT_VARIANT="ghost", PROMPT_REGISTRY=str(registry))

        self.assertEqual(result.returncode, 1)
        self.assertIn("missing file", result.stderr)

    def test_rejects_variant_pointing_at_empty_file(self) -> None:
        # The real failure this guards: an empty prompt would otherwise let the
        # agent author from a bare PRD, and that run would still be scored.
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "empty.md").write_text("")
            registry = Path(td) / "prompts.json"
            registry.write_text(json.dumps({"variants": {"blank": {"file": "empty.md"}}}))

            result = run_resolve(PROMPT_VARIANT="blank", PROMPT_REGISTRY=str(registry))

        self.assertEqual(result.returncode, 1)
        self.assertIn("empty file", result.stderr)

    def test_rejects_missing_registry(self) -> None:
        result = run_resolve(PROMPT_REGISTRY="/nonexistent/prompts.json")

        self.assertEqual(result.returncode, 1)
        self.assertIn("registry not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
