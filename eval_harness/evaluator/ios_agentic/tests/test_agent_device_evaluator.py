import asyncio
import unittest
from pathlib import Path
from unittest.mock import patch

from claude_agent_sdk import AssistantMessage, ResultMessage, UserMessage
from claude_agent_sdk.types import TextBlock
from mcp import types as mcp_types

from eval_harness.evaluator.ios_agentic.agent_device.bridge import AgentDeviceResult
from eval_harness.evaluator.ios_agentic.agent_device.evaluator import AgentDeviceEvaluator
from eval_harness.evaluator.ios_agentic.agent_device.tools import build_tools
from eval_harness.evaluator.ios_agentic.core.tool_state import StepState, ToolContext
from eval_harness.evaluator.ios_agentic.core.turn_aggregator import UsageAccumulator


class FailedRestartBridge:
    def restart_app(self, clear_state: bool = False) -> AgentDeviceResult:
        return AgentDeviceResult(
            success=False,
            output="",
            error="development client launcher never reached authored app",
        )


class RecordingTracer:
    def __init__(self, *args, **kwargs) -> None:
        self.root = Path("/tmp/test-ios-evaluator-trace")
        self.events: list[tuple[str, dict]] = []

    def capture_console(self) -> None:
        return None

    def log(self, event: str, **fields) -> None:
        self.events.append((event, fields))

    def close(self) -> None:
        return None


class RecordingTurnAggregator:
    def __init__(self) -> None:
        self.assistant_messages = 0
        self.user_messages = 0
        self.result_messages = 0

    def on_assistant(self, message) -> None:
        self.assistant_messages += 1

    def on_user(self, message) -> None:
        self.user_messages += 1

    def on_result(self, message) -> None:
        self.result_messages += 1


def sdk_result() -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="test-session",
        stop_reason="interrupted",
        usage={},
    )


class CompletionStreamClient:
    def __init__(self, state: StepState) -> None:
        self.state = state
        self.interrupt_calls = 0

    async def interrupt(self) -> None:
        self.interrupt_calls += 1

    async def receive_response(self):
        self.state.completed = True
        yield UserMessage(content="complete_step tool result")
        yield AssistantMessage(
            content=[TextBlock(text="invented work after completion")],
            model="test-model",
            usage={},
        )
        yield sdk_result()


async def call_mcp_tool(server: dict, name: str, arguments: dict):
    instance = server["instance"]
    handler = instance.request_handlers[mcp_types.CallToolRequest]
    request = mcp_types.CallToolRequest(
        method="tools/call",
        params=mcp_types.CallToolRequestParams(name=name, arguments=arguments),
    )
    return await handler(request)


class AgentDeviceEvaluatorOutcomeTests(unittest.TestCase):
    def test_regression_restart_failure_is_an_evaluator_error(self) -> None:
        """Regression: a driver restart fault is not an app score of zero.

        Oracle: the harness/app boundary requires infrastructure failures to
        carry a distinct evaluator-error status and reason.
        Catches: returning the default empty TestPlanResult after restart fails.
        """
        evaluator = AgentDeviceEvaluator.__new__(AgentDeviceEvaluator)
        evaluator.platform = "ios"
        evaluator.hybrid_restart = False
        evaluator.bridge = FailedRestartBridge()

        with (
            patch(
                "eval_harness.evaluator.ios_agentic.agent_device.evaluator.parse_test_plan",
                return_value={"full_points": 6, "steps": []},
            ),
            patch(
                "eval_harness.evaluator.ios_agentic.agent_device.evaluator.Tracer",
                RecordingTracer,
            ),
        ):
            result = asyncio.run(evaluator._evaluate_test_plan_async(Path("test_insert.txt")))

        self.assertEqual(result.status, "evaluator_error")
        self.assertEqual(result.error_stage, "restart")
        self.assertEqual(
            result.error_reason,
            "development client launcher never reached authored app",
        )
        self.assertEqual(result.score, 0)
        self.assertEqual(result.steps, [])


class AgentDeviceEvaluatorLifecycleTests(unittest.TestCase):
    def test_regression_complete_step_interrupts_and_ignores_extra_agent_work(self) -> None:
        """Regression: completion stops useful processing at the tool boundary.

        Oracle: the orchestrator, not the model, owns phase transitions.
        Catches: waiting for Claude to end naturally and processing invented
        setup/formal steps after complete_step.
        """
        evaluator = AgentDeviceEvaluator.__new__(AgentDeviceEvaluator)
        state = StepState(step={"name": "seed"})
        client = CompletionStreamClient(state)
        turn_agg = RecordingTurnAggregator()

        asyncio.run(
            evaluator._receive_phase_response(
                client,
                state,
                turn_agg,
                UsageAccumulator(),
            )
        )

        self.assertEqual(client.interrupt_calls, 1)
        self.assertEqual(turn_agg.user_messages, 1)
        self.assertEqual(turn_agg.assistant_messages, 0)
        self.assertEqual(turn_agg.result_messages, 1)

    def test_spec_abort_step_records_reason_and_interrupts_the_phase(self) -> None:
        """Specification: a blocked evaluator phase terminates explicitly.

        Oracle: evaluator infrastructure failures must have a machine-readable
        category/reason and cannot consume the remaining turn budget.
        Catches: prose-only SETUP BLOCKED summaries and unbounded retries.
        """
        evaluator = AgentDeviceEvaluator.__new__(AgentDeviceEvaluator)
        ctx = ToolContext(object())
        state = ctx.reset_state({"name": "seed"})
        server, tool_names = build_tools(ctx)

        asyncio.run(
            call_mcp_tool(
                server,
                "abort_step",
                {
                    "category": "driver_error",
                    "reason": "text entry failed after all supported fallbacks",
                },
            )
        )

        self.assertIn("abort_step", tool_names)
        self.assertTrue(state.aborted)
        self.assertEqual(state.abort_category, "driver_error")
        self.assertEqual(
            state.abort_reason,
            "text entry failed after all supported fallbacks",
        )

        client = CompletionStreamClient(state)
        turn_agg = RecordingTurnAggregator()
        asyncio.run(
            evaluator._receive_phase_response(
                client,
                state,
                turn_agg,
                UsageAccumulator(),
            )
        )

        self.assertEqual(client.interrupt_calls, 1)


if __name__ == "__main__":
    unittest.main()
