"""Metric aggregation and skill classification."""

from __future__ import annotations

from dataclasses import dataclass

from .trace import TriggerQuality, score_trigger_quality


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
    visual_quality: float | None


@dataclass
class CaseRunScore:
    trigger_quality: TriggerQuality
    context_uptake: ContextUptake
    outcome_delta: OutcomeDelta


def score_case_run(
    expected_skills: list[str],
    triggered_skills: list[str],
    static_passed: int,
    static_total: int,
    evaluator_pct: float | None,
    build_success: bool | None,
    visual_quality: float | None,
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
        outcome_delta=OutcomeDelta(evaluator_pct, build_success, visual_quality),
    )


def classify_skill(
    trigger_recall: float,
    trigger_precision: float,
    uptake_rate: float | None,
    outcome_delta: float,
    build_success_rate: float,
    *,
    min_trigger: float = 0.75,
    min_uptake: float = 0.6,
    min_positive_delta: float = 1.0,
    min_build_success: float = 0.8,
) -> str:
    if build_success_rate < min_build_success or outcome_delta < min_positive_delta:
        return "Unhelpful"
    if trigger_recall < min_trigger or trigger_precision < min_trigger:
        return "Needs trigger tuning"
    if uptake_rate is None or uptake_rate < min_uptake:
        return "Needs content tuning"
    return "Helpful"
