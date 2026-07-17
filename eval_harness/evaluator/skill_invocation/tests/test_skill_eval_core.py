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
from eval_harness.evaluator.skill_invocation.uptake_checks.registry import (
    all_checks,
    load_checks_data,
    load_skill_map,
    resolve_checks_for_skills,
    run_checks,
)
from eval_harness.evaluator.skill_invocation.uptake_checks.trigger import (
    detect_triggered_skills,
    score_trigger_quality,
)
from eval_harness.evaluator.skill_invocation.uptake_checks.checks_ast import (
    check_router_layout_defines_navigator,
)
from eval_harness.evaluator.skill_invocation.uptake_checks.registry import AppTree
from eval_harness.evaluator.skill_invocation.build_health.syntax_check import check_syntax
from eval_harness.evaluator.skill_invocation.utils import unpack_artifact

TEST_PRD = "dataset/prds/test-app/prd/mvp.txt"
REAL_CHECKS_DIR = Path(__file__).parents[1] / "uptake_checks"


def _trace(agent, tool_calls_by_step):
    """Build a minimal real-shaped trace: one session, one turn, one step per
    tool_calls list given."""
    steps = [{"text": "", "reasoning": "", "tool_calls": calls} for calls in tool_calls_by_step]
    return {"agent": agent, "sessions": [{"turns": [{"steps": steps}]}]}


def _write_checks_dir(root: Path, checks: list[dict], skill_map: dict[str, list[str]]) -> Path:
    """Write a throwaway uptake_checks-shaped directory (checks_data.json +
    skill_map.json) for tests that don't want the real, evolving check set."""
    checks_dir = root / "uptake_checks"
    checks_dir.mkdir(parents=True, exist_ok=True)
    (checks_dir / "checks_data.json").write_text(json.dumps({"checks": checks}))
    (checks_dir / "skill_map.json").write_text(json.dumps(skill_map))
    return checks_dir


class SkillEvalCoreTests(unittest.TestCase):
    def test_real_checks_data_loads(self):
        checks = load_checks_data(REAL_CHECKS_DIR)
        self.assertIn("router_navigation_api_used", checks)
        self.assertIn("project_structure_components_dir_exists", checks)

    def test_real_skill_map_references_only_known_checks(self):
        skill_map = load_skill_map(REAL_CHECKS_DIR)
        checks = all_checks(REAL_CHECKS_DIR)

        self.assertIn("expo-router", skill_map)
        self.assertIn("expo-project-structure", skill_map)
        for skill_id, check_ids in skill_map.items():
            for check_id in check_ids:
                self.assertIn(check_id, checks, f"{skill_id} references unknown check {check_id!r}")

    def test_real_skill_map_allows_a_check_to_be_shared_across_skills(self):
        # app_dir_exists is deliberately claimed by both skills -- this is the
        # many-to-many hooking the registry is designed to support.
        skill_map = load_skill_map(REAL_CHECKS_DIR)

        self.assertIn("router_app_dir_exists", skill_map["expo-router"])
        self.assertIn("router_app_dir_exists", skill_map["expo-project-structure"])

    def test_app_name_from_prd_extracts_app_segment(self):
        from eval_harness.evaluator.skill_invocation.utils import app_name_from_prd

        self.assertEqual(app_name_from_prd("dataset/prds/notes/prd/mvp.txt"), "notes")
        self.assertIsNone(app_name_from_prd("some/other/path.txt"))

    def test_detect_triggered_skills_reads_claude_skill_tool_calls(self):
        trace = _trace("claude-code", [
            [{"name": "Bash", "args": {"command": "git status"}}],
            [{"name": "Skill", "args": {"skill": "expo:expo-router"}}],
        ])

        self.assertEqual(detect_triggered_skills(trace), ["expo-router"])

    def test_detect_triggered_skills_reads_codex_exec_command_skill_paths(self):
        trace = _trace("codex", [
            [{"name": "exec_command", "args": {"cmd": "cat .agents/skills/expo-router/SKILL.md"}}],
        ])

        self.assertEqual(detect_triggered_skills(trace), ["expo-router"])

    def test_detect_triggered_skills_ignores_incidental_text_mentions(self):
        # Regression guard: earlier substring-matching flagged skill names
        # appearing in unrelated command output (npm/package.json, git status)
        # as "triggered". Structured detection must not resurrect that.
        trace = _trace("codex", [
            [{"name": "exec_command", "args": {"cmd": "npm install", "output": "added @expo/ui and expo-router refs"}}],
        ])

        self.assertEqual(detect_triggered_skills(trace), [])

    def test_trigger_quality_requires_the_right_skills(self):
        trace = _trace("claude-code", [
            [{"name": "Skill", "args": {"skill": "expo:expo-data-fetching"}}],
        ])

        observed = detect_triggered_skills(trace)
        score = score_trigger_quality(["expo-router", "expo-project-structure"], observed)

        self.assertEqual(observed, ["expo-data-fetching"])
        self.assertEqual(score.expected_skills, ["expo-router", "expo-project-structure"])
        self.assertEqual(score.triggered_skills, ["expo-data-fetching"])
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

    def test_resolve_checks_for_skills_dedupes_shared_checks(self):
        with tempfile.TemporaryDirectory() as td:
            checks_dir = _write_checks_dir(
                Path(td),
                checks=[
                    {"id": "shared", "tier": "T2", "kind": "path_exists", "target": ["app"]},
                    {"id": "router_only", "tier": "T1", "kind": "import", "target": "expo-router"},
                ],
                skill_map={"skill-a": ["shared", "router_only"], "skill-b": ["shared"]},
            )

            checks, warnings = resolve_checks_for_skills(["skill-a", "skill-b"], checks_dir)

        self.assertEqual(warnings, [])
        self.assertEqual([c.id for c in checks], ["shared", "router_only"])

    def test_resolve_checks_for_skills_warns_on_unmapped_skill(self):
        with tempfile.TemporaryDirectory() as td:
            checks_dir = _write_checks_dir(Path(td), checks=[], skill_map={})

            checks, warnings = resolve_checks_for_skills(["expo-ui"], checks_dir)

        self.assertEqual(checks, [])
        self.assertIn("no uptake checks mapped for skill 'expo-ui'", warnings)

    def test_resolve_checks_for_skills_warns_on_unknown_check_id(self):
        with tempfile.TemporaryDirectory() as td:
            checks_dir = _write_checks_dir(
                Path(td), checks=[], skill_map={"expo-ui": ["does_not_exist"]}
            )

            checks, warnings = resolve_checks_for_skills(["expo-ui"], checks_dir)

        self.assertEqual(checks, [])
        self.assertIn("skill_map references unknown check id 'does_not_exist'", warnings)

    def test_lexical_check_uses_regex_not_bare_substring(self):
        # Regression guard for the known false positive: "List" is a
        # substring of "FlatList", so a bare substring match would wrongly
        # pass an app using the exact wrong component.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "index.tsx").write_text("import { FlatList } from 'react-native';\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "uses_list_tag", "tier": "T1", "kind": "text", "target": "<List[\\s/>]"}],
                skill_map={"expo-ui": ["uses_list_tag"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-ui"], checks_dir)
            results = run_checks(checks, app)

        self.assertFalse(results[0].passed)

    def test_lexical_check_strips_comments_before_matching(self):
        # Regression guard: a stray comment with no real implementation must
        # not satisfy a check.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "index.tsx").write_text("// TODO: add loading state\nexport default function App(){ return null; }\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "has_loading_state", "tier": "T1", "kind": "text", "target": "loading"}],
                skill_map={"expo-ui": ["has_loading_state"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-ui"], checks_dir)
            results = run_checks(checks, app)

        self.assertFalse(results[0].passed)

    def test_lexical_check_ignores_scripts_dir_boilerplate(self):
        # Regression guard: found live against a real authored wiki_reader
        # app. create-expo-app's standard scripts/reset-project.js embeds
        # example code as string template literals (e.g. a literal
        # `import { Stack } from "expo-router"` inside a JS template string
        # it writes out) -- that must not count as real app evidence. Also
        # matches expo-project-structure's own SKILL.md, which lists
        # scripts/ as living outside src/ (tooling, not app code).
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "scripts").mkdir()
            (app / "scripts" / "reset-project.js").write_text(
                'const layoutContent = `import { Stack } from "expo-router";\\n'
                'export default function Layout() { return <Stack />; }`;\n'
            )
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "uses_router", "tier": "T1", "kind": "import", "target": "expo-router"}],
                skill_map={"expo-router": ["uses_router"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-router"], checks_dir)
            results = run_checks(checks, app)

        self.assertFalse(results[0].passed)
        self.assertNotIn("reset-project.js", results[0].evidence)

    def test_path_checks_ignore_scripts_dir(self):
        # Same regression, for path_exists/path_absent -- scripts/ must be
        # excluded from structural checks too, not just lexical ones.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "scripts" / "__tests__").mkdir(parents=True)
            (app / "scripts" / "__tests__" / "reset.test.js").write_text("test();\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "no_dunder_tests", "tier": "T2", "kind": "path_absent", "target": ["**/__tests__/**"]}],
                skill_map={"expo-project-structure": ["no_dunder_tests"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-project-structure"], checks_dir)
            results = run_checks(checks, app)

        self.assertTrue(results[0].passed)

    def test_import_and_text_any_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            src = app / "app"
            src.mkdir()
            (src / "index.tsx").write_text(
                "import { Host, List } from '@expo/ui';\n"
                "export default function App(){ return <Host><List /></Host>; }\n"
            )
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[
                    {"id": "uses_expo_ui", "tier": "T1", "kind": "import", "target": "@expo/ui"},
                    {"id": "uses_host_or_list", "tier": "T1", "kind": "text_any", "target": ["<Host[\\s/>]", "<List[\\s/>]"]},
                ],
                skill_map={"expo-ui": ["uses_expo_ui", "uses_host_or_list"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-ui"], checks_dir)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["uses_expo_ui"].passed)
        self.assertTrue(results["uses_host_or_list"].passed)

    def test_path_exists_and_path_absent_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[
                    {"id": "app_dir_exists", "tier": "T2", "kind": "path_exists", "target": ["app", "src/app"]},
                    {"id": "no_styles_files", "tier": "T2", "kind": "path_absent", "target": ["**/*.styles.ts"]},
                ],
                skill_map={"expo-router": ["app_dir_exists", "no_styles_files"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-router"], checks_dir)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["app_dir_exists"].passed)
        self.assertTrue(results["no_styles_files"].passed)

    def test_path_absent_check_fails_when_anti_pattern_present(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app" / "utils").mkdir(parents=True)
            (app / "app" / "utils" / "format.ts").write_text("export const x = 1;\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "no_colocated_utils", "tier": "T2", "kind": "path_absent", "target": ["app/utils"]}],
                skill_map={"expo-router": ["no_colocated_utils"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-router"], checks_dir)
            results = run_checks(checks, app)

        self.assertFalse(results[0].passed)

    def test_static_text_checks_ignore_package_manifests_and_lockfiles(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"scripts": {"error": "echo error"}}))
            (app / "package-lock.json").write_text(json.dumps({"packages": {"error": {}}}))
            src = app / "app"
            src.mkdir()
            (src / "index.tsx").write_text("export default function App(){ return null; }\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "has_error_state", "tier": "T1", "kind": "text", "target": "error"}],
                skill_map={"expo-ui": ["has_error_state"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-ui"], checks_dir)
            results = run_checks(checks, app)

        self.assertFalse(results[0].passed)
        self.assertIn("No source file", results[0].evidence)

    def test_ast_check_passes_when_layout_actually_renders_a_navigator(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "import { Stack } from 'expo-router';\n"
                "export default function Layout() { return <Stack />; }\n"
            )

            result = check_router_layout_defines_navigator(AppTree(app))

        self.assertTrue(result.passed, result.evidence)
        self.assertEqual(result.tier, "T3")

    def test_ast_check_fails_on_unused_navigator_import(self):
        # This is the whole point of tier 3 over tier 1: a tier-1 text_any
        # check on "Stack" would pass here (the word appears), but the JSX
        # tree never actually renders it -- only an AST-aware check can tell
        # the difference between "imported" and "used".
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "import { Stack } from 'expo-router';\n"
                "export default function Layout() { return <View />; }\n"
            )

            result = check_router_layout_defines_navigator(AppTree(app))

        self.assertFalse(result.passed)

    def test_ast_check_accepts_drawer_navigator(self):
        # Regression guard: found live against a real authored wiki_reader
        # app using expo-router/drawer -- a Stack/Tabs/NativeTabs-only
        # accepted-tag list would have false-negatived on legitimate code.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "import { Drawer } from 'expo-router/drawer';\n"
                "export default function Layout() { return <Drawer />; }\n"
            )

            result = check_router_layout_defines_navigator(AppTree(app))

        self.assertTrue(result.passed, result.evidence)

    def test_ast_check_degrades_gracefully_on_broken_syntax(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text("export default function Layout() { return <Stack")

            result = check_router_layout_defines_navigator(AppTree(app))

        self.assertFalse(result.passed)
        self.assertIn("syntax error", result.evidence)

    def test_ast_check_fails_clearly_when_no_layout_file_exists(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            result = check_router_layout_defines_navigator(AppTree(app))

        self.assertFalse(result.passed)
        self.assertIn("no _layout file found", result.evidence)

    def test_syntax_check_passes_on_valid_source(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            result = check_syntax(app)

        self.assertTrue(result["ok"])
        self.assertEqual(result["failed_files"], [])
        self.assertEqual(result["checked_files"], 1)

    def test_syntax_check_catches_a_real_broken_file(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")
            (app / "app" / "broken.tsx").write_text("export default function Broken() { return <View")

            result = check_syntax(app)

        self.assertFalse(result["ok"])
        self.assertEqual(len(result["failed_files"]), 1)
        self.assertEqual(result["failed_files"][0]["file"], "app/broken.tsx")

    def test_syntax_check_ignores_scripts_dir_boilerplate(self):
        # Same scripts/ exclusion as the lexical checks -- a broken/unusual
        # file inside create-expo-app's boilerplate scripts/ shouldn't fail
        # the whole app's syntax signal.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")
            (app / "scripts").mkdir()
            (app / "scripts" / "reset-project.js").write_text("this is `not even valid at all")

            result = check_syntax(app)

        self.assertTrue(result["ok"])
        self.assertEqual(result["checked_files"], 1)

    def test_tier_breakdown_groups_by_tier(self):
        from eval_harness.evaluator.skill_invocation.uptake_checks.registry import UptakeResults, CheckResult

        results = UptakeResults([
            CheckResult("a", "T1", "text", "x", True, ""),
            CheckResult("b", "T1", "text", "y", False, ""),
            CheckResult("c", "T2", "path_exists", ["z"], True, ""),
        ])

        breakdown = results.tier_breakdown()

        self.assertEqual(breakdown["T1"], {"passed": 1, "total": 2})
        self.assertEqual(breakdown["T2"], {"passed": 1, "total": 1})

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
            prd_skills_path, checks_dir = self._write_ground_truth(root, "expo-ui")
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
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
            )

            self.assertEqual(payload["outcome_status"], "pending")
            self.assertEqual(payload["runs"][0]["trigger_recall"], 1.0)
            self.assertTrue(payload["runs"][0]["trigger_exact_match"])
            self.assertEqual(payload["runs"][0]["uptake_rate"], 1.0)
            self.assertIn("T1", payload["tier_breakdown"])
            self.assertIn("https://www.braintrust.dev/app/project/traces/abc", payload["braintrust_refs"])
            self.assertTrue((root / "out" / "metrics.json").exists())
            self.assertTrue((root / "out" / "report.html").exists())

    def test_analyze_artifacts_merges_eval_result(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, checks_dir = self._write_ground_truth(root, "expo-ui")
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
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
            )

        self.assertEqual(payload["outcome_status"], "complete")
        self.assertEqual(payload["runs"][0]["evaluator_pct"], 87.5)
        self.assertTrue(payload["runs"][0]["build_success"])
        self.assertEqual(payload["skills"]["expo-ui"]["trigger_recall"], 1.0)
        self.assertNotIn("classification", payload["skills"]["expo-ui"])

    def test_analyze_artifacts_marks_missing_trace_without_crashing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, checks_dir = self._write_ground_truth(root, "expo-ui")
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
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
            )

        self.assertIn("author trace not found", payload["warnings"])
        self.assertEqual(payload["runs"][0]["trigger_recall"], 0.0)
        self.assertIsNone(payload["runs"][0]["uptake_rate"])

    def test_analyze_artifacts_marks_missing_app_without_crashing(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, checks_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            traces = bundle / "telemetry" / "traces"
            traces.mkdir(parents=True)
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD}))
            trace = _trace("claude-code", [[{"name": "Skill", "args": {"skill": "expo:expo-ui"}}]])
            (traces / "claude-code-authoring.json").write_text(json.dumps(trace))

            payload = analyze_artifacts(
                authored, None, "skills_available_unmentioned", root / "out",
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
            )

        self.assertIn("app tree not found", payload["warnings"])
        self.assertEqual(payload["static_checks"], [])
        self.assertEqual(payload["runs"][0]["uptake_rate"], 0.0)

    def test_analyze_artifacts_warns_when_skill_not_in_skill_map(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, checks_dir = self._write_ground_truth(root)  # empty skill_map
            authored = root / "authored"
            app = authored / "agent-workspace" / "run-1"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            traces = bundle / "telemetry" / "traces"
            app.mkdir(parents=True)
            traces.mkdir(parents=True)
            (app / "package.json").write_text(json.dumps({}))
            (bundle / "manifest.json").write_text(json.dumps({"prd": TEST_PRD}))
            (traces / "claude-code-authoring.json").write_text(json.dumps(_trace("claude-code", [])))
            # override the ground truth to expect a skill absent from skill_map.json
            prd_skills_path.write_text(json.dumps({"test-app": ["expo-ui"]}))

            payload = analyze_artifacts(
                authored, None, "skills_available_unmentioned", root / "out",
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
            )

        self.assertIn("no uptake checks mapped for skill 'expo-ui'", payload["warnings"])

    def test_analyze_artifacts_forces_empty_expectation_for_unavailable_scenario(self):
        # The negative-control scenario: even though the app's ground truth
        # declares expected skills, "skills_unavailable" must zero it out, so
        # a clean (correctly silent) run scores as a pass, not "missing skill".
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, checks_dir = self._write_ground_truth(root, "expo-ui")
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
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
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
            prd_skills_path, checks_dir = self._write_ground_truth(root, "expo-ui")
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
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
            )

        self.assertEqual(payload["scenario"], "skills_unavailable")
        self.assertTrue(any("scenario mismatch" in w for w in payload["warnings"]))

    def test_analyze_artifacts_warns_when_app_missing_from_prd_skills_map(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            prd_skills_path, checks_dir = self._write_ground_truth(root, "expo-ui")
            authored = root / "authored"
            bundle = authored / "eval-out" / "run-1" / "bundle"
            bundle.mkdir(parents=True)
            (bundle / "manifest.json").write_text(json.dumps({"prd": "dataset/prds/unmapped-app/prd/mvp.txt"}))

            payload = analyze_artifacts(
                authored, None, "skills_available_unmentioned", root / "out",
                prd_skills_path=prd_skills_path, checks_dir=checks_dir,
            )

        self.assertEqual(payload["expected_skills"], [])
        self.assertTrue(any("no ground-truth skill set" in w for w in payload["warnings"]))

    def _write_ground_truth(self, root: Path, *skills: str) -> tuple[Path, Path]:
        """Write a minimal dataset/prd_skills.json (app "test-app" -> skills)
        plus an uptake_checks-shaped dir (checks_data.json + skill_map.json)
        covering each skill with one 'import @expo/ui' check, mirroring the
        real dataset/prd_skills.json + uptake_checks pairing."""
        prd_skills_path = root / "prd_skills.json"
        prd_skills_path.write_text(json.dumps({"test-app": list(skills)}))

        checks_dir = _write_checks_dir(
            root,
            checks=[{"id": "uses_expo_ui", "tier": "T1", "kind": "import", "target": "@expo/ui"}],
            skill_map={skill: ["uses_expo_ui"] for skill in skills},
        )
        return prd_skills_path, checks_dir


if __name__ == "__main__":
    unittest.main()
