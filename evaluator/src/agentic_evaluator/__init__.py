"""Agentic evaluator for Expo / React Native apps.

Heavy evaluator classes are imported lazily so lightweight offline helpers
(for example skill-eval trace/static analyzers) do not require simulator or
Claude SDK dependencies just to import this package.
"""

from .core.scoring import AssertionResult, SoftAssertionResult, StepResult, TestPlanResult

__all__ = [
    "MaestroEvaluator",
    "AgentDeviceEvaluator",
    "TestPlanResult",
    "StepResult",
    "SoftAssertionResult",
    "AssertionResult",
]


def __getattr__(name):
    if name == "MaestroEvaluator":
        from .maestro.evaluator import MaestroEvaluator
        return MaestroEvaluator
    if name == "AgentDeviceEvaluator":
        from .agent_device.evaluator import AgentDeviceEvaluator
        return AgentDeviceEvaluator
    raise AttributeError(name)
