import unittest
from unittest.mock import patch

from eval_harness.evaluator.ios_agentic.agent_device.bridge import (
    AgentDeviceBridge,
    AgentDeviceResult,
)


class RecordingAgentDeviceBridge(AgentDeviceBridge):
    """Exercise bridge behavior while replacing only the external CLI boundary."""

    def __init__(self) -> None:
        super().__init__()
        self.commands: list[tuple[list[str], int | None]] = []

    def _run_cmd(
        self,
        args: list[str],
        timeout: int | None = None,
    ) -> AgentDeviceResult:
        self.commands.append((args, timeout))
        if args in (["press", "@e15"], ["fill", "@e15", "secret"]):
            return AgentDeviceResult(success=True, output="ok")
        if args == ["snapshot", "-i", "--raw"]:
            return AgentDeviceResult(success=True, output="")
        return AgentDeviceResult(
            success=False,
            output="",
            error=f"unexpected agent-device command: {args!r}",
        )


class AgentDeviceBridgeFillTests(unittest.TestCase):
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_regression_fill_uses_snapshot_reference_without_id_selector(
        self,
        _sleep,
    ) -> None:
        """Regression: transient snapshot refs remain agent-device refs.

        Oracle: agent-device's selector contract distinguishes snapshot refs such
        as @e15 from accessibility identifiers such as id="input-password".
        Catches: rewriting a ref as an id selector and returning before fallback.
        """
        bridge = RecordingAgentDeviceBridge()

        result = bridge.fill("@e15", "secret")

        self.assertTrue(result.success, result.error)
        self.assertEqual(
            bridge.commands,
            [
                (["press", "@e15"], None),
                (["fill", "@e15", "secret"], None),
                (["snapshot", "-i", "--raw"], 15),
            ],
        )


if __name__ == "__main__":
    unittest.main()
