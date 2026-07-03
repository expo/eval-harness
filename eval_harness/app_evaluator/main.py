"""
CLI entry point for the agentic evaluator.

Usage:
    # Single test plan (generic primitive plan + app PRD injected at runtime)
    python -m eval_harness.app_evaluator.main \
        eval_harness/app_evaluator/test_plans/primitives/test_insert.txt \
        --prd eval_harness/app_evaluator/prds/notes/prd/mvp.txt \
        -d agent-device --hybrid-restart \
        --seed-iterations 200 --max-iterations 50 \
        -o /tmp/result.json --verbose

    # Entire directory of test plans
    python -m eval_harness.app_evaluator.main \
        eval_harness/app_evaluator/test_plans/primitives/ --prd eval_harness/app_evaluator/prds/notes/prd/mvp.txt -o results.json --verbose

    # Or via the installed console script:
    agentic-evaluator eval_harness/app_evaluator/test_plans/primitives/test_insert.txt --prd eval_harness/app_evaluator/prds/notes/prd/mvp.txt ...
"""

import argparse
import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")

from .maestro.evaluator import MaestroEvaluator
from .agent_device.evaluator import AgentDeviceEvaluator


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


def main():
    parser = argparse.ArgumentParser(description="Adaptive Maestro Evaluator")
    parser.add_argument("test_path", type=Path, help="Path to a test plan .txt file or directory of test plans")
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

    test_plans = _find_test_plans(args.test_path)

    if args.native_restart:
        print("Note: --native-restart is now the default for -d agent-device; flag retained as a no-op.")

    if args.prd and not args.prd.exists():
        print(f"Error: --prd path does not exist: {args.prd}")
        sys.exit(1)

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

    total_score = 0
    total_full = 0
    plan_results = []

    for plan_path in test_plans:
        for run_index in range(1, args.repeat + 1):
            print(f"\n{'#'*60}")
            if args.repeat > 1:
                print(f"# Test plan: {plan_path.name}  (run {run_index}/{args.repeat})")
            else:
                print(f"# Test plan: {plan_path.name}")
            print(f"{'#'*60}")

            result = evaluator.evaluate_test_plan(plan_path)

            if result.not_applicable:
                # not_applicable test plans don't count toward score/full_points
                # or the macro %; they're reported as a separate status so we
                # can distinguish "primitive doesn't apply to this app" from
                # "primitive failed at 0%".
                plan_results.append({
                    "test_plan": plan_path.name,
                    "run_index": run_index,
                    "status": "not_applicable",
                    "na_reason": result.na_reason,
                    "score": 0,
                    "full_points": 0,
                    "macro_pct": None,
                    "steps": [],
                })
                continue

            total_score += result.score
            total_full += result.full_points

            if result.steps:
                step_pcts = [
                    (s.earned_points / s.max_points) if s.max_points > 0 else 1.0
                    for s in result.steps
                ]
                test_macro_pct = sum(step_pcts) / len(step_pcts)
            else:
                test_macro_pct = 0.0

            plan_results.append({
                "test_plan": plan_path.name,
                "run_index": run_index,
                "score": result.score,
                "full_points": result.full_points,
                "macro_pct": round(test_macro_pct * 100, 2),
                "steps": [
                    {
                        "description": f"{'PASSED' if s.passed else 'FAILED'}: {s.name}",
                        "points": s.earned_points,
                        "max_points": s.max_points,
                        "iterations": s.iterations_used,
                        "hard_assertions": len(s.assertions),
                        "soft_assertions": len(s.soft_assertions),
                    }
                    for s in result.steps
                ],
            })

    test_macro_pcts = [p["macro_pct"] for p in plan_results if p.get("macro_pct") is not None]
    suite_macro_avg = round(sum(test_macro_pcts) / len(test_macro_pcts), 2) if test_macro_pcts else 0.0
    suite_micro_pct = round((total_score / total_full * 100) if total_full else 0.0, 2)
    n_not_applicable = sum(1 for p in plan_results if p.get("status") == "not_applicable")

    na_suffix = f", {n_not_applicable} N/A" if n_not_applicable else ""
    output = {
        "test_overview": (
            f"Adaptive evaluation: {len(plan_results)} test plan(s){na_suffix}, "
            f"macro avg {suite_macro_avg}% (micro {suite_micro_pct}%, "
            f"{total_score}/{total_full} points)"
        ),
        "score": total_score,
        "full_points": total_full,
        "macro_avg_pct": suite_macro_avg,
        "micro_pct": suite_micro_pct,
        "n_not_applicable": n_not_applicable,
        "test_plans": plan_results,
    }

    evaluator.bridge.cleanup()

    args.output.write_text(json.dumps(output, indent=2))
    print(f"\nResults written to {args.output}")
    print(f"Macro avg: {suite_macro_avg}% across {len(plan_results) - n_not_applicable} scored test plan(s){na_suffix}")
    print(f"Micro (verify-weighted): {suite_micro_pct}% ({total_score}/{total_full})")


if __name__ == "__main__":
    main()
