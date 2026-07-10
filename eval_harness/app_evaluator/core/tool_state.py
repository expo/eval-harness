"""
Shared per-step state for the SDK tool implementations.

Both `maestro_tools.py` and `agent_device_tools.py` close over a `ToolContext`
that wraps the bridge and the current `StepState`. The evaluator swaps `state`
between steps; tools mutate it for scoring.

The bridge field is intentionally untyped (`Any`) so this module doesn't need to
know about either MaestroBridge or AgentDeviceBridge. The two bridge types
share a duck-typed surface (the methods tools call) but no explicit interface.
"""

from dataclasses import dataclass, field
from typing import Any

from .scoring import AssertionResult, SoftAssertionResult


@dataclass
class StepState:
    """Per-step scoring state. Mutated by tools, read by the evaluator at step end."""
    step: dict
    assertions: list[AssertionResult] = field(default_factory=list)
    soft_assertions: list[SoftAssertionResult] = field(default_factory=list)
    turns_used: int = 0
    completed: bool = False
    complete_summary: str = ""  # captured from complete_step's summary arg
    fatal_failed: bool = False
    last_command_failed: bool = False  # set by action tools on error


class ToolContext:
    """
    Holds the bridge and the current StepState. The evaluator swaps `state`
    between steps; tools close over this context so they always see the right state.
    """
    def __init__(self, bridge: Any):
        self.bridge = bridge
        self.state: StepState | None = None

    def reset_state(self, step: dict) -> StepState:
        self.state = StepState(step=step)
        return self.state
