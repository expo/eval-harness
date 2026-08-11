#!/usr/bin/env python3
"""Create a small, truthful evaluator artifact after a workflow preflight failure."""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import stat
import tempfile
from pathlib import Path
from typing import Any


STAGE_STATUSES = {"passed", "warning", "failed", "not_run"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=("ios", "skill"), required=True)
    parser.add_argument("--author-artifact-root", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--scenario", default="")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--evaluator-model", default="")
    parser.add_argument("--evaluator-reasoning-effort", default="")
    parser.add_argument(
        "--classification",
        choices=("failed", "unsupported_environment"),
        default="failed",
    )
    parser.add_argument("--required-ios-version", default="")
    parser.add_argument("--selected-ios-version", default="")
    parser.add_argument("--available-ios-versions-json", default="[]")
    parser.add_argument(
        "--preserve-existing",
        action="store_true",
        help="fill missing iOS result/report files without replacing producer diagnostics",
    )
    return parser.parse_args()


def read_author_manifest(root: Path) -> dict[str, Any]:
    manifest = root / "manifest.json"
    try:
        metadata = manifest.lstat()
    except FileNotFoundError:
        return {}
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("author manifest must be a physical single-link regular file")
    physical_root = root.resolve(strict=True)
    physical_manifest = manifest.resolve(strict=True)
    if physical_root not in physical_manifest.parents:
        raise ValueError("author manifest resolves outside its artifact")
    value = json.loads(manifest.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def valid_stage(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or value.get("status") not in STAGE_STATUSES:
        return None
    detail = value.get("detail")
    log = value.get("log")
    if detail is not None and not isinstance(detail, str):
        return None
    if log is not None and not isinstance(log, str):
        return None
    return {"status": value["status"], "detail": detail, "log": log}


def stage(status: str, detail: str | None = None) -> dict[str, Any]:
    return {"status": status, "detail": detail, "log": None}


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def report_html(
    title: str,
    detail: str,
    note: str = "This diagnostic contains no evaluator score.",
) -> str:
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        f"<title>{html.escape(title)}</title></head><body><main>"
        f"<h1>{html.escape(title)}</h1><p>{html.escape(detail)}</p>"
        f"<p>{html.escape(note)}</p></main></body></html>\n"
    )


def available_ios_versions(args: argparse.Namespace) -> list[str]:
    try:
        values = json.loads(args.available_ios_versions_json)
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


def ios_failure_result(
    stage_name: str, reason: str, args: argparse.Namespace
) -> dict[str, Any]:
    if args.classification == "unsupported_environment":
        return {
            "status": "unsupported_environment",
            "expected_plan_count": 0,
            "terminal_plan_count": 0,
            "macro_avg_pct": None,
            "evaluator_errors": [],
            "test_plans": [],
            "environment": {
                "required_ios": args.required_ios_version or None,
                "available_ios": available_ios_versions(args),
            },
            "reason": reason,
        }
    return {
        "status": "failed",
        "expected_plan_count": 0,
        "terminal_plan_count": 0,
        "macro_avg_pct": None,
        "evaluator_errors": [{"stage": stage_name, "reason": reason}],
        "test_plans": [],
    }


def ensure_ios_result_and_report(
    out: Path, stage_name: str, reason: str, args: argparse.Namespace
) -> None:
    result_path = out / "result.json"
    report_path = out / "report.html"
    result: dict[str, Any]
    if not result_path.exists():
        result = ios_failure_result(stage_name, reason, args)
        write_json(result_path, result)
    else:
        try:
            candidate = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            candidate = None
        result = candidate if isinstance(candidate, dict) else {}
    if not report_path.exists():
        if result.get("status") == "completed":
            title = "iOS evaluation completed"
            detail = "The standalone evaluator report was unavailable; result.json is authoritative."
            note = "See result.json for scores and per-plan evidence."
        elif result.get("status") == "unsupported_environment":
            title = "iOS environment unsupported"
            detail = reason
            note = "No behavioral score was produced because no installed simulator runtime can host the authored app."
        else:
            title = "iOS evaluation failed"
            detail = f"{stage_name}: {reason}"
            note = "This diagnostic contains no evaluator score."
        report_path.write_text(report_html(title, detail, note), encoding="utf-8")


def create_ios(out: Path, author: dict[str, Any], args: argparse.Namespace) -> None:
    run_id = author.get("run_id") if isinstance(author.get("run_id"), str) else args.run_id
    detail = f"{args.stage}: {args.reason}"
    result = ios_failure_result(args.stage, args.reason, args)
    author_health = author.get("build_health") if isinstance(author.get("build_health"), dict) else {}
    if args.classification == "unsupported_environment":
        build_health = {
            "dependency_install": stage("not_run"),
            "native_build": stage("passed"),
            "app_launch": stage("warning", args.reason),
            "evaluation": stage("not_run"),
        }
    else:
        build_health = {
            "dependency_install": stage("not_run"),
            "native_build": stage("not_run"),
            "app_launch": stage("not_run"),
            "evaluation": stage("failed", detail),
        }
    for name in ("app_authored", "expo_export"):
        preserved = valid_stage(author_health.get(name))
        if preserved is not None:
            build_health[name] = preserved
    manifest = {
        "schema_version": 2,
        "artifact_type": "ios-eval-report",
        "run_id": run_id or "unavailable-author-run",
        "git_sha": author.get("git_sha"),
        "prd": author.get("prd"),
        "agent": author.get("agent"),
        "agent_model": author.get("agent_model"),
        "agent_reasoning_effort": author.get("agent_reasoning_effort"),
        "evaluator_model": args.evaluator_model or None,
        "evaluator_reasoning_effort": args.evaluator_reasoning_effort or None,
        "score": None,
        "full_points": None,
        "macro_avg_pct": None,
        "micro_pct": None,
        "environment": {
            "selected_ios": args.selected_ios_version or None,
            "required_ios": args.required_ios_version or None,
            "available_ios": available_ios_versions(args),
            "classification": (
                "unsupported_environment"
                if args.classification == "unsupported_environment"
                else None
            ),
        },
        "build_health": build_health,
        "artifacts": {
            "result": "result.json",
            "report": "report.html",
            "evaluator_trace": "traces/agentic-evaluator.json",
            "test_plan_traces": "traces/test-plans/",
            "proxy_anthropic": "telemetry/anthropic.jsonl",
            "otel": "telemetry/otel/",
            "logs": "logs/",
        },
    }
    write_json(out / "result.json", result)
    write_json(out / "manifest.json", manifest)
    if args.classification == "unsupported_environment":
        title = "iOS environment unsupported"
        note = "No behavioral score was produced because no installed simulator runtime can host the authored app."
    else:
        title = "iOS evaluation failed"
        note = "This diagnostic contains no evaluator score."
    (out / "report.html").write_text(
        report_html(title, detail, note), encoding="utf-8"
    )


def create_skill(out: Path, author: dict[str, Any], args: argparse.Namespace) -> None:
    run_id = author.get("run_id") if isinstance(author.get("run_id"), str) else args.run_id or None
    scenario = (
        author.get("scenario")
        if isinstance(author.get("scenario"), str) and author.get("scenario")
        else args.scenario or "skills_available_unmentioned"
    )
    detail = f"{args.stage}: {args.reason}"
    metrics = {
        "summary": "Skill evaluation did not run",
        "app": None,
        "expected_skills": [],
        "scenario": scenario,
        "outcome_status": "pending",
        "warnings": [detail],
        "score": {
            "trigger_quality": {"recall": None},
            "context_uptake": {"uptake_rate": None},
        },
        "static_checks": [],
        "check_category_breakdown": {},
        "build_health": {"syntax": None, "bundle": None},
        "runs": [],
        "skills": {},
        "artifacts": {},
        "braintrust_refs": [],
    }
    manifest = {
        "schema_version": 2,
        "artifact_type": "skill-eval-report",
        "run_id": run_id,
        "artifacts": {"metrics": "metrics.json", "report": "report.html"},
    }
    write_json(out / "metrics.json", metrics)
    write_json(out / "manifest.json", manifest)
    (out / "report.html").write_text(report_html("Skill evaluation did not run", detail), encoding="utf-8")


def main() -> int:
    args = parse_args()
    author_root = Path(args.author_artifact_root)
    author = read_author_manifest(author_root) if author_root.is_dir() else {}
    destination = Path(args.out_dir).absolute()
    if destination == Path(destination.anchor) or destination.is_symlink():
        raise ValueError("unsafe diagnostic output directory")
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    if args.preserve_existing:
        if args.kind != "ios":
            raise ValueError("--preserve-existing is only valid for iOS diagnostics")
        if not destination.is_dir():
            raise ValueError("preserved diagnostic output must already be a directory")
        ensure_ios_result_and_report(destination, args.stage, args.reason, args)
        return 0
    staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}-diagnostic-", dir=parent))
    try:
        if args.kind == "ios":
            create_ios(staging, author, args)
        else:
            create_skill(staging, author, args)
        if destination.exists():
            if destination.is_symlink() or not destination.is_dir():
                raise ValueError("unsafe diagnostic output directory")
            shutil.rmtree(destination)
        os.replace(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
