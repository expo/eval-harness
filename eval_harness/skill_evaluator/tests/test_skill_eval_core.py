import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from eval_harness.skill_evaluator.analysis import (
    aggregate_skill_results,
    analyze_artifacts,
    classify_skill,
    discover_artifact_layout,
    score_case_run,
)
from eval_harness.skill_evaluator.static_checks import (
    detect_triggered_skills,
    run_static_checks,
    score_trigger_quality,
)
from eval_harness.skill_evaluator.utils import load_case_spec, unpack_artifact


class SkillEvalCoreTests(unittest.TestCase):
    def test_core5_case_specs_load(self):
        case_dir = Path(__file__).parents[2] / "skill_evaluator" / "skill_cases" / "core5"
        specs = sorted(case_dir.glob("*.json"))

        self.assertEqual(len(specs), 5)
        for path in specs:
            spec = load_case_spec(path)
            self.assertTrue(spec.expected_skills, path.name)
            self.assertTrue(spec.static_uptake_checks, path.name)

    def test_case_spec_loads_core_case_without_skill_family(self):
        with tempfile.TemporaryDirectory() as td:
            spec_path = Path(td) / "case.json"
            spec_path.write_text(json.dumps({
                "id": "settings-ui",
                "feature_focus": "native settings screen",
                "expected_skills": ["building-native-ui", "expo-ui"],
                "static_uptake_checks": [
                    {"id": "uses_expo_ui", "kind": "import", "target": "@expo/ui"}
                ],
            }))

            spec = load_case_spec(spec_path)

        self.assertEqual(spec.id, "settings-ui")
        self.assertEqual(spec.expected_skills, ["building-native-ui", "expo-ui"])
        self.assertFalse(hasattr(spec, "skill_family"))
        self.assertFalse(hasattr(spec, "test_plan"))

    def test_trigger_quality_requires_the_right_skills(self):
        trace = {
            "sessions": [{
                "turns": [{
                    "steps": [{
                        "text": "I'm using the expo-dev-client skill.",
                        "tool_calls": [{"name": "read_skill", "args": {"skill": "expo-dev-client"}}],
                    }]
                }]
            }]
        }

        observed = detect_triggered_skills(trace)
        score = score_trigger_quality(["building-native-ui", "expo-ui"], observed)

        self.assertEqual(observed, ["expo-dev-client"])
        self.assertEqual(score.expected_skills, ["building-native-ui", "expo-ui"])
        self.assertEqual(score.triggered_skills, ["expo-dev-client"])
        self.assertEqual(score.recall, 0.0)
        self.assertEqual(score.precision, 0.0)
        self.assertFalse(score.any_expo_skill_triggered is False)

    def test_static_uptake_import_and_text_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            src = app / "app"
            src.mkdir()
            (src / "index.tsx").write_text(
                "import { Host, List, ListItem } from '@expo/ui';\n"
                "export default function App(){ return <Host><List><ListItem title=\"A\" /></List></Host>; }\n"
            )

            result = run_static_checks(app, [
                {"id": "uses_expo_ui", "kind": "import", "target": "@expo/ui"},
                {"id": "uses_host", "kind": "text", "target": "Host"},
                {"id": "missing_tailwind", "kind": "file_exists", "target": "tailwind.config.js"},
            ])

        by_id = {check.id: check for check in result.checks}
        self.assertTrue(by_id["uses_expo_ui"].passed)
        self.assertTrue(by_id["uses_host"].passed)
        self.assertFalse(by_id["missing_tailwind"].passed)
        self.assertEqual(result.passed, 2)
        self.assertEqual(result.total, 3)

    def test_static_uptake_absent_and_any_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            src = app / "app"
            src.mkdir()
            (src / "index.tsx").write_text("const loading = true; const error = null;\n")

            result = run_static_checks(app, [
                {"id": "has_loading_or_query", "kind": "text_any", "target": "useQuery|loading"},
                {"id": "no_vector_icons", "kind": "text_absent", "target": "@expo/vector-icons"},
                {"id": "missing_refresh", "kind": "text_any", "target": "RefreshControl|useSWR"},
            ])

        by_id = {check.id: check for check in result.checks}
        self.assertTrue(by_id["has_loading_or_query"].passed)
        self.assertTrue(by_id["no_vector_icons"].passed)
        self.assertFalse(by_id["missing_refresh"].passed)

    def test_static_text_checks_ignore_package_manifests_and_lockfiles(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"scripts": {"error": "echo error"}}))
            (app / "package-lock.json").write_text(json.dumps({"packages": {"error": {}}}))
            src = app / "app"
            src.mkdir()
            (src / "index.tsx").write_text("export default function App(){ return null; }\n")

            result = run_static_checks(app, [
                {"id": "has_error_state", "kind": "text", "target": "error"},
            ])

        self.assertFalse(result.checks[0].passed)
        self.assertIn("No source file", result.checks[0].evidence)

    def test_case_run_only_scores_uptake_when_relevant_skill_triggered(self):
        run = score_case_run(
            expected_skills=["expo-ui"],
            triggered_skills=[],
            static_passed=1,
            static_total=1,
            evaluator_pct=80.0,
            build_success=True,
        )

        self.assertIsNone(run.context_uptake.uptake_rate)
        self.assertEqual(run.trigger_quality.recall, 0.0)
        self.assertEqual(run.outcome_delta.evaluator_pct, 80.0)

    def test_classification_distinguishes_trigger_and_content_tuning(self):
        self.assertEqual(
            classify_skill(trigger_recall=0.4, trigger_precision=1.0, uptake_rate=1.0,
                           outcome_delta=20.0, build_success_rate=1.0),
            "Needs trigger tuning",
        )
        self.assertEqual(
            classify_skill(trigger_recall=1.0, trigger_precision=1.0, uptake_rate=0.25,
                           outcome_delta=10.0, build_success_rate=1.0),
            "Needs content tuning",
        )
        self.assertEqual(
            classify_skill(trigger_recall=1.0, trigger_precision=1.0, uptake_rate=1.0,
                           outcome_delta=-5.0, build_success_rate=0.5),
            "Unhelpful",
        )

    def test_aggregate_skill_results_computes_outcome_delta_from_baseline(self):
        runs = [
            {"skill_id": "expo-ui", "scenario": "plugin_off_baseline", "trigger_recall": 0,
             "trigger_precision": 1, "uptake_rate": None, "evaluator_pct": 50, "build_success": True},
            {"skill_id": "expo-ui", "scenario": "skills_available_unmentioned", "trigger_recall": 1,
             "trigger_precision": 1, "uptake_rate": 1, "evaluator_pct": 70, "build_success": True},
            {"skill_id": "expo-ui", "scenario": "skills_available_mentioned", "trigger_recall": 1,
             "trigger_precision": 1, "uptake_rate": 0.5, "evaluator_pct": 80, "build_success": True},
        ]

        aggregate = aggregate_skill_results(runs)

        self.assertEqual(aggregate["expo-ui"]["baseline_evaluator_pct"], 50.0)
        self.assertEqual(aggregate["expo-ui"]["skill_evaluator_pct"], 75.0)
        self.assertEqual(aggregate["expo-ui"]["outcome_delta"], 25.0)
        self.assertEqual(aggregate["expo-ui"]["classification"], "Helpful")

    def test_unpack_and_discover_authored_artifact_layout_from_tarball(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            app = source / "agent-workspace" / "run-1"
            traces = source / "eval-out" / "run-1" / "bundle" / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (traces / "claude-authoring.json").write_text(json.dumps({"text": "Using the expo-ui skill"}))
            tar_path = root / "authored-app.tar.gz"
            with tarfile.open(tar_path, "w:gz") as archive:
                archive.add(source / "agent-workspace", arcname="agent-workspace")
                archive.add(source / "eval-out", arcname="eval-out")

            unpacked = unpack_artifact(tar_path, root / "unpacked")
            layout = discover_artifact_layout(unpacked)

        self.assertEqual(layout.app_dir.name, "run-1")
        self.assertEqual(layout.trace_path.name, "claude-authoring.json")
        self.assertIsNone(layout.result_path)

    def test_unpack_artifact_rejects_path_traversal_tarball(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tar_path = root / "unsafe.tar"
            payload = root / "payload.txt"
            payload.write_text("bad\n")
            with tarfile.open(tar_path, "w") as archive:
                archive.add(payload, arcname="../escape.txt")

            with self.assertRaises(ValueError):
                unpack_artifact(tar_path, root / "unpacked")

    def test_analyze_artifacts_reports_author_only_outcome_pending(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case_path = self._write_case(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            traces = authored / "eval-out" / "run-1" / "bundle" / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "index.tsx").write_text("import { Host } from '@expo/ui';\nexport default Host;\n")
            (traces / "claude-authoring.json").write_text(json.dumps({
                "text": "I will use the expo-ui skill.",
                "braintrust_url": "https://www.braintrust.dev/app/project/traces/abc",
            }))

            payload = analyze_artifacts(case_path, authored, None, "skills_available_unmentioned", root / "out")

            self.assertEqual(payload["outcome_status"], "pending")
            self.assertEqual(payload["runs"][0]["classification"], "Outcome pending")
            self.assertEqual(payload["runs"][0]["trigger_recall"], 1.0)
            self.assertEqual(payload["runs"][0]["uptake_rate"], 1.0)
            self.assertIn("https://www.braintrust.dev/app/project/traces/abc", payload["braintrust_refs"])
            self.assertTrue((root / "out" / "metrics.json").exists())
            self.assertTrue((root / "out" / "report.html").exists())

    def test_analyze_artifacts_merges_eval_result(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case_path = self._write_case(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            traces = authored / "eval-out" / "run-1" / "bundle" / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "index.tsx").write_text("import { Host } from '@expo/ui';\nexport default Host;\n")
            (traces / "claude-authoring.json").write_text(json.dumps({"text": "Using expo-ui"}))
            eval_out = root / "eval"
            result = eval_out / "eval-out" / "run-1" / "bundle" / "eval"
            result.mkdir(parents=True, exist_ok=True)
            (result / "result.json").write_text(json.dumps({"macro_avg_pct": 87.5}))

            payload = analyze_artifacts(case_path, authored, eval_out, "skills_available_mentioned", root / "out")

        self.assertEqual(payload["outcome_status"], "complete")
        self.assertEqual(payload["runs"][0]["evaluator_pct"], 87.5)
        self.assertTrue(payload["runs"][0]["build_success"])
        self.assertEqual(payload["skills"]["expo-ui"]["classification"], "Helpful")

    def test_analyze_artifacts_marks_missing_trace_without_crashing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case_path = self._write_case(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            app.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "index.tsx").write_text("import { Host } from '@expo/ui';\nexport default Host;\n")

            payload = analyze_artifacts(case_path, authored, None, "skills_available_unmentioned", root / "out")

        self.assertIn("author trace not found", payload["warnings"])
        self.assertEqual(payload["runs"][0]["trigger_recall"], 0.0)
        self.assertIsNone(payload["runs"][0]["uptake_rate"])

    def test_analyze_artifacts_marks_missing_app_without_crashing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            case_path = self._write_case(root, "expo-ui")
            authored = root / "authored"
            traces = authored / "eval-out" / "run-1" / "bundle" / "telemetry" / "traces"
            traces.mkdir(parents=True)
            (traces / "claude-authoring.json").write_text(json.dumps({"text": "Using expo-ui"}))

            payload = analyze_artifacts(case_path, authored, None, "skills_available_unmentioned", root / "out")

        self.assertIn("app tree not found", payload["warnings"])
        self.assertEqual(payload["static_checks"], [])
        self.assertEqual(payload["runs"][0]["uptake_rate"], 0.0)

    def _write_case(self, root: Path, skill: str) -> Path:
        case_path = root / "case.json"
        case_path.write_text(json.dumps({
            "id": "artifact-case",
            "feature_focus": "artifact analysis",
            "expected_skills": [skill],
            "static_uptake_checks": [
                {"id": "uses_expo_ui", "kind": "import", "target": "@expo/ui"}
            ],
        }))
        return case_path


if __name__ == "__main__":
    unittest.main()
