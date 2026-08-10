"""
CLI entry point for the agentic evaluator.

Usage:
    # Auto-resolve which test plans to run from the PRD's ground truth
    # (dataset/prd_test_plans.json) -- the normal path, no explicit test_path.
    python -m eval_harness.evaluator.ios_agentic.main \
        --prd dataset/prds/notes/prd/mvp.txt \
        -d agent-device --hybrid-restart \
        --seed-iterations 200 --max-iterations 50 \
        -o /tmp/result.json --verbose

    # Explicit single test plan, or a directory of test plans (overrides
    # auto-resolution; useful for local debugging one primitive at a time)
    python -m eval_harness.evaluator.ios_agentic.main \
        dataset/test_plans/primitives/test_insert.txt \
        --prd dataset/prds/notes/prd/mvp.txt -o /tmp/result.json --verbose
    python -m eval_harness.evaluator.ios_agentic.main \
        dataset/test_plans/primitives/ --prd dataset/prds/notes/prd/mvp.txt -o results.json --verbose

    # Or via the installed console script:
    agentic-evaluator --prd dataset/prds/notes/prd/mvp.txt ...
"""

import argparse
import json
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")

from .maestro.evaluator import MaestroEvaluator
from .agent_device.evaluator import AgentDeviceEvaluator
from .core.scoring import TestPlanResult
from .report import write_html_report

_PACKAGE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _PACKAGE_DIR.parents[2]
_DEFAULT_TEST_PLANS_DIR = _REPO_ROOT / "dataset" / "test_plans" / "primitives"
_DEFAULT_PRD_TEST_PLANS = _REPO_ROOT / "dataset" / "prd_test_plans.json"


def _app_name_from_prd(prd_path: str) -> str | None:
    """Extract the app name from a `dataset/prds/<app>/prd/*.txt` style path."""
    parts = Path(prd_path).parts
    if "prds" in parts:
        idx = parts.index("prds")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return None


def _find_test_plans(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    if path.is_dir():
        plans = sorted(path.glob("test*.txt"))
        if not plans:
            print(f"No test*.txt files found in {path}")
            sys.exit(1)
        return plans
    print(f"Path not found: {path}")
    sys.exit(1)


def _resolve_test_plans_from_prd(prd: Path, prd_test_plans_path: Path, test_plans_dir: Path) -> list[Path]:
    """Ground-truth lookup mirroring skill_invocation's prd_skills.json: which
    test plans are relevant to this PRD's app, instead of running every
    primitive in the directory (many of which don't apply, or actively
    contradict a given app's spec)."""
    app_name = _app_name_from_prd(str(prd))
    if not app_name:
        print(f"Error: could not derive app name from --prd {prd}")
        sys.exit(1)
    if not prd_test_plans_path.exists():
        print(f"Error: prd_test_plans map not found at {prd_test_plans_path}")
        sys.exit(1)
    mapping = json.loads(prd_test_plans_path.read_text(encoding="utf-8"))
    plan_names = mapping.get(app_name)
    if not plan_names:
        print(f"Error: no test-plan ground truth for app {app_name!r} in {prd_test_plans_path}")
        sys.exit(1)
    plans = [test_plans_dir / name for name in plan_names]
    missing = [str(p) for p in plans if not p.exists()]
    if missing:
        print(f"Error: test plan(s) listed in {prd_test_plans_path} not found: {', '.join(missing)}")
        sys.exit(1)
    return plans


def _serialize_plan_result(
    plan_path: Path,
    run_index: int,
    result: TestPlanResult,
) -> dict:
    """Convert one evaluator result into the stable public JSON shape."""
    if result.status == "not_applicable" or result.not_applicable:
        return {
            "test_plan": plan_path.name,
            "run_index": run_index,
            "status": "not_applicable",
            "na_reason": result.na_reason,
            "score": 0,
            "full_points": 0,
            "macro_pct": None,
            "steps": [],
        }

    if result.status == "evaluator_error":
        return {
            "test_plan": plan_path.name,
            "run_index": run_index,
            "status": "evaluator_error",
            "error_stage": result.error_stage or "unknown",
            "error_reason": result.error_reason or "evaluator returned no error detail",
            "score": None,
            "full_points": None,
            "macro_pct": None,
            "steps": [
                {
                    "description": f"{'PASSED' if step.passed else 'FAILED'}: {step.name}",
                    "points": step.earned_points,
                    "max_points": step.max_points,
                    "iterations": step.iterations_used,
                    "hard_assertions": len(step.assertions),
                    "soft_assertions": len(step.soft_assertions),
                }
                for step in result.steps
            ],
        }

    if result.status != "completed":
        return {
            "test_plan": plan_path.name,
            "run_index": run_index,
            "status": "evaluator_error",
            "error_stage": "outcome",
            "error_reason": f"evaluator returned non-terminal status {result.status!r}",
            "score": None,
            "full_points": None,
            "macro_pct": None,
            "steps": [],
        }

    if result.steps:
        step_pcts = [
            (step.earned_points / step.max_points) if step.max_points > 0 else 1.0
            for step in result.steps
        ]
        test_macro_pct = sum(step_pcts) / len(step_pcts)
    else:
        test_macro_pct = 0.0

    return {
        "test_plan": plan_path.name,
        "run_index": run_index,
        "status": "completed",
        "score": result.score,
        "full_points": result.full_points,
        "macro_pct": round(test_macro_pct * 100, 2),
        "steps": [
            {
                "description": f"{'PASSED' if step.passed else 'FAILED'}: {step.name}",
                "points": step.earned_points,
                "max_points": step.max_points,
                "iterations": step.iterations_used,
                "hard_assertions": len(step.assertions),
                "soft_assertions": len(step.soft_assertions),
            }
            for step in result.steps
        ],
    }


def _build_suite_output(
    plan_results: list[dict],
    expected_plan_count: int,
    suite_errors: list[dict] | None = None,
) -> dict:
    """Build aggregate output without scoring evaluator infrastructure faults."""
    suite_errors = list(suite_errors or [])
    completed = [plan for plan in plan_results if plan.get("status") == "completed"]
    not_applicable = [
        plan for plan in plan_results if plan.get("status") == "not_applicable"
    ]
    plan_errors = [
        {
            "test_plan": plan.get("test_plan"),
            "run_index": plan.get("run_index"),
            "stage": plan.get("error_stage"),
            "reason": plan.get("error_reason"),
        }
        for plan in plan_results
        if plan.get("status") == "evaluator_error"
    ]
    evaluator_errors = plan_errors + suite_errors
    terminal_statuses = {"completed", "not_applicable", "evaluator_error"}
    terminal_plan_count = sum(
        1 for plan in plan_results if plan.get("status") in terminal_statuses
    )

    total_score = sum(int(plan["score"]) for plan in completed)
    total_full = sum(int(plan["full_points"]) for plan in completed)
    test_macro_pcts = [float(plan["macro_pct"]) for plan in completed]
    suite_macro_avg = (
        round(sum(test_macro_pcts) / len(test_macro_pcts), 2)
        if test_macro_pcts
        else 0.0
    )
    suite_micro_pct = round(
        (total_score / total_full * 100) if total_full else 0.0,
        2,
    )
    all_expected_are_legitimate = (
        len(plan_results) == expected_plan_count
        and terminal_plan_count == expected_plan_count
        and not evaluator_errors
        and all(
            plan.get("status") in {"completed", "not_applicable"}
            for plan in plan_results
        )
    )
    status = "completed" if all_expected_are_legitimate else "incomplete"

    na_suffix = f", {len(not_applicable)} N/A" if not_applicable else ""
    error_suffix = f", {len(evaluator_errors)} evaluator error(s)" if evaluator_errors else ""
    return {
        "status": status,
        "expected_plan_count": expected_plan_count,
        "terminal_plan_count": terminal_plan_count,
        "test_overview": (
            f"Adaptive evaluation ({status}): {len(plan_results)}/{expected_plan_count} "
            f"test plan(s){na_suffix}{error_suffix}, macro avg {suite_macro_avg}% "
            f"(micro {suite_micro_pct}%, {total_score}/{total_full} points)"
        ),
        "score": total_score,
        "full_points": total_full,
        "macro_avg_pct": suite_macro_avg,
        "micro_pct": suite_micro_pct,
        "n_not_applicable": len(not_applicable),
        "evaluator_errors": evaluator_errors,
        "test_plans": plan_results,
    }


def _write_checkpoint(output_path: Path, output: dict) -> None:
    """Atomically publish JSON and HTML snapshots for the current suite state."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    json_tmp = output_path.with_name(f".{output_path.name}.tmp")
    with json_tmp.open("w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    json_tmp.replace(output_path)

    html_path = output_path.with_suffix(".html")
    html_tmp = html_path.with_name(f".{html_path.name}.tmp")
    write_html_report(output, html_tmp)
    html_tmp.replace(html_path)


def _run_suite(
    evaluator,
    test_plans: list[Path],
    repeat: int,
    output_path: Path,
) -> tuple[dict, int]:
    """Run every expected plan, checkpointing terminal results and errors."""
    expected_plan_count = len(test_plans) * repeat
    plan_results: list[dict] = []
    suite_errors: list[dict] = []
    output = _build_suite_output(plan_results, expected_plan_count)
    _write_checkpoint(output_path, output)

    try:
        for plan_path in test_plans:
            for run_index in range(1, repeat + 1):
                print(f"\n{'#'*60}")
                if repeat > 1:
                    print(f"# Test plan: {plan_path.name}  (run {run_index}/{repeat})")
                else:
                    print(f"# Test plan: {plan_path.name}")
                print(f"{'#'*60}")

                try:
                    result = evaluator.evaluate_test_plan(plan_path)
                    record = _serialize_plan_result(plan_path, run_index, result)
                except Exception as exc:
                    record = {
                        "test_plan": plan_path.name,
                        "run_index": run_index,
                        "status": "evaluator_error",
                        "error_stage": "unexpected_exception",
                        "error_reason": str(exc) or type(exc).__name__,
                        "score": None,
                        "full_points": None,
                        "macro_pct": None,
                        "steps": [],
                    }
                plan_results.append(record)
                output = _build_suite_output(
                    plan_results,
                    expected_plan_count,
                    suite_errors,
                )
                _write_checkpoint(output_path, output)
    finally:
        try:
            evaluator.bridge.cleanup()
        except Exception as exc:
            suite_errors.append(
                {
                    "test_plan": None,
                    "run_index": None,
                    "stage": "cleanup",
                    "reason": str(exc) or type(exc).__name__,
                }
            )
        output = _build_suite_output(plan_results, expected_plan_count, suite_errors)
        _write_checkpoint(output_path, output)

    return output, 0 if output["status"] == "completed" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Adaptive Maestro Evaluator")
    parser.add_argument(
        "test_path", type=Path, nargs="*",
        help="Path(s) to a test plan .txt file or directory of test plans. When omitted, the "
             "test plans relevant to --prd's app are resolved automatically from "
             "dataset/prd_test_plans.json.",
    )
    parser.add_argument(
        "--prd-test-plans", type=Path, default=_DEFAULT_PRD_TEST_PLANS,
        help="Path to the app -> relevant-test-plans ground-truth map, used only when no "
             "test_path is given (default: dataset/prd_test_plans.json)",
    )
    parser.add_argument(
        "--test-plans-dir", type=Path, default=_DEFAULT_TEST_PLANS_DIR,
        help="Directory the ground-truth map's test-plan filenames are resolved against "
             "(default: dataset/test_plans/primitives)",
    )
    parser.add_argument("-o", "--output", type=Path, default=Path("evaluation-finished.json"), help="Output JSON path")
    parser.add_argument("-p", "--platform", choices=["ios", "android"], default="ios")
    parser.add_argument("-d", "--driver", choices=["maestro", "agent-device"], default="maestro", help="Device automation driver")
    parser.add_argument("--max-iterations", type=int, default=50, help="Max turns per formal (scored) step")
    parser.add_argument("--seed-iterations", type=int, default=100,
                        help="Max turns for the pre-flight seed phase that runs the test plan's "
                             "<seeding_and_precondition> instructions BEFORE the formal scored steps. "
                             "Default 100 (generous, since seeding can involve filling rich create forms "
                             "in some apps). Assertions emitted during this phase are not scored.")
    parser.add_argument("--timeout", type=int, default=60, help="Command timeout in seconds")
    parser.add_argument("--repeat", type=int, default=1,
                        help="Run each test plan N times sequentially (useful for variance measurement). "
                             "Default 1. Each run gets a fresh SDK session and a clean app restart, and is "
                             "recorded as a separate entry in the output JSON with run_index 1..N.")
    parser.add_argument("--native-restart", action="store_true",
                        help="DEPRECATED no-op. Native (pure agent-device, no Maestro) restart_app is now the default "
                             "for the agent-device driver. This flag is retained for compatibility and may be removed "
                             "once a few more validation cycles show no regressions.")
    parser.add_argument("--hybrid-restart", action="store_true",
                        help="(agent-device only) Use the Maestro-hybrid restart_app path instead of the default "
                             "pure-agent-device restart. Useful while the native restart's Bottom Sheet dismissal is "
                             "still being hardened; Maestro's runFlow/waitForAnimationToEnd is more reliable today.")
    parser.add_argument("--prd", type=Path, default=None,
                        help="Path to the app PRD file. When supplied, the evaluator injects the PRD's contents "
                             "into the agent's first step prompt as an `## App PRD` section. Useful for app-agnostic "
                             "generic test plans that rely on the PRD for app-specific context (credentials, screens, "
                             "fixtures).")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.prd and not args.prd.exists():
        print(f"Error: --prd path does not exist: {args.prd}")
        sys.exit(1)

    if args.test_path:
        test_plans = []
        for path in args.test_path:
            test_plans.extend(_find_test_plans(path))
    else:
        if not args.prd:
            print("Error: --prd is required to auto-resolve test plans (or pass an explicit test_path)")
            sys.exit(1)
        test_plans = _resolve_test_plans_from_prd(args.prd, args.prd_test_plans, args.test_plans_dir)

    if args.native_restart:
        print("Note: --native-restart is now the default for -d agent-device; flag retained as a no-op.")

    evaluator_kwargs = dict(
        platform=args.platform,
        max_iterations=args.max_iterations,
        timeout=args.timeout,
        verbose=args.verbose,
    )
    if args.driver == "agent-device":
        evaluator = AgentDeviceEvaluator(
            **evaluator_kwargs,
            prd_path=args.prd,
            hybrid_restart=args.hybrid_restart,
            seed_iterations=args.seed_iterations,
        )
    else:
        if args.hybrid_restart:
            print("Note: --hybrid-restart is only applicable to -d agent-device; ignored.")
        evaluator = MaestroEvaluator(
            **evaluator_kwargs,
            prd_path=args.prd,
            seed_iterations=args.seed_iterations,
        )

    output, exit_code = _run_suite(
        evaluator=evaluator,
        test_plans=test_plans,
        repeat=args.repeat,
        output_path=args.output,
    )
    print(f"\nResults written to {args.output}")
    print(output["test_overview"])
    print(f"HTML report written to {args.output.with_suffix('.html')}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
