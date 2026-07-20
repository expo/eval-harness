import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from eval_harness.evaluator.skill_invocation.analysis import (
    aggregate_skill_results,
    analyze_artifacts,
    compute_skill_results,
    discover_artifact_layout,
    score_case_run,
)
from eval_harness.evaluator.skill_invocation.uptake_checks.registry import (
    Check,
    all_checks,
    load_checks_data,
    load_skill_map,
    resolve_checks_by_skill,
    resolve_checks_for_skills,
    run_checks,
)
from eval_harness.evaluator.skill_invocation.uptake_checks.trigger import (
    detect_triggered_skills,
    score_trigger_quality,
)
from eval_harness.evaluator.skill_invocation.build_health.syntax_check import check_syntax
from eval_harness.evaluator.skill_invocation.build_health.bundle_check import (
    compute_bundle_result,
    persist_bundle_result,
    read_bundle_result,
)
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
                    {"id": "shared", "category": "structural", "kind": "path_exists", "target": ["app"]},
                    {"id": "router_only", "category": "lexical", "kind": "import", "target": "expo-router"},
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
                checks=[{"id": "uses_list_tag", "category": "lexical", "kind": "text", "target": "<List[\\s/>]"}],
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
                checks=[{"id": "has_loading_state", "category": "lexical", "kind": "text", "target": "loading"}],
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
                checks=[{"id": "uses_router", "category": "lexical", "kind": "import", "target": "expo-router"}],
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
                checks=[{"id": "no_dunder_tests", "category": "structural", "kind": "path_absent", "target": ["**/__tests__/**"]}],
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
                    {"id": "uses_expo_ui", "category": "lexical", "kind": "import", "target": "@expo/ui"},
                    {"id": "uses_host_or_list", "category": "lexical", "kind": "text_any", "target": ["<Host[\\s/>]", "<List[\\s/>]"]},
                ],
                skill_map={"expo-ui": ["uses_expo_ui", "uses_host_or_list"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-ui"], checks_dir)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["uses_expo_ui"].passed)
        self.assertTrue(results["uses_host_or_list"].passed)

    def test_real_navigator_check_accepts_drawer(self):
        # Regression guard: found live against a real authored wiki_reader
        # app using expo-router/drawer's <Drawer> -- a Stack/Tabs/NativeTabs-
        # only accepted-tag list would have false-negatived on this
        # legitimate code. Exercises the real checks_data.json entry, not a
        # synthetic copy, so this catches the tag list ever regressing.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "import { Drawer } from 'expo-router/drawer';\n"
                "export default function Layout() { return <Drawer />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["router_navigator_jsx_tag"].passed)

    def test_compute_skill_results_gives_each_skill_independent_trigger_and_uptake(self):
        # SKILL_EVALUATOR_REVIEW.md finding 1: two expected skills, only one
        # triggers -- each must get its own result, not a shared pooled
        # number. Also covers "static uptake is still reported when an
        # expected skill was not triggered" -- expo-ui's uptake is measured
        # even though it never triggered.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import { Stack } from 'expo-router';\n"
                "export default function App(){ return <Stack />; }\n"
            )
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[
                    {"id": "router_check", "category": "lexical", "kind": "import", "target": "expo-router"},
                    {"id": "ui_check", "category": "lexical", "kind": "import", "target": "@expo/ui"},
                ],
                skill_map={"expo-router": ["router_check"], "expo-ui": ["ui_check"]},
            )
            checks_by_skill, _ = resolve_checks_by_skill(["expo-router", "expo-ui"], checks_dir)
            pooled_checks, _ = resolve_checks_for_skills(["expo-router", "expo-ui"], checks_dir)
            results_by_id = {r.id: r for r in run_checks(pooled_checks, app)}

            skills = compute_skill_results(
                expected_skills=["expo-router", "expo-ui"],
                triggered_skills=["expo-router"],
                checks_by_skill=checks_by_skill,
                results_by_id=results_by_id,
                app_dir_missing=False,
            )

        self.assertTrue(skills["expo-router"]["triggered"])
        self.assertEqual(skills["expo-router"]["trigger_status"], "observed")
        self.assertEqual(skills["expo-router"]["uptake_rate"], 1.0)

        self.assertFalse(skills["expo-ui"]["triggered"])
        self.assertEqual(skills["expo-ui"]["trigger_status"], "not_observed")
        self.assertEqual(skills["expo-ui"]["uptake_status"], "measured")
        self.assertEqual(skills["expo-ui"]["uptake_rate"], 0.0)

    def test_compute_skill_results_projects_a_shared_check_into_both_skills(self):
        # A check mapped to two skills must contribute its full result to
        # both -- execution dedup (run once) is not an attribution rule.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "shared_check", "category": "structural", "kind": "path_exists", "target": ["app"]}],
                skill_map={"skill-a": ["shared_check"], "skill-b": ["shared_check"]},
            )
            checks_by_skill, _ = resolve_checks_by_skill(["skill-a", "skill-b"], checks_dir)
            pooled_checks, _ = resolve_checks_for_skills(["skill-a", "skill-b"], checks_dir)
            self.assertEqual(len(pooled_checks), 1, "shared check should only be executed once")
            results_by_id = {r.id: r for r in run_checks(pooled_checks, app)}

            skills = compute_skill_results(
                expected_skills=["skill-a", "skill-b"],
                triggered_skills=[],
                checks_by_skill=checks_by_skill,
                results_by_id=results_by_id,
                app_dir_missing=False,
            )

        self.assertEqual(skills["skill-a"]["uptake_rate"], 1.0)
        self.assertEqual(skills["skill-b"]["uptake_rate"], 1.0)
        self.assertTrue(skills["skill-a"]["checks"][0]["passed"])
        self.assertTrue(skills["skill-b"]["checks"][0]["passed"])

    def test_compute_skill_results_marks_unmapped_skill_unsupported(self):
        # An expected skill absent from skill_map.json must not look like
        # "zero checks needed, trivially satisfied".
        skills = compute_skill_results(
            expected_skills=["expo-ui"],
            triggered_skills=[],
            checks_by_skill={"expo-ui": None},
            results_by_id={},
            app_dir_missing=False,
        )

        self.assertEqual(skills["expo-ui"]["uptake_status"], "unsupported")
        self.assertIsNone(skills["expo-ui"]["uptake_rate"])
        self.assertIsNone(skills["expo-ui"]["total"])

    def test_compute_skill_results_marks_missing_app_distinct_from_measured_zero(self):
        # A missing app tree must not look like "measured, scored zero".
        checks_by_skill = {"expo-ui": [Check(id="c1", category="lexical", kind="import", target="@expo/ui")]}

        skills = compute_skill_results(
            expected_skills=["expo-ui"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id={},
            app_dir_missing=True,
        )

        self.assertEqual(skills["expo-ui"]["uptake_status"], "missing_app")
        self.assertIsNone(skills["expo-ui"]["uptake_rate"])
        self.assertEqual(skills["expo-ui"]["total"], 1)

    def test_compute_skill_results_marks_not_applicable_when_every_check_is_not_applicable(self):
        # Follow-up review regression guard: a skill whose every mapped
        # check comes back not_applicable (its precondition never held for
        # this app -- e.g. a static site with no API routes for eas-hosting)
        # must not read "measured" with passed=0/total=0, which would
        # contradict uptake_rate=None sitting right next to it.
        from eval_harness.evaluator.skill_invocation.uptake_checks.registry import CheckResult

        checks_by_skill = {"eas-hosting": [Check(id="c1", category="structural", kind="code", target=None)]}
        results_by_id = {"c1": CheckResult("c1", "structural", "code", None, None, "no +api routes found", "not_applicable")}

        skills = compute_skill_results(
            expected_skills=["eas-hosting"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )

        self.assertEqual(skills["eas-hosting"]["uptake_status"], "not_applicable")
        self.assertIsNone(skills["eas-hosting"]["uptake_rate"])
        self.assertEqual(skills["eas-hosting"]["total"], 0)

    def test_compute_skill_results_marks_unavailable_when_nothing_scored_and_something_unavailable(self):
        # Missing evidence outranks "doesn't apply": a mix of not_applicable
        # and unavailable with nothing scored must read unavailable, not
        # not_applicable -- at least one check couldn't even determine its
        # own applicability.
        from eval_harness.evaluator.skill_invocation.uptake_checks.registry import CheckResult

        checks_by_skill = {
            "expo-dom": [
                Check(id="c1", category="syntax-tree", kind="code", target=None),
                Check(id="c2", category="syntax-tree", kind="code", target=None),
            ]
        }
        results_by_id = {
            "c1": CheckResult("c1", "syntax-tree", "code", None, None, "no _layout files found", "not_applicable"),
            "c2": CheckResult("c2", "syntax-tree", "code", None, None, "parser could not run", "unavailable"),
        }

        skills = compute_skill_results(
            expected_skills=["expo-dom"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )

        self.assertEqual(skills["expo-dom"]["uptake_status"], "unavailable")
        self.assertIsNone(skills["expo-dom"]["uptake_rate"])

    def test_compute_skill_results_still_measured_when_at_least_one_check_scored(self):
        # Regression guard against over-correcting: a mix of a scored check
        # and a not_applicable one must still read "measured", using only
        # the scored one for passed/total.
        from eval_harness.evaluator.skill_invocation.uptake_checks.registry import CheckResult

        checks_by_skill = {
            "expo-dom": [
                Check(id="c1", category="syntax-tree", kind="code", target=None),
                Check(id="c2", category="syntax-tree", kind="code", target=None),
            ]
        }
        results_by_id = {
            "c1": CheckResult("c1", "syntax-tree", "code", None, True, "has a directive", "passed"),
            "c2": CheckResult("c2", "syntax-tree", "code", None, None, "no _layout files found", "not_applicable"),
        }

        skills = compute_skill_results(
            expected_skills=["expo-dom"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )

        self.assertEqual(skills["expo-dom"]["uptake_status"], "measured")
        self.assertEqual(skills["expo-dom"]["total"], 1)
        self.assertEqual(skills["expo-dom"]["uptake_rate"], 1.0)

    def test_compute_skill_results_unavailable_outranks_measured_when_mixed_with_scored(self):
        # Third review round (P2): a skill with one passing check and one
        # unavailable check used to read "measured" with uptake_rate=1.0 --
        # an unqualified 100% that overstates confidence when most of the
        # skill's mapped checks couldn't even be evaluated. Missing evidence
        # must outrank "measured" here, same as it already outranks
        # "not_applicable" when nothing scored at all.
        from eval_harness.evaluator.skill_invocation.uptake_checks.registry import CheckResult

        checks_by_skill = {
            "expo-dom": [
                Check(id="c1", category="syntax-tree", kind="code", target=None),
                Check(id="c2", category="syntax-tree", kind="code", target=None),
                Check(id="c3", category="syntax-tree", kind="code", target=None),
            ]
        }
        results_by_id = {
            "c1": CheckResult("c1", "syntax-tree", "code", None, True, "has a directive", "passed"),
            "c2": CheckResult("c2", "syntax-tree", "code", None, None, "parser could not run", "unavailable"),
            "c3": CheckResult("c3", "syntax-tree", "code", None, None, "parser could not run", "unavailable"),
        }

        skills = compute_skill_results(
            expected_skills=["expo-dom"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )

        self.assertEqual(skills["expo-dom"]["uptake_status"], "unavailable")
        # The partial numeric result is still preserved for anyone reading
        # past the status label.
        self.assertEqual(skills["expo-dom"]["total"], 1)
        self.assertEqual(skills["expo-dom"]["uptake_rate"], 1.0)

    def test_path_exists_and_path_absent_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[
                    {"id": "app_dir_exists", "category": "structural", "kind": "path_exists", "target": ["app", "src/app"]},
                    {"id": "no_styles_files", "category": "structural", "kind": "path_absent", "target": ["**/*.styles.ts"]},
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
                checks=[{"id": "no_colocated_utils", "category": "structural", "kind": "path_absent", "target": ["app/utils"]}],
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
                checks=[{"id": "has_error_state", "category": "lexical", "kind": "text", "target": "error"}],
                skill_map={"expo-ui": ["has_error_state"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-ui"], checks_dir)
            results = run_checks(checks, app)

        self.assertFalse(results[0].passed)
        self.assertIn("No source file", results[0].evidence)

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

    def test_bundle_check_reports_unknown_when_no_node_modules(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text("{}")

            result = compute_bundle_result(app)

        self.assertIsNone(result["ok"])
        self.assertIn("no node_modules", result["reason"])

    def test_bundle_check_degrades_gracefully_when_expo_binary_fails(self):
        # Doesn't need the real Expo CLI -- any failing "expo" binary
        # exercises the same non-zero-exit handling path.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            bin_dir = app / "node_modules" / ".bin"
            bin_dir.mkdir(parents=True)
            fake_expo = bin_dir / "expo"
            fake_expo.write_text("#!/bin/sh\necho 'boom' >&2\nexit 1\n")
            fake_expo.chmod(0o755)

            result = compute_bundle_result(app)

        self.assertFalse(result["ok"])
        self.assertIn("boom", result["reason"])

    def test_bundle_check_persist_and_read_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text("{}")

            self.assertIsNone(read_bundle_result(app))
            persisted = persist_bundle_result(app)
            reread = read_bundle_result(app)

        self.assertEqual(persisted, reread)
        self.assertIsNone(persisted["ok"])

    def test_category_breakdown_groups_by_category(self):
        from eval_harness.evaluator.skill_invocation.uptake_checks.registry import UptakeResults, CheckResult

        results = UptakeResults([
            CheckResult("a", "lexical", "text", "x", True, "", "passed"),
            CheckResult("b", "lexical", "text", "y", False, "", "failed"),
            CheckResult("c", "structural", "path_exists", ["z"], True, "", "passed"),
        ])

        breakdown = results.category_breakdown()

        self.assertEqual(breakdown["lexical"], {"passed": 1, "total": 2})
        self.assertEqual(breakdown["structural"], {"passed": 1, "total": 1})

    def test_category_breakdown_excludes_not_applicable_and_unavailable(self):
        # A not_applicable or unavailable check must not appear in the
        # denominator at all -- neither as a pass nor a fail.
        from eval_harness.evaluator.skill_invocation.uptake_checks.registry import UptakeResults, CheckResult

        results = UptakeResults([
            CheckResult("a", "lexical", "text", "x", True, "", "passed"),
            CheckResult("b", "lexical", "code", None, None, "no precondition", "not_applicable"),
            CheckResult("c", "syntax-tree", "code", None, None, "parser unavailable", "unavailable"),
        ])

        breakdown = results.category_breakdown()

        self.assertEqual(breakdown["lexical"], {"passed": 1, "total": 1})
        self.assertNotIn("syntax-tree", breakdown)
        self.assertEqual(results.passed, 1)
        self.assertEqual(results.total, 1)
        self.assertEqual(results.uptake_rate, 1.0)

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
            self.assertIn("lexical", payload["check_category_breakdown"])
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
        self.assertTrue(payload["skills"]["expo-ui"]["triggered"])
        self.assertEqual(payload["skills"]["expo-ui"]["trigger_status"], "observed")
        self.assertEqual(payload["skills"]["expo-ui"]["uptake_status"], "measured")
        self.assertEqual(payload["skills"]["expo-ui"]["uptake_rate"], 1.0)
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

    def test_project_structure_no_longer_mandates_stylesheet_create(self):
        # SKILL_UPTAKE_COVERAGE_ANALYSIS.md bug fix: expo-native-ui explicitly
        # prefers inline styles ("Inline styles not StyleSheet.create unless
        # reusing styles is faster"), so an affirmative "must use
        # StyleSheet.create" check false-negatives an app that correctly
        # followed expo-native-ui instead. The check (and its id) must be
        # gone entirely -- the real, uncontested rule (don't split styles
        # into a separate file) is still covered by
        # project_structure_no_separate_styles_files.
        checks = all_checks(REAL_CHECKS_DIR)
        skill_map = load_skill_map(REAL_CHECKS_DIR)

        self.assertNotIn("project_structure_uses_stylesheet_create", checks)
        self.assertNotIn(
            "project_structure_uses_stylesheet_create",
            skill_map["expo-project-structure"],
        )
        self.assertIn(
            "project_structure_no_separate_styles_files",
            skill_map["expo-project-structure"],
        )

    def test_no_shipped_check_bans_an_api_another_simultaneously_expected_skill_endorses(self):
        # Combined regression guard for both conflicts found this session:
        # (1) project_structure_uses_stylesheet_create vs expo-native-ui's
        # "inline styles... unless reusing styles is faster", and
        # (2) native_ui_no_platform_os vs expo-project-structure's "use
        # Platform.select/Platform.OS for small differences" and expo-ui's
        # own Platform.OS-guard examples. Both pairs of skills are expected
        # simultaneously for hot_chocolate/wiki_reader (dataset/prd_skills.json),
        # so a check that bans one skill's endorsed API can false-negative an
        # agent that correctly followed a *different* expected skill instead.
        checks = all_checks(REAL_CHECKS_DIR)

        self.assertNotIn("project_structure_uses_stylesheet_create", checks)
        self.assertNotIn("native_ui_no_platform_os", checks)

    def test_real_tsconfig_path_alias_check_shared_by_router_and_project_structure(self):
        skill_map = load_skill_map(REAL_CHECKS_DIR)

        self.assertIn("tsconfig_path_alias_configured", skill_map["expo-router"])
        self.assertIn("tsconfig_path_alias_configured", skill_map["expo-project-structure"])

    def test_tsconfig_path_alias_check_reads_compiler_options_paths(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "tsconfig.json").write_text(
                json.dumps({"compilerOptions": {"paths": {"@/*": ["./src/*"]}}})
            )
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "alias", "category": "structural", "kind": "tsconfig_path_alias", "target": "@/*"}],
                skill_map={"expo-router": ["alias"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-router"], checks_dir)
            result = run_checks(checks, app)[0]

        self.assertTrue(result.passed)

    def test_tsconfig_path_alias_check_fails_when_alias_absent(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "tsconfig.json").write_text(json.dumps({"compilerOptions": {}}))
            checks_dir = _write_checks_dir(
                Path(td) / "checks",
                checks=[{"id": "alias", "category": "structural", "kind": "tsconfig_path_alias", "target": "@/*"}],
                skill_map={"expo-router": ["alias"]},
            )

            checks, _ = resolve_checks_for_skills(["expo-router"], checks_dir)
            result = run_checks(checks, app)[0]

        self.assertFalse(result.passed)

    def test_real_router_not_found_route_check(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "+not-found.tsx").write_text("export default function NotFound(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["router_not_found_route_exists"].passed)

    def test_real_router_kebab_case_check_flags_pascal_case_route_file(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "SettingsScreen.tsx").write_text("export default function SettingsScreen(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["router_kebab_case_filenames_in_app_dir"].passed)

    def test_real_router_kebab_case_check_passes_for_dynamic_and_group_routes(self):
        # Regression guard: dynamic segments ([id].tsx) and route groups
        # ((tabs)/index.tsx) must not be mistaken for the PascalCase
        # anti-pattern -- neither contains an uppercase letter.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app" / "(tabs)").mkdir(parents=True)
            (app / "app" / "(tabs)" / "index.tsx").write_text("export default function Index(){ return null; }\n")
            (app / "app" / "[id].tsx").write_text("export default function Detail(){ return null; }\n")
            (app / "app" / "_layout.tsx").write_text("export default function Layout(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["router_kebab_case_filenames_in_app_dir"].passed)

    def test_real_router_illegal_group_only_file_check(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "(tabs).tsx").write_text("export default function Tabs(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["router_no_illegal_group_only_file"].passed)

    def test_real_router_illegal_group_only_file_check_allows_group_directory(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app" / "(tabs)").mkdir(parents=True)
            (app / "app" / "(tabs)" / "index.tsx").write_text("export default function Index(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["router_no_illegal_group_only_file"].passed)

    def test_real_native_ui_checks_flag_banned_apis(self):
        # Regression guard: an earlier draft also banned @expo/vector-icons
        # outright, but the real skill only discourages it for SF-Symbol
        # icon lookups specifically ("expo-image source='sf:name'... not
        # @expo/vector-icons") -- it's a general-purpose cross-platform icon
        # library otherwise (the only option on Android, where SF Symbols
        # don't exist), and both real hot_chocolate/wiki_reader apps use it
        # legitimately. That check was dropped rather than shipped imprecise.
        # Also dropped: native_ui_no_platform_os -- expo-project-structure
        # ("use Platform.select/Platform.OS for small differences") and
        # expo-ui (its own reference docs demonstrate Platform.OS guards)
        # both explicitly endorse Platform.OS, and both are expected
        # alongside expo-native-ui for hot_chocolate/wiki_reader. Same shape
        # as the StyleSheet conflict.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import { Video } from 'expo-av';\n"
                "import { View, SafeAreaView, Dimensions } from 'react-native';\n"
                "const { width } = Dimensions.get('window');\n"
                "if (Platform.OS === 'ios') {}\n"
                "export default function App(){ return <SafeAreaView />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-native-ui"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["native_ui_no_expo_av"].passed)
        self.assertFalse(results["native_ui_no_dimensions_get"].passed)
        self.assertFalse(results["native_ui_no_safe_area_view_from_react_native"].passed)
        self.assertNotIn("native_ui_no_legacy_vector_icons", results)
        self.assertNotIn("native_ui_no_platform_os", results)

    def test_real_native_ui_safe_area_view_check_ignores_correct_import(self):
        # The check must be anchored to the import statement, not a bare
        # word match -- importing SafeAreaView from the correct package must
        # not be flagged.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import { SafeAreaView } from 'react-native-safe-area-context';\n"
                "export default function App(){ return <SafeAreaView />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-native-ui"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["native_ui_no_safe_area_view_from_react_native"].passed)

    def test_real_native_ui_no_longer_shares_router_react_navigation_check(self):
        # Fourth review round: router_no_direct_react_navigation_import was
        # dropped from expo-native-ui's mapping. As a shared check with its
        # own engagement precondition gated on an expo-router import (not a
        # native-ui-specific signal), it was the last source of a vacuous
        # pass for a native-ui app with none of the skill's three checkable
        # features -- e.g. a bare expo-router app with no media/dimensions/
        # safe-area usage would otherwise read 1/1 (100%) from this one
        # shared check alone. It still applies to expo-router, where it
        # belongs (see test_real_router_no_direct_react_navigation_import_gating).
        skill_map = load_skill_map(REAL_CHECKS_DIR)

        self.assertNotIn("router_no_direct_react_navigation_import", skill_map["expo-native-ui"])
        self.assertIn("router_no_direct_react_navigation_import", skill_map["expo-router"])

    def test_real_native_ui_checks_not_applicable_without_engagement(self):
        # Third review round (P1) established engagement gating; fourth
        # review round removed the shared router check and the shared
        # skill-wide positive check from expo-native-ui's mapping (see
        # test_real_native_ui_no_longer_shares_router_react_navigation_check
        # and test_real_native_ui_checks_are_feature_specific below). An app
        # that touches none of the skill's three checkable features now
        # reads not_applicable across the board -- nothing scores, so
        # uptake_rate is None rather than a vacuous 100%.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            checks_by_skill, _ = resolve_checks_by_skill(["expo-native-ui"], REAL_CHECKS_DIR)
            checks, _ = resolve_checks_for_skills(["expo-native-ui"], REAL_CHECKS_DIR)
            results_by_id = {r.id: r for r in run_checks(checks, app)}

        self.assertEqual(results_by_id["native_ui_no_expo_av"].status, "not_applicable")
        self.assertEqual(results_by_id["native_ui_no_dimensions_get"].status, "not_applicable")
        self.assertEqual(results_by_id["native_ui_no_safe_area_view_from_react_native"].status, "not_applicable")

        skills = compute_skill_results(
            expected_skills=["expo-native-ui"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )
        self.assertEqual(skills["expo-native-ui"]["uptake_status"], "not_applicable")
        self.assertEqual(skills["expo-native-ui"]["total"], 0)
        self.assertIsNone(skills["expo-native-ui"]["uptake_rate"])

    def test_real_native_ui_checks_are_feature_specific(self):
        # Fourth review round (P1): an earlier version gated all three
        # anti-pattern checks on ANY of the four modern-API signals appearing
        # anywhere -- so a safe-area import alone activated the media and
        # dimensions checks too, even though it's not evidence the app made
        # a correct media or dimensions choice. Each check must now gate
        # only on its own feature's replacement.
        def run(index_body):
            with tempfile.TemporaryDirectory() as td:
                app = Path(td)
                (app / "app").mkdir()
                (app / "app" / "index.tsx").write_text(index_body)
                checks, _ = resolve_checks_for_skills(["expo-native-ui"], REAL_CHECKS_DIR)
                return {r.id: r for r in run_checks(checks, app)}

        # Only react-native-safe-area-context: safe-area passes, the other
        # two are not_applicable.
        results = run(
            "import { SafeAreaView } from 'react-native-safe-area-context';\n"
            "export default function App(){ return <SafeAreaView />; }\n"
        )
        self.assertEqual(results["native_ui_no_safe_area_view_from_react_native"].status, "passed")
        self.assertEqual(results["native_ui_no_expo_av"].status, "not_applicable")
        self.assertEqual(results["native_ui_no_dimensions_get"].status, "not_applicable")

        # Only useWindowDimensions(): dimensions passes, the other two are
        # not_applicable.
        results = run(
            "import { useWindowDimensions } from 'react-native';\n"
            "export default function App(){ const { width } = useWindowDimensions(); return null; }\n"
        )
        self.assertEqual(results["native_ui_no_dimensions_get"].status, "passed")
        self.assertEqual(results["native_ui_no_expo_av"].status, "not_applicable")
        self.assertEqual(results["native_ui_no_safe_area_view_from_react_native"].status, "not_applicable")

        # Only expo-video: media passes, the other two are not_applicable.
        results = run(
            "import { VideoView } from 'expo-video';\n"
            "export default function App(){ return <VideoView />; }\n"
        )
        self.assertEqual(results["native_ui_no_expo_av"].status, "passed")
        self.assertEqual(results["native_ui_no_dimensions_get"].status, "not_applicable")
        self.assertEqual(results["native_ui_no_safe_area_view_from_react_native"].status, "not_applicable")

    def test_real_native_ui_anti_patterns_fail_without_needing_another_signal(self):
        # Required regression: a failing anti-pattern check never needs a
        # positive precondition -- finding the prohibited API is itself
        # evidence that feature area was engaged. Each is tested alone (no
        # other native-ui signal present).
        def run(index_body):
            with tempfile.TemporaryDirectory() as td:
                app = Path(td)
                (app / "app").mkdir()
                (app / "app" / "index.tsx").write_text(index_body)
                checks, _ = resolve_checks_for_skills(["expo-native-ui"], REAL_CHECKS_DIR)
                return {r.id: r for r in run_checks(checks, app)}

        results = run("import { Video } from 'expo-av';\nexport default function App(){ return null; }\n")
        self.assertEqual(results["native_ui_no_expo_av"].status, "failed")

        results = run(
            "import { Dimensions } from 'react-native';\n"
            "const { width } = Dimensions.get('window');\n"
            "export default function App(){ return null; }\n"
        )
        self.assertEqual(results["native_ui_no_dimensions_get"].status, "failed")

        results = run(
            "import { SafeAreaView } from 'react-native';\n"
            "export default function App(){ return <SafeAreaView />; }\n"
        )
        self.assertEqual(results["native_ui_no_safe_area_view_from_react_native"].status, "failed")

    def test_real_router_no_direct_react_navigation_import_gating(self):
        # router_no_direct_react_navigation_import belongs only to
        # expo-router now (see
        # test_real_native_ui_no_longer_shares_router_react_navigation_check).
        # A real @react-navigation import is always scored (finding it is
        # itself proof of engagement), a clean expo-router app gets credit
        # for avoiding it, and an app with no routing engagement at all reads
        # not_applicable rather than a vacuous pass.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import { NavigationContainer } from '@react-navigation/native';\n"
                "export default function App(){ return <NavigationContainer />; }\n"
            )
            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}
        self.assertEqual(results["router_no_direct_react_navigation_import"].status, "failed")

        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import { Stack } from 'expo-router';\nexport default function Layout(){ return <Stack />; }\n"
            )
            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}
        self.assertEqual(results["router_no_direct_react_navigation_import"].status, "passed")

        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")
            checks, _ = resolve_checks_for_skills(["expo-router"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}
        self.assertEqual(results["router_no_direct_react_navigation_import"].status, "not_applicable")

    def test_real_expo_ui_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import { Host } from '@expo/ui/swift-ui';\n"
                "export default function App(){ return <Host />; }\n"
            )
            (app / "components" / "widget.ios.tsx").parent.mkdir(parents=True)
            (app / "components" / "widget.ios.tsx").write_text("export default function Widget(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-ui"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["expo_ui_import_used"].passed)
        self.assertFalse(results["expo_ui_no_host_from_subpackage"].passed)
        self.assertTrue(results["expo_ui_platform_specific_trees_not_in_app_dir"].passed)

    def test_real_expo_ui_import_used_fails_when_dependency_declared_but_unused(self):
        # Code-review regression guard: an earlier version of this check
        # only checked package.json, so declaring @expo/ui as a dependency
        # and never importing it anywhere still passed all 3 expo-ui checks
        # (the other two are absence checks, which pass vacuously with no
        # usage at all). Confirmed live against both real hot_chocolate and
        # wiki_reader apps, which declare the dependency but never import it.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-ui"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["expo_ui_import_used"].passed)

    def test_real_expo_ui_anti_pattern_checks_not_applicable_without_engagement(self):
        # Third review round (P1): a declared-but-unused @expo/ui dependency
        # used to make expo_ui_no_host_from_subpackage and
        # expo_ui_platform_specific_trees_not_in_app_dir vacuously pass,
        # reporting 2/3 (66.67%) uptake for a skill the app never touched.
        # Both are now not_applicable without an actual @expo/ui import, so
        # only expo_ui_import_used (failed) scores -- 0/1.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            checks_by_skill, _ = resolve_checks_by_skill(["expo-ui"], REAL_CHECKS_DIR)
            checks, _ = resolve_checks_for_skills(["expo-ui"], REAL_CHECKS_DIR)
            results_by_id = {r.id: r for r in run_checks(checks, app)}

        self.assertEqual(results_by_id["expo_ui_no_host_from_subpackage"].status, "not_applicable")
        self.assertEqual(results_by_id["expo_ui_platform_specific_trees_not_in_app_dir"].status, "not_applicable")

        skills = compute_skill_results(
            expected_skills=["expo-ui"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )
        self.assertEqual(skills["expo-ui"]["total"], 1)
        self.assertEqual(skills["expo-ui"]["passed"], 0)

    def test_real_expo_ui_anti_pattern_checks_still_score_when_genuinely_engaged(self):
        # Required regression: a genuinely engaged implementation must still
        # get credit for correctly avoiding the anti-patterns, not just for
        # importing @expo/ui at all.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"dependencies": {"@expo/ui": "1.0.0"}}))
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import { Host } from '@expo/ui';\n"
                "export default function App(){ return <Host />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-ui"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["expo_ui_import_used"].passed)
        self.assertEqual(results["expo_ui_no_host_from_subpackage"].status, "passed")
        self.assertEqual(results["expo_ui_platform_specific_trees_not_in_app_dir"].status, "passed")

    def test_real_expo_ui_flags_platform_tree_under_app_dir(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "widget.ios.tsx").write_text("export default function Widget(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-ui"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["expo_ui_platform_specific_trees_not_in_app_dir"].passed)

    def test_real_data_fetching_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "import axios from 'axios';\n"
                "const url = process.env.EXPO_PUBLIC_API_URL;\n"
                "export default function App(){ return null; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["data_fetching_no_axios"].passed)
        self.assertFalse(results["data_fetching_uses_fetch_or_query_lib"].passed)
        self.assertTrue(results["data_fetching_expo_public_env_prefix"].passed)

    def test_real_data_fetching_no_axios_not_applicable_without_engagement(self):
        # Third review round (P1): an app with no fetch/query-lib usage and
        # no axios import used to get a vacuous pass from data_fetching_no_axios
        # merely for never touching data fetching at all, reporting 1/2 (50%)
        # uptake. Now not_applicable without observable data-fetching behavior
        # -- only data_fetching_uses_fetch_or_query_lib (failed) scores.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            checks_by_skill, _ = resolve_checks_by_skill(["expo-data-fetching"], REAL_CHECKS_DIR)
            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results_by_id = {r.id: r for r in run_checks(checks, app)}

        self.assertEqual(results_by_id["data_fetching_no_axios"].status, "not_applicable")

        skills = compute_skill_results(
            expected_skills=["expo-data-fetching"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )
        self.assertEqual(skills["expo-data-fetching"]["total"], 1)
        self.assertEqual(skills["expo-data-fetching"]["passed"], 0)

    def test_real_data_fetching_no_axios_scores_when_genuinely_engaged(self):
        # Required regression: a genuinely engaged implementation (real
        # fetch usage) that correctly avoids axios must still get credit
        # for it, not just get gated to not_applicable.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "async function load(){ return fetch('https://example.com'); }\n"
                "export default function App(){ return null; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertEqual(results["data_fetching_no_axios"].status, "passed")
        self.assertTrue(results["data_fetching_uses_fetch_or_query_lib"].passed)

    def test_real_data_fetching_env_prefix_not_applicable_when_no_env_vars_read(self):
        # Code-review fix: a bare "does EXPO_PUBLIC_ appear anywhere" regex
        # unconditionally failed apps that read no client env var at all --
        # confirmed live: both real hot_chocolate (self-contained, no
        # external API) and wiki_reader (WebView wrapper) read zero env
        # vars, so the old check always failed them regardless of true
        # skill uptake. Precondition doesn't hold -> not_applicable.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["data_fetching_expo_public_env_prefix"]
        self.assertEqual(result.status, "not_applicable")
        self.assertIsNone(result.passed)

    def test_real_data_fetching_env_prefix_flags_non_prefixed_client_env_var(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "const url = process.env.API_URL;\nexport default function App(){ return null; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["data_fetching_expo_public_env_prefix"]
        self.assertEqual(result.status, "failed")
        self.assertFalse(result.passed)

    def test_real_data_fetching_env_prefix_exempts_expo_os(self):
        # Regression guard found live re-validating against wiki_reader:
        # process.env.EXPO_OS is a framework-provided platform-detection
        # var (the same one expo-native-ui's own rule recommends over
        # Platform.OS) -- it will never be EXPO_PUBLIC_-prefixed and isn't
        # user client config, so it must not count as a violation.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "if (process.env.EXPO_OS === 'ios') {}\nexport default function App(){ return null; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["data_fetching_expo_public_env_prefix"]
        self.assertEqual(result.status, "not_applicable")

    def test_real_data_fetching_env_prefix_ignores_server_side_api_route_secret(self):
        # Follow-up review regression guard: the skill explicitly endorses
        # unprefixed server-only secrets inside +api.ts route handlers --
        # this is the opposite of a violation, not an oversight to flag.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app" / "api").mkdir(parents=True)
            (app / "app" / "api" / "secret+api.ts").write_text(
                "export async function POST() {\n"
                "  const secret = process.env.OPENAI_API_KEY;\n"
                "  return Response.json({ configured: Boolean(secret) });\n"
                "}\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["data_fetching_expo_public_env_prefix"]
        self.assertEqual(result.status, "not_applicable")

    def test_real_data_fetching_env_prefix_ignores_commented_env_read(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "// const secret = process.env.SECRET;\n"
                "export default function App(){ return null; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["data_fetching_expo_public_env_prefix"]
        self.assertEqual(result.status, "not_applicable")

    def test_real_data_fetching_uses_fetch_check_passes_on_plain_fetch(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text(
                "export default async function App(){ const r = await fetch('https://example.com'); return null; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-data-fetching"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["data_fetching_no_axios"].passed)
        self.assertTrue(results["data_fetching_uses_fetch_or_query_lib"].passed)

    def test_real_dom_use_dom_directive_check(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\nexport default function Map(){ return <div />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["dom_use_dom_directive_present"].passed)

    def test_real_dom_use_dom_directive_check_ignores_text_outside_directive_prologue(self):
        # Code-review regression guard: the bare regex `['"]use dom['"]`
        # matches "use dom" anywhere, including inside an ordinary string
        # assignment -- not just a real leading directive.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "const label = \"use dom\";\n"
                "export default function NotActuallyDom(){ return <div>{label}</div>; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_use_dom_directive_present"]
        if result.status == "unavailable":
            self.skipTest("node/npm unavailable in this environment")
        self.assertEqual(result.status, "failed")

    def test_real_dom_use_dom_directive_check_ignores_standalone_statement_after_other_code(self):
        # Follow-up review regression guard, distinct from the assignment
        # case above: a bare "use dom"; expression statement is also not a
        # real directive once it's not the file's first statement -- Babel's
        # own directive-prologue rule, not just a string-shape difference.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "const initialized = true;\n"
                "\"use dom\";\n\n"
                "export default function NotActuallyDom() { return <div />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_use_dom_directive_present"]
        if result.status == "unavailable":
            self.skipTest("node/npm unavailable in this environment")
        self.assertEqual(result.status, "failed")

    def test_real_dom_use_dom_directive_check_ignores_directive_looking_comment(self):
        # A comment is stripped before the regex prefilter even runs, so it
        # never becomes a candidate at all.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "/* \"use dom\"; */\n"
                "export default function NotActuallyDom() { return <div />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertEqual(results["dom_use_dom_directive_present"].status, "failed")

    def test_real_dom_layout_excludes_use_dom_check(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "'use dom';\nexport default function Layout(){ return <div />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_layout_excludes_use_dom"]
        if result.status == "unavailable":
            self.skipTest("node/npm unavailable in this environment")
        self.assertFalse(result.passed)
        self.assertEqual(result.status, "failed")

    def test_real_dom_layout_excludes_use_dom_check_ignores_unrelated_string_in_layout(self):
        # Follow-up review regression guard: the layout-exclusion check had
        # the inverse problem from the directive check -- it used to fail on
        # any 'use dom'-shaped text in a _layout file, not just a real,
        # AST-confirmed directive. A real DOM component exists elsewhere so
        # the third review round's engagement precondition (not_applicable
        # unless a real DOM component is confirmed somewhere) doesn't mask
        # this test's actual intent -- the unrelated string in the _layout
        # file itself must not count as a violation.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "const label = \"use dom\";\n"
                "import { Stack } from 'expo-router';\n"
                "export default function Layout(){ return <Stack />; }\n"
            )
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\nexport default function Map(){ return <div />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_layout_excludes_use_dom"]
        if result.status == "unavailable":
            self.skipTest("node/npm unavailable in this environment")
        self.assertTrue(result.passed)
        self.assertEqual(result.status, "passed")

    def test_real_dom_layout_excludes_use_dom_check_passes_for_ordinary_layout(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "import { Stack } from 'expo-router';\nexport default function Layout(){ return <Stack />; }\n"
            )
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\nexport default function Map(){ return <div />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["dom_layout_excludes_use_dom"].passed)

    def test_real_dom_layout_excludes_use_dom_check_not_applicable_without_real_dom_component(self):
        # Third review round (P1): an app with an ordinary _layout file and
        # no real DOM component anywhere used to get a vacuous pass from
        # dom_layout_excludes_use_dom, reporting 1/2 (50%) uptake despite
        # never using expo-dom. Now not_applicable in this case, matching
        # dom_single_default_export_and_no_native_jsx's own precondition --
        # only dom_use_dom_directive_present (failed) scores.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "_layout.tsx").write_text(
                "import { Stack } from 'expo-router';\nexport default function Layout(){ return <Stack />; }\n"
            )

            checks_by_skill, _ = resolve_checks_by_skill(["expo-dom"], REAL_CHECKS_DIR)
            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results_by_id = {r.id: r for r in run_checks(checks, app)}

        result = results_by_id["dom_layout_excludes_use_dom"]
        if result.status == "unavailable":
            self.skipTest("node/npm unavailable in this environment")
        self.assertEqual(result.status, "not_applicable")

        skills = compute_skill_results(
            expected_skills=["expo-dom"],
            triggered_skills=[],
            checks_by_skill=checks_by_skill,
            results_by_id=results_by_id,
            app_dir_missing=False,
        )
        self.assertEqual(skills["expo-dom"]["total"], 1)
        self.assertEqual(skills["expo-dom"]["passed"], 0)

    def test_real_dom_layout_excludes_use_dom_check_not_applicable_with_no_layout_files(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\nexport default function Map(){ return <div />; }\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_layout_excludes_use_dom"]
        self.assertEqual(result.status, "not_applicable")
        self.assertIsNone(result.passed)

    def test_real_dom_single_default_export_check_passes_on_clean_dom_component(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\n"
                "import { useState } from 'react';\n"
                "export default function Map() {\n"
                "  const [count, setCount] = useState(0);\n"
                "  return <div onClick={() => setCount(count + 1)}>{count}</div>;\n"
                "}\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["dom_single_default_export_and_no_native_jsx"].passed)

    def test_real_dom_single_default_export_check_flags_react_native_jsx_inside_dom_file(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\n"
                "import { View, Text } from 'react-native';\n"
                "export default function Map() {\n"
                "  return <View><Text>hi</Text></View>;\n"
                "}\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_single_default_export_and_no_native_jsx"]
        if result.status == "unavailable":
            self.skipTest("node/npm unavailable in this environment")
        self.assertFalse(result.passed)

    def test_real_dom_single_default_export_check_flags_namespace_react_native_jsx(self):
        # Code-review regression guard: `import * as RN from 'react-native'`
        # + <RN.Text> is a JSXMemberExpression, not a bare JSXIdentifier --
        # an AST walk that only handled named imports would let this evade
        # the native-JSX check entirely.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\n"
                "import * as RN from 'react-native';\n"
                "export default function Map() {\n"
                "  return <RN.View><RN.Text>hi</RN.Text></RN.View>;\n"
                "}\n"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_single_default_export_and_no_native_jsx"]
        if result.status == "unavailable":
            self.skipTest("node/npm unavailable in this environment")
        self.assertFalse(result.passed)
        self.assertIn("RN.Text", result.evidence)

    def test_real_dom_single_default_export_check_unavailable_on_malformed_source(self):
        # Malformed source that fails to parse must read unavailable, not a
        # silent pass -- a parser failure is not evidence of compliance.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\nexport default function Map() { return <div"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_single_default_export_and_no_native_jsx"]
        self.assertEqual(result.status, "unavailable")
        self.assertIsNone(result.passed)

    def test_real_dom_single_default_export_check_unavailable_when_one_of_two_candidates_is_malformed(self):
        # Follow-up review regression guard, the exact scenario reproduced
        # against the prior head: one clean, valid 'use dom' file plus one
        # malformed 'use dom' candidate used to silently return passed --
        # the first confirmed-and-clean file's success hid the second
        # file's parser failure entirely.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "components").mkdir()
            (app / "components" / "map.tsx").write_text(
                "'use dom';\nexport default function Map(){ return <div />; }\n"
            )
            (app / "components" / "broken.tsx").write_text(
                "'use dom';\nexport default function Broken() { return <div"
            )

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_single_default_export_and_no_native_jsx"]
        self.assertEqual(result.status, "unavailable")
        self.assertIsNone(result.passed)

    def test_dom_single_default_export_check_unavailable_when_parser_cannot_run(self):
        # Direct unit test of the unavailable path without depending on the
        # environment's real node/npm install: monkeypatch extract_ast_facts
        # to simulate "parser genuinely couldn't run" (returns None).
        from eval_harness.evaluator.skill_invocation.uptake_checks import code_checks

        original = code_checks.extract_ast_facts
        code_checks.extract_ast_facts = lambda path: None
        try:
            with tempfile.TemporaryDirectory() as td:
                app = Path(td)
                (app / "components").mkdir()
                (app / "components" / "map.tsx").write_text(
                    "'use dom';\nexport default function Map(){ return <div />; }\n"
                )

                checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
                results = {r.id: r for r in run_checks(checks, app)}
        finally:
            code_checks.extract_ast_facts = original

        result = results["dom_single_default_export_and_no_native_jsx"]
        self.assertEqual(result.status, "unavailable")
        self.assertIsNone(result.passed)

    def test_real_dom_single_default_export_check_not_applicable_when_no_dom_files_exist(self):
        # Precondition doesn't hold (no 'use dom' files at all) -- this must
        # read not_applicable, not a vacuous pass, so it can't inflate an
        # expo-dom uptake score for an app that never touches expo-dom.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["expo-dom"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        result = results["dom_single_default_export_and_no_native_jsx"]
        self.assertEqual(result.status, "not_applicable")
        self.assertIsNone(result.passed)

    def test_real_tailwind_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "package.json").write_text(json.dumps({"dependencies": {"nativewind": "5.0.0", "tailwindcss": "4.0.0"}}))
            (app / "metro.config.js").write_text(
                "const { withNativewind } = require('nativewind/metro');\n"
                "module.exports = withNativewind(config, {});\n"
            )
            (app / "postcss.config.mjs").write_text(
                "export default { plugins: { '@tailwindcss/postcss': {} } };\n"
            )
            (app / "src").mkdir()
            (app / "src" / "global.css").write_text("@import 'tailwindcss';\n")

            checks, _ = resolve_checks_for_skills(["expo-tailwind-setup"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        for check_id in [
            "tailwind_nativewind_package_dependency",
            "tailwind_css_package_dependency",
            "tailwind_metro_config_uses_withnativewind",
            "tailwind_postcss_uses_official_plugin",
            "tailwind_global_css_exists",
        ]:
            self.assertTrue(results[check_id].passed, check_id)

    def test_real_hosting_checks(self):
        # hosting_api_route_exists was dropped entirely: EAS Hosting also
        # serves static sites with no API routes at all, so requiring one
        # unconditionally isn't a valid applicability signal from the file
        # tree alone.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app" / "api").mkdir(parents=True)
            (app / "app" / "api" / "users+api.ts").write_text(
                "export function GET(request) { return Response.json({ ok: true }); }\n"
            )

            checks, _ = resolve_checks_for_skills(["eas-hosting"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertNotIn("hosting_api_route_exists", results)
        self.assertTrue(results["hosting_api_routes_use_typescript"].passed)
        self.assertEqual(results["hosting_api_routes_use_typescript"].status, "passed")
        self.assertTrue(results["hosting_no_banned_node_imports_in_api_routes"].passed)
        self.assertEqual(results["hosting_no_banned_node_imports_in_api_routes"].status, "passed")

    def test_real_hosting_checks_not_applicable_when_no_api_routes_exist(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "index.tsx").write_text("export default function App(){ return null; }\n")

            checks, _ = resolve_checks_for_skills(["eas-hosting"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertEqual(results["hosting_api_routes_use_typescript"].status, "not_applicable")
        self.assertIsNone(results["hosting_api_routes_use_typescript"].passed)
        self.assertEqual(results["hosting_no_banned_node_imports_in_api_routes"].status, "not_applicable")
        self.assertIsNone(results["hosting_no_banned_node_imports_in_api_routes"].passed)

    def test_real_hosting_typescript_check_flags_jsx_too(self):
        # Follow-up review regression guard: the filename regex recognizes
        # .js/.jsx/.ts/.tsx, but the old check only rejected an exact .js
        # suffix -- a +api.jsx route wrongly passed the TypeScript rule.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app" / "api").mkdir(parents=True)
            (app / "app" / "api" / "users+api.jsx").write_text(
                "export function GET(request) { return Response.json({ ok: true }); }\n"
            )

            checks, _ = resolve_checks_for_skills(["eas-hosting"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["hosting_api_routes_use_typescript"].passed)
        self.assertEqual(results["hosting_api_routes_use_typescript"].status, "failed")

    def test_real_hosting_flags_banned_node_import_in_api_route(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app" / "api").mkdir(parents=True)
            (app / "app" / "api" / "users+api.ts").write_text(
                "import fs from 'fs';\nexport function GET(request) { return Response.json({}); }\n"
            )

            checks, _ = resolve_checks_for_skills(["eas-hosting"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertFalse(results["hosting_no_banned_node_imports_in_api_routes"].passed)

    def test_real_hosting_no_banned_node_import_check_ignores_non_api_files(self):
        # Regression guard for the code-driven filter: a banned import in a
        # normal (non +api.ts) file must not trip this check -- that's what
        # makes it different from a blanket text_absent check. Since there
        # are no +api routes at all here, the correct result is
        # not_applicable, not a vacuous pass.
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "app").mkdir()
            (app / "app" / "utils.ts").write_text("import fs from 'fs';\nexport const x = 1;\n")

            checks, _ = resolve_checks_for_skills(["eas-hosting"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertEqual(results["hosting_no_banned_node_imports_in_api_routes"].status, "not_applicable")
        self.assertIsNone(results["hosting_no_banned_node_imports_in_api_routes"].passed)

    def test_real_app_clip_checks(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            (app / "targets" / "clip").mkdir(parents=True)
            (app / "public" / ".well-known").mkdir(parents=True)
            (app / "public" / ".well-known" / "apple-app-site-association").write_text("{}")

            checks, _ = resolve_checks_for_skills(["expo-app-clip"], REAL_CHECKS_DIR)
            results = {r.id: r for r in run_checks(checks, app)}

        self.assertTrue(results["app_clip_target_dir_exists"].passed)
        self.assertTrue(results["app_clip_aasa_file_exists"].passed)

    def _write_ground_truth(self, root: Path, *skills: str) -> tuple[Path, Path]:
        """Write a minimal dataset/prd_skills.json (app "test-app" -> skills)
        plus an uptake_checks-shaped dir (checks_data.json + skill_map.json)
        covering each skill with one 'import @expo/ui' check, mirroring the
        real dataset/prd_skills.json + uptake_checks pairing."""
        prd_skills_path = root / "prd_skills.json"
        prd_skills_path.write_text(json.dumps({"test-app": list(skills)}))

        checks_dir = _write_checks_dir(
            root,
            checks=[{"id": "uses_expo_ui", "category": "lexical", "kind": "import", "target": "@expo/ui"}],
            skill_map={skill: ["uses_expo_ui"] for skill in skills},
        )
        return prd_skills_path, checks_dir


if __name__ == "__main__":
    unittest.main()
