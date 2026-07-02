"""Aggregate scenario rows into per-skill classifications."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .metrics import classify_skill


BASELINE_SCENARIOS = {"plugin_off_baseline", "skills_off_tools_on", "skills_off"}


def aggregate_skill_results(runs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        for skill_id in str(run.get("skill_id") or "").split(","):
            skill_id = skill_id.strip()
            if skill_id:
                grouped[skill_id].append(run)

    out: dict[str, dict[str, Any]] = {}
    for skill_id, rows in grouped.items():
        baseline_rows = [r for r in rows if r.get("scenario") in BASELINE_SCENARIOS]
        skill_rows = [r for r in rows if r.get("scenario") not in BASELINE_SCENARIOS]
        baseline_eval = _avg(_values(baseline_rows, "evaluator_pct"))
        skill_eval = _avg(_values(skill_rows, "evaluator_pct"))
        outcome_delta = None
        if baseline_eval is not None and skill_eval is not None:
            outcome_delta = round(skill_eval - baseline_eval, 4)
        recall = _avg(_values(skill_rows, "trigger_recall")) or 0.0
        precision = _avg(_values(skill_rows, "trigger_precision")) or 0.0
        uptake = _avg(_values(skill_rows, "uptake_rate"))
        build_success_rate = _avg([1.0 if r.get("build_success") else 0.0 for r in skill_rows]) or 0.0
        out[skill_id] = {
            "skill_id": skill_id,
            "baseline_evaluator_pct": baseline_eval,
            "skill_evaluator_pct": skill_eval,
            "outcome_delta": outcome_delta,
            "trigger_recall": round(recall, 4),
            "trigger_precision": round(precision, 4),
            "uptake_rate": None if uptake is None else round(uptake, 4),
            "build_success_rate": round(build_success_rate, 4),
            "classification": classify_skill(
                recall,
                precision,
                uptake,
                outcome_delta if outcome_delta is not None else 0.0,
                build_success_rate,
            ),
        }
    return out


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
