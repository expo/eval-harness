"""Manifest-driven launch planning for Expo skill-eval scenario matrices."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import os
from pathlib import Path
import subprocess
from typing import Any

from .manifest import SkillEvalCase


SCENARIO_TO_PRD_VARIANT = {
    "skills_off_tools_on": "unmentioned",
    "plugin_off_baseline": "unmentioned",
    "skills_available_unmentioned": "unmentioned",
    "skills_available_mentioned": "mentioned",
}


SCENARIO_TO_CAPABILITY_MODE = {
    "skills_off_tools_on": "skills_off_tools_on",
    "plugin_off_baseline": "plugin_off_baseline",
    "skills_available_unmentioned": "expo_plugin",
    "skills_available_mentioned": "expo_plugin",
}


@dataclass
class PlannedRun:
    case_id: str
    scenario: str
    prd_variant: str
    expected_skills: list[str]
    command: list[str]
    env: dict[str, str]


def materialize_prd_variants(case: SkillEvalCase, harness_dir: Path) -> dict[str, str]:
    """Write inline PRD variants to files consumable by the authoring harness."""

    out_dir = harness_dir / "skill_eval_materialized" / case.id
    out_dir.mkdir(parents=True, exist_ok=True)
    rel_paths: dict[str, str] = {}
    for variant, text in case.prd_variants.items():
        path = out_dir / f"{_slug(variant)}.txt"
        path.write_text(text.rstrip() + "\n", encoding="utf-8")
        rel_paths[variant] = path.relative_to(harness_dir.parent).as_posix()
    return rel_paths


def plan_case_runs(case: SkillEvalCase, repo_root: Path, agent: str = "claude-code") -> list[PlannedRun]:
    repo_root = repo_root.resolve()
    if agent == "claude":
        agent = "claude-code"
    harness_dir = repo_root / "eval_harness"
    rel_prds = materialize_prd_variants(case, harness_dir)
    command = [(repo_root / "eval_harness" / "scripts" / "author_app.sh").as_posix()]
    runs: list[PlannedRun] = []
    for scenario in case.scenarios:
        variant = SCENARIO_TO_PRD_VARIANT.get(scenario)
        if not variant:
            raise ValueError(f"Unsupported skill-eval scenario: {scenario}")
        if variant not in rel_prds:
            raise ValueError(f"Case {case.id} scenario {scenario} needs missing PRD variant {variant}")
        env = {
            "AGENT": agent,
            "PRD": rel_prds[variant],
            "TEST_PLAN": case.test_plan,
            "EXPO_CAPABILITY_MODE": SCENARIO_TO_CAPABILITY_MODE.get(scenario, scenario),
            "SKILL_EVAL_CASE_ID": case.id,
            "SKILL_EVAL_SCENARIO": scenario,
            "SKILL_EVAL_PRD_VARIANT": variant,
            "SKILL_EVAL_FEATURE_FOCUS": case.feature_focus,
            "SKILL_EVAL_EXPECTED_SKILLS": ",".join(case.expected_skills),
        }
        runs.append(PlannedRun(
            case_id=case.id,
            scenario=scenario,
            prd_variant=variant,
            expected_skills=case.expected_skills,
            command=command,
            env=env,
        ))
    return runs


def run_case_matrix(
    case: SkillEvalCase,
    repo_root: Path,
    agent: str = "claude-code",
    execute: bool = False,
) -> dict[str, Any]:
    planned = plan_case_runs(case, repo_root, agent)
    payload: dict[str, Any] = {
        "case_id": case.id,
        "execute": execute,
        "runs": [asdict(run) for run in planned],
    }
    if not execute:
        return payload

    results = []
    for run in planned:
        env = os.environ.copy()
        env.update(run.env)
        completed = subprocess.run(run.command, cwd=repo_root, env=env, check=False)
        results.append({
            "case_id": run.case_id,
            "scenario": run.scenario,
            "returncode": completed.returncode,
        })
    payload["execution_results"] = results
    return payload


def _slug(value: str) -> str:
    chars = [c.lower() if c.isalnum() else "-" for c in value]
    return "-".join("".join(chars).split("-")).strip("-") or "variant"
