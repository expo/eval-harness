"""Artifact analysis, scoring, and report generation for Expo skill evals."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass
import html
from pathlib import Path
from typing import Any

from .uptake_checks.registry import UptakeResults, resolve_checks_for_skills, run_checks
from .uptake_checks.trigger import detect_triggered_skills, load_trace, score_trigger_quality, TriggerQuality
from .utils import (
    app_name_from_prd,
    dedupe,
    flatten_strings,
    load_prd_skills,
    read_json,
    write_json,
)


TRACE_CANDIDATES = (
    "claude-code-authoring.json",
    "claude-authoring.json",
    "codex-authoring.json",
    "claude-code.json",
    "claude.json",
    "codex.json",
)

# Authoring-enforced negative-control scenario: skills/MCP were genuinely
# unavailable, so expected_skills is forced to [] regardless of the case spec.
UNAVAILABLE_SCENARIOS = {"skills_unavailable"}
BASELINE_SCENARIOS = UNAVAILABLE_SCENARIOS


@dataclass
class ArtifactLayout:
    root: Path
    app_dir: Path | None
    trace_path: Path | None
    manifest_path: Path | None
    result_path: Path | None


@dataclass
class ContextUptake:
    passed: int
    total: int
    uptake_rate: float | None
    skipped_reason: str | None = None


@dataclass
class OutcomeDelta:
    evaluator_pct: float | None
    build_success: bool | None


@dataclass
class CaseRunScore:
    trigger_quality: TriggerQuality
    context_uptake: ContextUptake
    outcome_delta: OutcomeDelta


def analyze_artifacts(
    authored_artifact: Path | str,
    eval_artifact: Path | str | None,
    scenario: str,
    out_dir: Path | str,
    *,
    prd_skills_path: Path | str,
    checks_dir: Path | str,
) -> dict[str, Any]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    author_layout = discover_artifact_layout(authored_artifact)
    eval_layout = discover_artifact_layout(eval_artifact) if eval_artifact else None
    warnings: list[str] = []

    scenario = _resolve_scenario(scenario, author_layout, warnings)
    app_name, app_expected_skills = _resolve_app_expected_skills(
        author_layout, prd_skills_path, warnings
    )
    # The "unavailable" scenario is an enforced negative control (see
    # author-app.sh): skills/MCP were genuinely disabled during authoring, so
    # nothing can legitimately trigger regardless of the app's ground truth.
    expected_skills = [] if scenario in UNAVAILABLE_SCENARIOS else app_expected_skills

    checks, check_warnings = resolve_checks_for_skills(expected_skills, checks_dir)
    warnings.extend(check_warnings)

    if author_layout.app_dir is None:
        warnings.append("app tree not found")
        static_passed = 0
        static_total = len(checks)
        static_rows: list[dict[str, Any]] = []
        tier_breakdown: dict[str, dict[str, int]] = {}
    else:
        uptake_results = UptakeResults(run_checks(checks, author_layout.app_dir))
        static_passed = uptake_results.passed
        static_total = uptake_results.total
        static_rows = [asdict(check) for check in uptake_results.checks]
        tier_breakdown = uptake_results.tier_breakdown()

    if author_layout.trace_path is None:
        warnings.append("author trace not found")
        trace = {}
    else:
        trace = load_trace(author_layout.trace_path)
    triggered = detect_triggered_skills(trace)

    result_path = eval_layout.result_path if eval_layout else None
    evaluator_pct = _read_evaluator_pct(result_path) if result_path else None
    build_success = True if result_path else None
    score = score_case_run(
        expected_skills=expected_skills,
        triggered_skills=triggered,
        static_passed=static_passed,
        static_total=static_total,
        evaluator_pct=evaluator_pct,
        build_success=build_success,
    )
    uptake = score.context_uptake.uptake_rate
    outcome_status = "complete" if evaluator_pct is not None else "pending"

    run = {
        "app": app_name,
        "scenario": scenario,
        "skill_id": ",".join(expected_skills),
        "trigger_recall": score.trigger_quality.recall,
        "trigger_precision": score.trigger_quality.precision,
        "trigger_exact_match": set(score.trigger_quality.triggered_skills) == set(expected_skills),
        "detected_skills": score.trigger_quality.triggered_skills,
        "uptake_rate": uptake,
        "evaluator_pct": evaluator_pct,
        "build_success": build_success,
    }
    payload = {
        "summary": f"Skill eval artifact analysis for {app_name or 'unknown app'}",
        "app": app_name,
        "expected_skills": expected_skills,
        "scenario": scenario,
        "outcome_status": outcome_status,
        "warnings": warnings,
        "score": asdict(score),
        "static_checks": static_rows,
        "tier_breakdown": tier_breakdown,
        "runs": [run],
        "skills": aggregate_skill_results([run]),
        "artifacts": {
            "authored_root": str(author_layout.root),
            "app_dir": str(author_layout.app_dir) if author_layout.app_dir else None,
            "author_trace": str(author_layout.trace_path) if author_layout.trace_path else None,
            "author_manifest": str(author_layout.manifest_path) if author_layout.manifest_path else None,
            "eval_root": str(eval_layout.root) if eval_layout else None,
            "eval_result": str(result_path) if result_path else None,
            "eval_manifest": str(eval_layout.manifest_path) if eval_layout and eval_layout.manifest_path else None,
        },
        "braintrust_refs": _collect_braintrust_refs(author_layout, eval_layout, trace),
    }
    write_json(payload, out_dir / "metrics.json")
    write_html_report(payload, out_dir / "report.html")
    return payload


def _resolve_app_expected_skills(
    author_layout: ArtifactLayout, prd_skills_path: Path | str, warnings: list[str]
) -> tuple[str | None, list[str]]:
    """Ground truth lookup: manifest's recorded `prd` -> app name -> expected
    skill set from dataset/prd_skills.json. Never raises -- an unmapped or
    missing app just means an empty expected set plus a warning, matching the
    rest of this module's "degrade, don't crash" philosophy."""
    prd = None
    if author_layout.manifest_path and author_layout.manifest_path.exists():
        prd = (read_json(author_layout.manifest_path) or {}).get("prd")
    app_name = app_name_from_prd(prd) if prd else None
    if not app_name:
        warnings.append(f"could not derive app name from manifest prd={prd!r}")
        return app_name, []

    prd_skills_path = Path(prd_skills_path)
    if not prd_skills_path.exists():
        warnings.append(f"prd_skills map not found at {prd_skills_path}")
        return app_name, []

    app_expected_skills = load_prd_skills(prd_skills_path).get(app_name)
    if app_expected_skills is None:
        warnings.append(f"no ground-truth skill set for app {app_name!r} in {prd_skills_path}")
        return app_name, []
    return app_name, app_expected_skills


def _resolve_scenario(scenario: str, author_layout: ArtifactLayout, warnings: list[str]) -> str:
    """Prefer the scenario actually recorded at authoring time (ground truth
    in manifest.json) over the analysis-time input -- the two can drift if the
    wrong artifact is paired with the wrong `--scenario` flag."""
    if not author_layout.manifest_path or not author_layout.manifest_path.exists():
        return scenario
    recorded = (read_json(author_layout.manifest_path) or {}).get("scenario")
    if not recorded:
        return scenario
    if scenario and recorded != scenario:
        warnings.append(f"scenario mismatch: input={scenario!r} manifest={recorded!r}; using manifest")
    return recorded


def discover_artifact_layout(root: Path | str) -> ArtifactLayout:
    root = Path(root)
    return ArtifactLayout(
        root=root,
        app_dir=_find_app_dir(root),
        trace_path=_find_trace(root),
        manifest_path=_first_existing(root, ["bundle/manifest.json", "manifest.json"], "manifest.json"),
        result_path=_first_existing(root, ["bundle/eval/result.json", "eval/result.json", "result.json"], "result.json"),
    )


def score_case_run(
    expected_skills: list[str],
    triggered_skills: list[str],
    static_passed: int,
    static_total: int,
    evaluator_pct: float | None,
    build_success: bool | None,
) -> CaseRunScore:
    trigger_quality = score_trigger_quality(expected_skills, triggered_skills)
    relevant_triggered = bool(trigger_quality.matched_skills)
    if not relevant_triggered:
        uptake = ContextUptake(
            passed=0,
            total=static_total,
            uptake_rate=None,
            skipped_reason="relevant skill did not trigger",
        )
    else:
        uptake = ContextUptake(
            passed=static_passed,
            total=static_total,
            uptake_rate=round(static_passed / static_total, 4) if static_total else None,
        )
    return CaseRunScore(
        trigger_quality=trigger_quality,
        context_uptake=uptake,
        outcome_delta=OutcomeDelta(evaluator_pct, build_success),
    )


def aggregate_skill_results(runs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        for skill_id in str(run.get("skill_id") or "").split(","):
            skill_id = skill_id.strip()
            if skill_id:
                grouped[skill_id].append(run)

    out: dict[str, dict[str, Any]] = {}
    for skill_id, rows in grouped.items():
        baseline_rows = [row for row in rows if row.get("scenario") in BASELINE_SCENARIOS]
        skill_rows = [row for row in rows if row.get("scenario") not in BASELINE_SCENARIOS]
        baseline_eval = _avg(_values(baseline_rows, "evaluator_pct"))
        skill_eval = _avg(_values(skill_rows, "evaluator_pct"))
        outcome_delta = None
        if baseline_eval is not None and skill_eval is not None:
            outcome_delta = round(skill_eval - baseline_eval, 4)
        recall = _avg(_values(skill_rows, "trigger_recall")) or 0.0
        precision = _avg(_values(skill_rows, "trigger_precision")) or 0.0
        exact_match_rate = _avg([1.0 if row.get("trigger_exact_match") else 0.0 for row in skill_rows])
        uptake = _avg(_values(skill_rows, "uptake_rate"))
        build_success_rate = _avg([1.0 if row.get("build_success") else 0.0 for row in skill_rows]) or 0.0
        out[skill_id] = {
            "skill_id": skill_id,
            "baseline_evaluator_pct": baseline_eval,
            "skill_evaluator_pct": skill_eval,
            "outcome_delta": outcome_delta,
            "trigger_recall": round(recall, 4),
            "trigger_precision": round(precision, 4),
            "trigger_accuracy": None if exact_match_rate is None else round(exact_match_rate, 4),
            "uptake_rate": None if uptake is None else round(uptake, 4),
            "build_success_rate": round(build_success_rate, 4),
        }
    return out


def print_summary(payload: dict[str, Any]) -> None:
    run = (payload.get("runs") or [{}])[0]
    print("----- skill-eval summary -----")
    print(f"app={run.get('app')}")
    print(f"scenario={run.get('scenario')}")
    print(f"expected_skills={run.get('skill_id')}")
    print(f"detected_skills={','.join(run.get('detected_skills') or [])}")
    print(f"uptake_rate={run.get('uptake_rate')}")
    print(f"evaluator_pct={run.get('evaluator_pct')}")
    print(f"trigger_recall={run.get('trigger_recall')}")
    print(f"trigger_precision={run.get('trigger_precision')}")
    print(f"trigger_exact_match={run.get('trigger_exact_match')}")


def write_html_report(payload: dict[str, Any], path: Path | str) -> None:
    rows = []
    for run in payload.get("runs", []):
        rows.append(
            "<tr>"
            f"<td>{_e(run.get('app'))}</td>"
            f"<td>{_e(run.get('scenario'))}</td>"
            f"<td>{_e(run.get('skill_id'))}</td>"
            f"<td>{_e(', '.join(run.get('detected_skills') or []))}</td>"
            f"<td>{_e(run.get('trigger_exact_match'))}</td>"
            f"<td>{_e(_pct(run.get('trigger_recall')))}</td>"
            f"<td>{_e(_pct(run.get('trigger_precision')))}</td>"
            f"<td>{_e(_pct(run.get('uptake_rate')))}</td>"
            f"<td>{_e(_pct(run.get('evaluator_pct')))}</td>"
            "</tr>"
        )
    doc = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Expo Skill Eval</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }}
    .note {{ color: #555; max-width: 760px; }}
  </style>
</head>
<body>
  <h1>Expo Skill Eval</h1>
  <p>{_e(payload.get('summary', ''))}</p>
  <p class="note">Initial v0 signal: trace trigger detection, static code uptake checks, and optional evaluator score. No LLM judge or screenshot evidence is used.</p>
  <table>
    <thead><tr><th>App</th><th>Scenario</th><th>Expected</th><th>Detected</th><th>Exact match</th><th>Recall</th><th>Precision</th><th>Uptake</th><th>Evaluator</th></tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
</body>
</html>
"""
    Path(path).write_text(doc, encoding="utf-8")


def _find_app_dir(root: Path) -> Path | None:
    direct = [root / "bundle" / "app", root / "app"]
    for path in direct:
        if (path / "package.json").exists():
            return path
    matches = sorted(root.glob("agent-workspace/*/package.json"))
    if matches:
        return matches[0].parent
    matches = sorted(root.rglob("package.json"))
    for match in matches:
        if "node_modules" not in match.parts:
            return match.parent
    return None


def _find_trace(root: Path) -> Path | None:
    for name in TRACE_CANDIDATES:
        matches = sorted(root.rglob(name))
        if matches:
            return matches[0]
    return None


def _first_existing(root: Path, preferred: list[str], filename: str) -> Path | None:
    for rel in preferred:
        path = root / rel
        if path.exists():
            return path
    matches = sorted(root.rglob(filename))
    return matches[0] if matches else None


def _read_evaluator_pct(path: Path) -> float | None:
    data = read_json(path)
    if data.get("macro_avg_pct") is not None:
        return float(data["macro_avg_pct"])
    if data.get("micro_pct") is not None:
        return float(data["micro_pct"])
    return None


def _collect_braintrust_refs(
    author_layout: ArtifactLayout,
    eval_layout: ArtifactLayout | None,
    trace: dict[str, Any],
) -> list[str]:
    values: list[str] = []
    for item in flatten_strings(trace):
        if "braintrust" in item.lower():
            values.append(item)
    for path in [
        author_layout.manifest_path,
        eval_layout.manifest_path if eval_layout else None,
    ]:
        if not path or not path.exists():
            continue
        try:
            data = read_json(path)
        except Exception:
            continue
        for item in flatten_strings(data):
            if "braintrust" in item.lower():
                values.append(item)
    return dedupe(values)


def _values(rows: list[dict[str, Any]], key: str) -> list[float]:
    values: list[float] = []
    for row in rows:
        value = row.get(key)
        if value is None:
            continue
        values.append(float(value))
    return values


def _avg(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 4)


def _pct(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        value = float(value)
    except Exception:
        return str(value)
    if value <= 1.0:
        value *= 100
    return f"{value:.1f}%"


def _e(value: Any) -> str:
    return html.escape("" if value is None else str(value))
