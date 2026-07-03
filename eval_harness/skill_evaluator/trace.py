"""Trace analysis for skill trigger quality."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Iterable

from . import CORE_SKILLS


SKILL_ALIASES = {
    "building-native-ui": ["building-native-ui", "building native ui", "native ui"],
    "expo-ui": ["expo-ui", "@expo/ui", "expo ui"],
    "native-data-fetching": ["native-data-fetching", "native data fetching"],
    "expo-dev-client": ["expo-dev-client", "dev client", "development client"],
    "expo-tailwind-setup": ["expo-tailwind-setup", "tailwind setup", "nativewind"],
}


@dataclass
class TriggerQuality:
    expected_skills: list[str]
    triggered_skills: list[str]
    matched_skills: list[str]
    extra_skills: list[str]
    missing_skills: list[str]
    recall: float
    precision: float
    any_expo_skill_triggered: bool


def load_trace(path: Path | str) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def detect_triggered_skills(trace: dict[str, Any]) -> list[str]:
    text = "\n".join(_flatten_strings(trace)).lower()
    observed: list[str] = []
    for skill in CORE_SKILLS:
        aliases = SKILL_ALIASES.get(skill, [skill])
        if any(alias.lower() in text for alias in aliases):
            observed.append(skill)
    return observed


def score_trigger_quality(expected_skills: Iterable[str], triggered_skills: Iterable[str]) -> TriggerQuality:
    expected = _dedupe(expected_skills)
    triggered = _dedupe([s for s in triggered_skills if s in CORE_SKILLS])
    expected_set = set(expected)
    triggered_set = set(triggered)
    matched = [s for s in expected if s in triggered_set]
    extra = [s for s in triggered if s not in expected_set]
    missing = [s for s in expected if s not in triggered_set]
    recall = len(matched) / len(expected) if expected else 1.0
    precision = len(matched) / len(triggered) if triggered else (1.0 if not expected else 0.0)
    return TriggerQuality(
        expected_skills=expected,
        triggered_skills=triggered,
        matched_skills=matched,
        extra_skills=extra,
        missing_skills=missing,
        recall=round(recall, 4),
        precision=round(precision, 4),
        any_expo_skill_triggered=bool(triggered),
    )


def _flatten_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _flatten_strings(k)
            yield from _flatten_strings(v)
    elif isinstance(value, list):
        for item in value:
            yield from _flatten_strings(item)


def _dedupe(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            out.append(value)
            seen.add(value)
    return out
