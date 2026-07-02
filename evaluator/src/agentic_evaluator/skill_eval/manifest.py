"""Skill-eval case specification loading.

The case spec is the ground truth that ties a PRD variant to expected skill
triggers, static uptake checks, evaluator plans, and screenshot targets.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any


@dataclass
class SkillEvalCase:
    id: str
    feature_focus: str
    expected_skills: list[str]
    prd_variants: dict[str, str]
    scenarios: list[str]
    static_uptake_checks: list[dict[str, Any]]
    test_plan: str
    screenshot_targets: list[dict[str, Any]] = field(default_factory=list)


def load_case_spec(path: Path | str) -> SkillEvalCase:
    path = Path(path)
    data = _load_structured(path)
    required = [
        "id",
        "feature_focus",
        "expected_skills",
        "prd_variants",
        "scenarios",
        "static_uptake_checks",
        "test_plan",
    ]
    missing = [k for k in required if k not in data]
    if missing:
        raise ValueError(f"{path} missing required fields: {', '.join(missing)}")
    return SkillEvalCase(
        id=str(data["id"]),
        feature_focus=str(data["feature_focus"]),
        expected_skills=list(data["expected_skills"]),
        prd_variants=dict(data["prd_variants"]),
        scenarios=list(data["scenarios"]),
        static_uptake_checks=list(data["static_uptake_checks"]),
        test_plan=str(data["test_plan"]),
        screenshot_targets=list(data.get("screenshot_targets") or []),
    )


def _load_structured(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    if path.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except Exception as exc:
            raise RuntimeError("YAML case specs require PyYAML; use JSON or install yaml") from exc
        return yaml.safe_load(text)
    raise ValueError(f"Unsupported case spec extension: {path.suffix}")
