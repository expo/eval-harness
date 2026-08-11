"""
Shared scoring dataclasses and the per-step scoring function.

Lives in its own module so both `evaluator.py` and `agent_tools.py` can
import without a circular reference. `evaluator.py` re-exports these names
so external callers can still import them from `.evaluator`.

Scoring contract (primitive-scoped convention):
- Any fatal assertion (hard or soft) that fails → 0 points for the step
  (binary gate at step level, not test level).
- LLM never signalled completion → 0 points.
- Otherwise, partial credit is computed across BOTH hard and soft assertions
  equally — each Verify line is worth one unit in the partial-credit pool.
  Under the primitive-scoped authoring convention, max_points for a step is
  set to the count of Verify lines, so earned == count-of-passing-verifies.
- Test-level and suite-level macro aggregation (mean of percentages at each
  level) is computed in the caller, not here.
"""

from dataclasses import dataclass, field
from typing import Literal


PlanStatus = Literal["in_progress", "completed", "not_applicable", "evaluator_error"]
AbortScope = Literal["plan", "suite"]


@dataclass
class AssertionResult:
    yaml_cmd: str
    fatal: bool
    passed: bool


@dataclass
class SoftAssertionResult:
    check: str
    fatal: bool
    passed: bool
    evidence: str = ""


@dataclass
class StepResult:
    name: str
    max_points: int
    earned_points: int
    passed: bool
    assertions: list[AssertionResult] = field(default_factory=list)
    soft_assertions: list[SoftAssertionResult] = field(default_factory=list)
    iterations_used: int = 0
    completed_by_llm: bool = False
    screenshot_path: str | None = None
    screenshot_error: str | None = None


@dataclass
class TerminalEvidence:
    """Human-only evidence for a formal step or pre-plan lifecycle abort."""

    step_number: int
    step_name: str
    screenshot_path: str | None = None
    screenshot_error: str | None = None


@dataclass
class TestPlanResult:
    score: int
    full_points: int
    steps: list[StepResult] = field(default_factory=list)
    terminal_evidence: list[TerminalEvidence] = field(default_factory=list)
    status: PlanStatus = "in_progress"
    error_stage: str = ""
    error_reason: str = ""
    abort_scope: AbortScope = "plan"
    not_applicable: bool = False  # True when seed phase signaled N/A; formal steps skipped
    na_reason: str = ""  # the agent's N/A justification (from the seed complete_step summary)


def score_step(
    step: dict,
    assertions: list[AssertionResult],
    soft_assertions: list[SoftAssertionResult],
    completed: bool,
    iterations_used: int,
) -> StepResult:
    max_points = step["points"]
    fatal_hard_failed = any(not a.passed for a in assertions if a.fatal)
    fatal_soft_failed = any(not a.passed for a in soft_assertions if a.fatal)
    any_fatal_failed = fatal_hard_failed or fatal_soft_failed

    if any_fatal_failed or not completed:
        earned = 0
        passed = False
    else:
        all_checks = assertions + soft_assertions
        if not all_checks:
            earned = max_points
            passed = True
        else:
            total = len(all_checks)
            passed_count = sum(1 for a in all_checks if a.passed)
            earned = round(max_points * passed_count / total)
            passed = earned == max_points

    return StepResult(
        name=step["name"],
        max_points=max_points,
        earned_points=earned,
        passed=passed,
        assertions=assertions,
        soft_assertions=soft_assertions,
        iterations_used=iterations_used,
        completed_by_llm=completed,
    )
