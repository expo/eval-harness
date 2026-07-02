"""Command-line entry point for offline Expo skill-eval analysis."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path

from .aggregate import aggregate_skill_results
from .artifacts import analyze_artifact_inputs, unpack_artifact
from .eas import extract_artifact_refs, list_workflow_runs, workflow_logs
from .manifest import load_case_spec
from .metrics import classify_skill, score_case_run
from .report import write_html_report, write_json_report
from .runner import run_case_matrix
from .static_checks import run_static_checks
from .trace import detect_triggered_skills, load_trace


def main() -> None:
    parser = argparse.ArgumentParser(description="Expo skill-eval analysis helpers")
    sub = parser.add_subparsers(dest="cmd", required=True)

    analyze = sub.add_parser("analyze-run", help="Analyze one generated app run")
    analyze.add_argument("--case", required=True, type=Path)
    analyze.add_argument("--trace", required=True, type=Path)
    analyze.add_argument("--app", required=True, type=Path)
    analyze.add_argument("--result", type=Path)
    analyze.add_argument("--build-success", action="store_true")
    analyze.add_argument("--visual-quality", type=float)
    analyze.add_argument("--out", required=True, type=Path)
    analyze.add_argument("--html", type=Path)
    analyze.add_argument("--scenario", default="unknown")

    eas = sub.add_parser("eas-artifacts", help="Extract artifact refs from EAS workflow logs")
    eas.add_argument("--run-id")
    eas.add_argument("--workflow")
    eas.add_argument("--limit", type=int, default=10)
    eas.add_argument("--out", type=Path)

    matrix = sub.add_parser("run-matrix", help="Plan or launch all scenarios for case specs")
    matrix.add_argument("--case", action="append", required=True, type=Path)
    matrix.add_argument("--repo-root", type=Path, default=Path.cwd())
    matrix.add_argument("--agent", default="claude", choices=["claude", "codex"])
    matrix.add_argument("--execute", action="store_true")
    matrix.add_argument("--out", type=Path)

    artifacts = sub.add_parser("analyze-artifacts", help="Analyze authored/eval EAS artifacts")
    artifacts.add_argument("--case", required=True, type=Path)
    artifacts.add_argument("--authored-artifact", required=True, type=Path)
    artifacts.add_argument("--eval-artifact", type=Path)
    artifacts.add_argument("--scenario", required=True)
    artifacts.add_argument("--out-dir", required=True, type=Path)

    args = parser.parse_args()
    if args.cmd == "analyze-run":
        _analyze_run(args)
    elif args.cmd == "eas-artifacts":
        _eas_artifacts(args)
    elif args.cmd == "run-matrix":
        _run_matrix(args)
    elif args.cmd == "analyze-artifacts":
        _analyze_artifacts(args)


def _analyze_run(args) -> None:
    case = load_case_spec(args.case)
    trace = load_trace(args.trace)
    triggered = detect_triggered_skills(trace)
    static = run_static_checks(args.app, case.static_uptake_checks)
    evaluator_pct = _read_evaluator_pct(args.result) if args.result else None
    score = score_case_run(
        expected_skills=case.expected_skills,
        triggered_skills=triggered,
        static_passed=static.passed,
        static_total=static.total,
        evaluator_pct=evaluator_pct,
        build_success=args.build_success,
        visual_quality=args.visual_quality,
    )
    uptake = score.context_uptake.uptake_rate
    classification = classify_skill(
        score.trigger_quality.recall,
        score.trigger_quality.precision,
        uptake,
        outcome_delta=0.0 if evaluator_pct is None else evaluator_pct,
        build_success_rate=1.0 if args.build_success else 0.0,
    )
    payload = {
        "summary": f"Skill eval analysis for {case.id}",
        "case": asdict(case),
        "score": asdict(score),
        "static_checks": [asdict(c) for c in static.checks],
        "runs": [{
            "case_id": case.id,
            "scenario": args.scenario,
            "skill_id": ",".join(case.expected_skills),
            "classification": classification,
            "trigger_recall": score.trigger_quality.recall,
            "trigger_precision": score.trigger_quality.precision,
            "uptake_rate": uptake,
            "evaluator_pct": evaluator_pct,
        }],
        "skills": {},
        "screenshots": [],
    }
    payload["skills"] = aggregate_skill_results(payload["runs"])
    write_json_report(payload, args.out)
    if args.html:
        write_html_report(payload, args.html)


def _eas_artifacts(args) -> None:
    run_ids = [args.run_id] if args.run_id else [r.id for r in list_workflow_runs(args.workflow, args.limit)]
    payload = {"runs": []}
    for run_id in run_ids:
        logs = workflow_logs(run_id)
        payload["runs"].append({"run_id": run_id, "artifact_refs": extract_artifact_refs(logs)})
    text = json.dumps(payload, indent=2)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text)


def _run_matrix(args) -> None:
    payload = {"cases": []}
    for case_path in args.case:
        case = load_case_spec(case_path)
        payload["cases"].append(run_case_matrix(case, args.repo_root, args.agent, args.execute))
    text = json.dumps(payload, indent=2)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text)


def _analyze_artifacts(args) -> None:
    unpack_root = args.out_dir / "unpacked"
    authored = unpack_artifact(args.authored_artifact, unpack_root / "authored")
    eval_artifact = None
    if args.eval_artifact and str(args.eval_artifact) not in {"undefined", "null", ""}:
        eval_artifact = unpack_artifact(args.eval_artifact, unpack_root / "eval")
    analyze_artifact_inputs(args.case, authored, eval_artifact, args.scenario, args.out_dir)


def _read_evaluator_pct(path: Path) -> float | None:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("macro_avg_pct") is not None:
        return float(data["macro_avg_pct"])
    if data.get("micro_pct") is not None:
        return float(data["micro_pct"])
    return None


if __name__ == "__main__":
    main()
