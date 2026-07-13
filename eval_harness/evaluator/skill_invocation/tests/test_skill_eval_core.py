import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from eval_harness.evaluator.skill_invocation.analysis import (
    aggregate_skill_results,
    analyze_artifacts,
    discover_artifact_layout,
    score_case_run,
)
from eval_harness.evaluator.skill_invocation.static_checks import (
    detect_triggered_skills,
    run_static_checks,
    score_trigger_quality,
)
from eval_harness.evaluator.skill_invocation.utils import load_case_spec, load_case_specs_by_skill, unpack_artifact

TEST_PRD = "dataset/prds/test-app/prd/mvp.txt"


def _trace(agent, tool_calls_by_step):
    """Build a minimal real-shaped trace: one session, one turn, one step per
    tool_calls list given."""
    steps = [{"text": "", "reasoning": "", "tool_calls": calls} for calls in tool_calls_by_step]
    return {"agent": agent, "sessions": [{"turns": [{"steps": steps}]}]}


class SkillEvalCoreTests(unittest.TestCase):
    def test_core5_case_specs_load(self):
        case_dir = Path(__file__).parents[1] / "skill_cases" / "core5"
        specs = sorted(case_dir.glob("*.json"))

        self.assertEqual(len(specs), 5)
        for path in specs:
            spec = load_case_spec(path)
            self.assertTrue(spec.expected_skills, path.name)
            self.assertTrue(spec.static_uptake_checks, path.name)

    def test_app_name_from_prd_extracts_app_segment(self):
        from eval_harness.evaluator.skill_invocation.utils import app_name_from_prd

        self.assertEqual(app_name_from_prd("dataset/prds/notes/prd/mvp.txt"), "notes")
        self.assertIsNone(app_name_from_prd("some/other/path.txt"))

    def test_load_case_specs_by_skill_indexes_core5_by_skill_id(self):
        case_dir = Path(__file__).parents[1] / "skill_cases" / "core5"

        by_skill = load_case_specs_by_skill(case_dir)

        self.assertIn("expo-data-fetching", by_skill)
        self.assertIn("expo-native-ui", by_skill)
        self.assertTrue(by_skill["expo-data-fetching"].static_uptake_checks)

    def test_case_spec_loads_core_case_without_skill_family(self):
        with tempfile.TemporaryDirectory() as td:
            spec_path = Path(td) / "case.json"
            spec_path.write_text(json.dumps({
                "id": "settings-ui",
                "feature_focus": "native settings screen",
                "expected_skills": ["expo-native-ui", "expo-ui"],
                "static_uptake_checks": [
                    {"id": "uses_expo_ui", "kind": "import", "target": "@expo/ui"}
                ],
            }))

            spec = load_case_spec(spec_path)

        self.assertEqual(spec.id, "settings-ui")
        self.assertEqual(spec.expected_skills, ["expo-native-ui", "expo-ui"])
        self.assertFalse(hasattr(spec, "skill_family"))
        self.assertFalse(hasattr(spec, "test_plan"))

    def test_detect_triggered_skills_reads_claude_skill_tool_calls(self):
        trace = _trace("claude-code", [
            [{"name": "Bash", "args": {"command": "git status"}}],
            [{"name": "Skill", "args": {"skill": "expo:expo-dev-client"}}],
        ])

        self.assertEqual(detect_triggered_skills(trace), ["expo-dev-client"])

    def test_detect_triggered_skills_reads_codex_exec_command_skill_paths(self):
        trace = _trace("codex", [
            [{"name": "exec_command", "args": {"cmd": "cat .agents/skills/expo-data-fetching/SKILL.md"}}],
        ])

        self.assertEqual(detect_triggered_skills(trace), ["expo-data-fetching"])

    def test_detect_triggered_skills_ignores_incidental_text_mentions(self):
        # Regression guard: earlier substring-matching flagged skill names
        # appearing in unrelated command output (npm/package.json, git status)
        # as "triggered". Structured detection must not resurrect that.
        trace = _trace("codex", [
            [{"name": "exec_command", "args": {"cmd": "npm install", "output": "added @expo/ui and expo-data-fetching refs"}}],
        ])

        self.assertEqual(detect_triggered_skills(trace), [])

    def test_trigger_quality_requires_the_right_skills(self):
        trace = _trace("claude-code", [
            [{"name": "Skill", "args": {"skill": "expo:expo-dev-client"}}],
        ])

        observed = detect_triggered_skills(trace)
        score = score_trigger_quality(["expo-native-ui", "expo-ui"], observed)

        self.assertEqual(observed, ["expo-dev-client"])
        self.assertEqual(score.expected_skills, ["expo-native-ui", "expo-ui"])
        self.assertEqual(score.triggered_skills, ["expo-dev-client"])
        self.assertEqual(score.recall, 0.0)
        self.assertEqual(score.precision, 0.0)
        self.assertTrue(score.any_expo_skill_triggered)

    def test_score_trigger_quality_perfect_when_nothing_expected_or_triggered(self):
        # The negative-control case: expected=[] (skills_unavailable) and the
        # detector correctly found nothing -> both recall and precision read
        # as a clean pass, not "undefined".
        score = score_trigger_quality([], [])

        self.assertEqual(score.recall, 1.0)
        self.assertEqual(score.precision, 1.0)
        self.assertEqual(score.extra_skills, [])

    def test_score_trigger_quality_flags_unexpected_trigger_as_low_precision(self):
        # If something fires despite being unavailable/unexpected, that's a
        # real false positive and precision must reflect it.
        score = score_trigger_quality([], ["expo-ui"])

        self.assertEqual(score.precision, 0.0)
        self.assertEqual(score.extra_skills, ["expo-ui"])

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

    def test_aggregate_skill_results_computes_outcome_delta_from_baseline(self):
        runs = [
            {"skill_id": "expo-ui", "scenario": "skills_unavailable", "trigger_recall": 1,
             "trigger_precision": 1, "trigger_exact_match": True, "uptake_rate": None,
             "evaluator_pct": 50, "build_success": True},
            {"skill_id": "expo-ui", "scenario": "skills_available_unmentioned", "trigger_recall": 1,
             "trigger_precision": 1, "trigger_exact_match": True, "uptake_rate": 1,
             "evaluator_pct": 70, "build_success": True},
            {"skill_id": "expo-ui", "scenario": "skills_available_mentioned", "trigger_recall": 1,
             "trigger_precision": 1, "trigger_exact_match": True, "uptake_rate": 0.5,
             "evaluator_pct": 80, "build_success": True},
        ]

        aggregate = aggregate_skill_results(runs)

        self.assertEqual(aggregate["expo-ui"]["baseline_evaluator_pct"], 50.0)
        self.assertEqual(aggregate["expo-ui"]["skill_evaluator_pct"], 75.0)
        self.assertEqual(aggregate["expo-ui"]["outcome_delta"], 25.0)
        self.assertEqual(aggregate["expo-ui"]["trigger_accuracy"], 1.0)
        self.assertNotIn("classification", aggregate["expo-ui"])

    def test_unpack_and_discover_authored_artifact_layout_from_tarball(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            app = source / "agent-workspace" / "run-1"
            traces = source / "eval-out" / "run-1" / "bundle" / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (traces / "claude-authoring.json").write_text(json.dumps(_trace("claude-code", [])))
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
            prd_skills_path, case_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            traces = bundle / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "index.tsx").write_text("import { Host } from '@expo/ui';\nexport default Host;\n")
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD}))
            trace = _trace("claude-code", [[{"name": "Skill", "args": {"skill": "expo:expo-ui"}}]])
            trace["braintrust_url"] = "https://www.braintrust.dev/app/project/traces/abc"
            (traces / "claude-code-authoring.json").write_text(json.dumps(trace))

            payload = analyze_artifacts(
                authored, None, "skills_available_unmentioned", root / "out",
                prd_skills_path=prd_skills_path, case_dir=case_dir,
            )

            self.assertEqual(payload["outcome_status"], "pending")
            self.assertEqual(payload["runs"][0]["trigger_recall"], 1.0)
            self.assertTrue(payload["runs"][0]["trigger_exact_match"])
            self.assertEqual(payload["runs"][0]["uptake_rate"], 1.0)
            self.assertIn("https://www.braintrust.dev/app/project/traces/abc", payload["braintrust_refs"])
            self.assertTrue((root / "out" / "metrics.json").exists())
            self.assertTrue((root / "out" / "report.html").exists())

    def test_analyze_artifacts_merges_eval_result(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, case_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            traces = bundle / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "index.tsx").write_text("import { Host } from '@expo/ui';\nexport default Host;\n")
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD}))
            trace = _trace("claude-code", [[{"name": "Skill", "args": {"skill": "expo:expo-ui"}}]])
            (traces / "claude-code-authoring.json").write_text(json.dumps(trace))
            eval_out = root / "eval"
            result = eval_out / "eval-out" / "run-1" / "bundle" / "eval"
            result.mkdir(parents=True, exist_ok=True)
            (result / "result.json").write_text(json.dumps({"macro_avg_pct": 87.5}))

            payload = analyze_artifacts(
                authored, eval_out, "skills_available_mentioned", root / "out",
                prd_skills_path=prd_skills_path, case_dir=case_dir,
            )

        self.assertEqual(payload["outcome_status"], "complete")
        self.assertEqual(payload["runs"][0]["evaluator_pct"], 87.5)
        self.assertTrue(payload["runs"][0]["build_success"])
        self.assertEqual(payload["skills"]["expo-ui"]["trigger_recall"], 1.0)
        self.assertNotIn("classification", payload["skills"]["expo-ui"])

    def test_analyze_artifacts_marks_missing_trace_without_crashing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, case_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            app.mkdir(parents=True)
            bundle.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "index.tsx").write_text("import { Host } from '@expo/ui';\nexport default Host;\n")
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD}))

            payload = analyze_artifacts(
                authored, None, "skills_available_unmentioned", root / "out",
                prd_skills_path=prd_skills_path, case_dir=case_dir,
            )

        self.assertIn("author trace not found", payload["warnings"])
        self.assertEqual(payload["runs"][0]["trigger_recall"], 0.0)
        self.assertIsNone(payload["runs"][0]["uptake_rate"])

    def test_analyze_artifacts_marks_missing_app_without_crashing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, case_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            traces = bundle / "telemetry" / "traces"
            traces.mkdir(parents=True)
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD}))
            trace = _trace("claude-code", [[{"name": "Skill", "args": {"skill": "expo:expo-ui"}}]])
            (traces / "claude-code-authoring.json").write_text(json.dumps(trace))

            payload = analyze_artifacts(
                authored, None, "skills_available_unmentioned", root / "out",
                prd_skills_path=prd_skills_path, case_dir=case_dir,
            )

        self.assertIn("app tree not found", payload["warnings"])
        self.assertEqual(payload["static_checks"], [])
        self.assertEqual(payload["runs"][0]["uptake_rate"], 0.0)

    def test_analyze_artifacts_forces_empty_expectation_for_unavailable_scenario(self):
        # The negative-control scenario: even though the app's ground truth
        # declares expected skills, "skills_unavailable" must zero it out, so
        # a clean (correctly silent) run scores as a pass, not "missing skill".
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, case_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            traces = bundle / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {}}))
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD}))
            trace = _trace("claude-code", [[{"name": "Bash", "args": {"command": "ls"}}]])
            (traces / "claude-code-authoring.json").write_text(json.dumps(trace))

            payload = analyze_artifacts(
                authored, None, "skills_unavailable", root / "out",
                prd_skills_path=prd_skills_path, case_dir=case_dir,
            )

        self.assertEqual(payload["runs"][0]["skill_id"], "")
        self.assertEqual(payload["runs"][0]["trigger_recall"], 1.0)
        self.assertEqual(payload["runs"][0]["trigger_precision"], 1.0)
        self.assertTrue(payload["runs"][0]["trigger_exact_match"])

    def test_analyze_artifacts_prefers_manifest_scenario_over_input(self):
        # Ground-truth provenance: the scenario actually recorded at authoring
        # time wins over a mismatched --scenario input, with a warning noting
        # the mismatch rather than silently trusting the wrong one.
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, case_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            traces = bundle / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({"dependencies": {}}))
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD, "scenario": "skills_unavailable"}))
            trace = _trace("claude-code", [])
            (traces / "claude-code-authoring.json").write_text(json.dumps(trace))

            payload = analyze_artifacts(
                authored, None, "skills_available_mentioned", root / "out",
                prd_skills_path=prd_skills_path, case_dir=case_dir,
            )

        self.assertEqual(payload["scenario"], "skills_unavailable")
        self.assertTrue(any("scenario mismatch" in w for w in payload["warnings"]))

    def test_analyze_artifacts_warns_when_app_missing_from_prd_skills_map(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, case_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            bundle.mkdir(parents=True)
            (bundle / "manifest.json").write_text(json.dumps({"prd": "dataset/prds/unmapped-app/prd/mvp.txt"}))

            payload = analyze_artifacts(
                authored, None, "skills_available_unmentioned", root / "out",
                prd_skills_path=prd_skills_path, case_dir=case_dir,
            )

        self.assertEqual(payload["expected_skills"], [])
        self.assertTrue(any("no ground-truth skill set" in w for w in payload["warnings"]))

    def _write_ground_truth(self, root: Path, *skills: str) -> tuple[Path, Path]:
        """Write a minimal dataset/prd_skills.json (app "test-app" -> skills)
        plus a case-spec directory covering each skill, mirroring the real
        dataset/prd_skills.json + skill_cases/core5 pairing."""
        prd_skills_path = root / "prd_skills.json"
        prd_skills_path.write_text(json.dumps({"test-app": list(skills)}))

        case_dir = root / "cases"
        case_dir.mkdir(exist_ok=True)
        for skill in skills:
            (case_dir / f"{skill}.json").write_text(json.dumps({
                "id": skill,
                "feature_focus": "artifact analysis",
                "expected_skills": [skill],
                "static_uptake_checks": [
                    {"id": "uses_expo_ui", "kind": "import", "target": "@expo/ui"}
                ],
            }))
        return prd_skills_path, case_dir


if __name__ == "__main__":
    unittest.main()
