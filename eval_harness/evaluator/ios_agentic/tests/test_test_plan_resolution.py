import json
import tempfile
import unittest
from pathlib import Path

from eval_harness.evaluator.ios_agentic.main import (
    _app_name_from_prd,
    _build_parser,
    _find_test_plans,
    _resolve_test_plans_from_prd,
)


class TestPlanResolutionTests(unittest.TestCase):
    def test_spec_cli_defaults_to_supported_agent_device_evaluator(self):
        """Specification: the public CLI selects the production evaluator.

        Oracle: agent-device owns the current outcome, abort, and interruption
        contracts; Maestro remains an internal restart fallback only.
        Catches: successful default evaluations serialized as infrastructure errors.
        """
        args = _build_parser().parse_args([])

        self.assertEqual(args.driver, "agent-device")

    def test_spec_cli_rejects_legacy_maestro_evaluator_mode(self):
        with self.assertRaises(SystemExit):
            _build_parser().parse_args(["--driver", "maestro"])

    def test_spec_cli_does_not_advertise_unimplemented_android_evaluation(self):
        with self.assertRaises(SystemExit):
            _build_parser().parse_args(["--platform", "android"])

    def test_app_name_from_prd_extracts_app_segment(self):
        self.assertEqual(_app_name_from_prd("dataset/prds/notes/prd/mvp.txt"), "notes")
        self.assertIsNone(_app_name_from_prd("some/other/path.txt"))

    def test_resolve_test_plans_from_prd_uses_ground_truth_map(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            plans_dir = root / "primitives"
            plans_dir.mkdir()
            (plans_dir / "test_insert.txt").write_text("insert")
            (plans_dir / "test_delete.txt").write_text("delete")
            (plans_dir / "test_unused.txt").write_text("unused")

            prd_test_plans = root / "prd_test_plans.json"
            prd_test_plans.write_text(json.dumps({
                "notes": ["test_insert.txt", "test_delete.txt"],
            }))

            plans = _resolve_test_plans_from_prd(
                Path("dataset/prds/notes/prd/mvp.txt"), prd_test_plans, plans_dir
            )

        self.assertEqual([p.name for p in plans], ["test_insert.txt", "test_delete.txt"])

    def test_resolve_test_plans_from_prd_errors_on_unmapped_app(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            plans_dir = root / "primitives"
            plans_dir.mkdir()
            prd_test_plans = root / "prd_test_plans.json"
            prd_test_plans.write_text(json.dumps({"notes": ["test_insert.txt"]}))

            with self.assertRaises(SystemExit):
                _resolve_test_plans_from_prd(
                    Path("dataset/prds/unmapped-app/prd/mvp.txt"), prd_test_plans, plans_dir
                )

    def test_resolve_test_plans_from_prd_errors_on_missing_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            plans_dir = root / "primitives"
            plans_dir.mkdir()
            # Ground truth references a file that doesn't actually exist on disk.
            prd_test_plans = root / "prd_test_plans.json"
            prd_test_plans.write_text(json.dumps({"notes": ["test_missing.txt"]}))

            with self.assertRaises(SystemExit):
                _resolve_test_plans_from_prd(
                    Path("dataset/prds/notes/prd/mvp.txt"), prd_test_plans, plans_dir
                )

    def test_find_test_plans_still_supports_explicit_file_and_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "test_a.txt").write_text("a")
            (root / "test_b.txt").write_text("b")

            self.assertEqual(_find_test_plans(root / "test_a.txt").__len__(), 1)
            self.assertEqual(len(_find_test_plans(root)), 2)


if __name__ == "__main__":
    unittest.main()
