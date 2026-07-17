"""Trace-based skill-trigger detection and scoring.

This is tier 0 of the uptake cascade (was the skill invoked at all?), kept in
this package alongside the content-level checks (tiers 1+, see registry.py)
rather than as a separate top-level module -- it's still "was this skill's
guidance actually exercised," just answered from the trace instead of the
authored source.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterable

from ..utils import dedupe, read_json


# Codex has no dedicated skill-invocation tool; skills are files under
# .agents/skills/<id>/ that it can only reach via shell commands. Matching the
# path (not free text) avoids false positives from unrelated command output.
_CODEX_SKILL_PATH_RE = re.compile(r"\.agents/skills/([A-Za-z0-9_-]+)/")


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


def load_trace(path) -> dict[str, Any]:
    return read_json(path)


def detect_triggered_skills(trace: dict[str, Any]) -> list[str]:
    """Detect genuinely-invoked skills from the trace's own tool-call structure.

    Deliberately does not flatten the trace to free text and substring-match --
    that matches incidental noise (npm/package.json output, unrelated repo file
    listings) as readily as real use. Detection is agent-specific because the
    two agents expose skill invocation differently:
      - Claude Code has a dedicated `Skill` tool; `args["skill"]` is
        "<plugin>:<skill-id>" (e.g. "expo:expo-router").
      - Codex has no such tool; a skill can only be read via a shell command,
        so we match the `.agents/skills/<id>/` path in `exec_command` args.
    """
    agent = (trace.get("agent") or "").lower()
    observed: list[str] = []
    for session in trace.get("sessions", []):
        for turn in session.get("turns", []):
            for step in turn.get("steps", []):
                for call in step.get("tool_calls") or []:
                    observed.extend(_skills_from_tool_call(agent, call))
    return dedupe(observed)


def _skills_from_tool_call(agent: str, call: dict[str, Any]) -> list[str]:
    name = call.get("name")
    args = call.get("args") or {}
    if name == "Skill":
        skill = str(args.get("skill") or "")
        return [skill.rsplit(":", 1)[-1]] if skill else []
    if name == "exec_command":
        cmd = str(args.get("cmd") or args.get("command") or "")
        return _CODEX_SKILL_PATH_RE.findall(cmd)
    return []


def score_trigger_quality(expected_skills: Iterable[str], triggered_skills: Iterable[str]) -> TriggerQuality:
    expected = dedupe(list(expected_skills))
    triggered = dedupe(list(triggered_skills))
    expected_set = set(expected)
    triggered_set = set(triggered)
    matched = [skill for skill in expected if skill in triggered_set]
    extra = [skill for skill in triggered if skill not in expected_set]
    missing = [skill for skill in expected if skill not in triggered_set]
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
