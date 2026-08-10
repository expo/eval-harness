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


class RecordingDevClientRestartBridge(AgentDeviceBridge):
    def __init__(self) -> None:
        super().__init__(
            app_id="com.example.authored",
            deep_link=(
                "example://expo-development-client/"
                "?url=http%3A%2F%2Flocalhost%3A8081"
            ),
        )
        self.simctl_commands: list[list[str]] = []

    def _simctl(self, args: list[str], timeout: int = 15) -> AgentDeviceResult:
        self.simctl_commands.append(args)
        return AgentDeviceResult(success=True, output="ok")

    def _snapshot_raw(self) -> list[dict]:
        return [
            {
                "type": "Button",
                "identifier": "authored-app-ready",
                "label": "Ready",
            }
        ]


class RecordingMaestroRestart:
    def __init__(self) -> None:
        self.clear_state_calls: list[bool] = []

    def restart_app(self, clear_state: bool = False) -> AgentDeviceResult:
        self.clear_state_calls.append(clear_state)
        return AgentDeviceResult(success=True, output="ready")


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


class AgentDeviceBridgeRestartTests(unittest.TestCase):
    @patch.dict("os.environ", {}, clear=False)
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_characterization_dev_client_preserves_shared_launcher_state_by_default(
        self,
        _sleep,
    ) -> None:
        """Characterization: dev-client data clearing requires explicit opt-in.

        Oracle: observed bridge default plus the shared launcher/app-container
        constraint. Catches: deleting launcher state on every plan restart.
        """
        import os

        os.environ.pop("EVAL_DEV_CLIENT_CLEAR_STATE", None)
        bridge = RecordingDevClientRestartBridge()

        result = bridge.restart_app(clear_state=True)

        self.assertTrue(result.success, result.error)
        self.assertNotIn(
            ["get_app_container", "booted", "com.example.authored", "data"],
            bridge.simctl_commands,
        )

    @patch.dict("os.environ", {}, clear=False)
    def test_regression_hybrid_restart_preserves_dev_client_launcher_state(
        self,
    ) -> None:
        """Regression: hybrid restarts obey the dev-client clearing policy.

        Oracle: the shared launcher container is cleared only with explicit
        EVAL_DEV_CLIENT_CLEAR_STATE=1 opt-in.
        Catches: forwarding the evaluator's generic clear request to Maestro.
        """
        import os

        os.environ.pop("EVAL_DEV_CLIENT_CLEAR_STATE", None)
        bridge = AgentDeviceBridge(
            app_id="com.example.authored",
            deep_link=(
                "example://expo-development-client/"
                "?url=http%3A%2F%2Flocalhost%3A8081"
            ),
        )
        maestro = RecordingMaestroRestart()
        bridge._maestro = maestro

        result = bridge.restart_app_hybrid(clear_state=True)

        self.assertTrue(result.success, result.error)
        self.assertEqual(maestro.clear_state_calls, [False])

    @patch.dict("os.environ", {"EVAL_DEV_CLIENT_CLEAR_STATE": "1"})
    def test_spec_hybrid_restart_allows_explicit_dev_client_clear(self) -> None:
        """Specification: explicit diagnostic opt-in still clears app state.

        Oracle: EVAL_DEV_CLIENT_CLEAR_STATE=1 is the documented destructive override.
        Catches: preserving the container unconditionally in hybrid mode.
        """
        bridge = AgentDeviceBridge(
            app_id="com.example.authored",
            deep_link=(
                "example://expo-development-client/"
                "?url=http%3A%2F%2Flocalhost%3A8081"
            ),
        )
        maestro = RecordingMaestroRestart()
        bridge._maestro = maestro

        result = bridge.restart_app_hybrid(clear_state=True)

        self.assertTrue(result.success, result.error)
        self.assertEqual(maestro.clear_state_calls, [True])


if __name__ == "__main__":
    unittest.main()
