import os
import tempfile
import unittest
from pathlib import Path
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


class SequencedAlertRestartBridge(AgentDeviceBridge):
    """Keep restart/readiness real while replacing simulator and CLI I/O."""

    def __init__(self, snapshots: list[list[dict]]) -> None:
        super().__init__(app_id="com.example.authored", deep_link="example://ready")
        self.snapshots = list(snapshots)
        self.last_snapshot = snapshots[-1]
        self.commands: list[list[str]] = []
        self.simctl_commands: list[list[str]] = []

    def _simctl(self, args: list[str], timeout: int = 15) -> AgentDeviceResult:
        self.simctl_commands.append(args)
        return AgentDeviceResult(success=True, output="ok")

    def _snapshot_raw(self) -> list[dict]:
        if self.snapshots:
            self.last_snapshot = self.snapshots.pop(0)
        return self.last_snapshot

    def _run_cmd(
        self,
        args: list[str],
        timeout: int | None = None,
    ) -> AgentDeviceResult:
        self.commands.append(args)
        return AgentDeviceResult(success=True, output="ok")


def permission_alert(title: str, deny: str, allow: str) -> list[dict]:
    return [
        {"type": "Application", "label": "Authored App"},
        {"type": "Alert", "label": title},
        {"type": "Button", "label": deny, "ref": "e7"},
        {"type": "Button", "label": allow, "ref": "e8"},
    ]


def authored_content() -> list[dict]:
    return [
        {"type": "Application", "label": "Authored App"},
        {
            "type": "Button",
            "identifier": "authored-app-ready",
            "label": "Ready",
        },
    ]


class RecordingMaestroRestart:
    def __init__(self) -> None:
        self.clear_state_calls: list[bool] = []

    def restart_app(self, clear_state: bool = False) -> AgentDeviceResult:
        self.clear_state_calls.append(clear_state)
        return AgentDeviceResult(success=True, output="ready")


class RecordingScreenshotBridge(AgentDeviceBridge):
    """Keep screenshot path policy real while replacing the external CLI."""

    def __init__(self) -> None:
        super().__init__()
        self.commands: list[list[str]] = []

    def _run_cmd(
        self,
        args: list[str],
        timeout: int | None = None,
    ) -> AgentDeviceResult:
        self.commands.append(args)
        return AgentDeviceResult(success=True, output=args[1])


class AgentDeviceBridgeScreenshotTests(unittest.TestCase):
    def test_spec_discretionary_screenshot_stays_inside_active_trace(self) -> None:
        """Specification: no-argument captures are durable plan evidence.

        Oracle: EVAL_SCREENSHOT_DIR is the only allowed capture root.
        Catches: falling back to an uncollected system temporary directory.
        """
        bridge = RecordingScreenshotBridge()

        with tempfile.TemporaryDirectory() as td:
            trace = Path(td) / "plan-trace"
            screenshot_root = trace / "screenshots"
            with patch.dict(os.environ, {"EVAL_SCREENSHOT_DIR": str(screenshot_root)}):
                result = bridge.capture_screenshot()

            self.assertTrue(result.success, result.error)
            self.assertTrue(Path(result.output).is_relative_to(screenshot_root))
            self.assertEqual(bridge.commands, [["screenshot", result.output]])

    def test_spec_explicit_screenshot_cannot_escape_active_trace(self) -> None:
        """Specification: explicit capture paths cannot escape the evidence root.

        Oracle: a resolved sibling path is outside EVAL_SCREENSHOT_DIR.
        Catches: an agent or caller writing arbitrary files through agent-device.
        """
        bridge = RecordingScreenshotBridge()

        with tempfile.TemporaryDirectory() as td:
            trace = Path(td) / "plan-trace"
            screenshot_root = trace / "screenshots"
            escaped = trace / "escaped.png"
            with patch.dict(os.environ, {"EVAL_SCREENSHOT_DIR": str(screenshot_root)}):
                result = bridge.capture_screenshot(str(escaped))

        self.assertFalse(result.success)
        self.assertIn("outside EVAL_SCREENSHOT_DIR", result.error)
        self.assertEqual(bridge.commands, [])


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
    @patch.dict(
        os.environ,
        {"EVAL_DEV_UDID": "SELECTED-UDID", "EVAL_DEV_CLIENT_CLEAR_STATE": "1"},
    )
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_simctl_lifecycle_targets_selected_simulator_udid(self, _sleep) -> None:
        """Every native lifecycle operation stays on the selected runtime.

        Catches: using the ambiguous `booted` alias after simulator selection
        boots a higher runtime while a lower-runtime device remains booted.
        """
        bridge = RecordingDevClientRestartBridge()

        result = bridge.restart_app(clear_state=True)

        self.assertTrue(result.success, result.error)
        self.assertEqual(
            bridge.simctl_commands,
            [
                ["terminate", "SELECTED-UDID", "com.example.authored"],
                [
                    "get_app_container",
                    "SELECTED-UDID",
                    "com.example.authored",
                    "data",
                ],
                [
                    "openurl",
                    "SELECTED-UDID",
                    "example://expo-development-client/"
                    "?url=http%3A%2F%2Flocalhost%3A8081",
                ],
            ],
        )

    @patch.dict(os.environ, {"EVAL_DEV_UDID": "SELECTED-UDID"})
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_dev_client_retry_reopens_selected_simulator_udid(self, _sleep) -> None:
        """Launcher recovery cannot drift to another booted simulator."""
        bridge = SequencedAlertRestartBridge(
            [
                [
                    {"type": "Application", "label": "Development servers"},
                    {"type": "StaticText", "label": "Recently opened"},
                ],
                authored_content(),
            ]
        )

        result = bridge.restart_app(clear_state=False)

        self.assertTrue(result.success, result.error)
        self.assertEqual(
            bridge.simctl_commands,
            [
                ["terminate", "SELECTED-UDID", "com.example.authored"],
                ["openurl", "SELECTED-UDID", "example://ready"],
                ["openurl", "SELECTED-UDID", "example://ready"],
            ],
        )

    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_spec_preflight_neutrally_dismisses_known_permission_alerts(
        self,
        _sleep,
    ) -> None:
        """Specification: cold-launch permissions cannot hide authored UI.

        Oracle: recognized permission dialogs choose the literal neutral button,
        record that decision, then require app-owned readiness.
        Catches: timing out on a valid app or accepting the alert as app content.
        """
        cases = [
            (
                "“Pool” Would Like to Use Your Current Location",
                "Don’t Allow",
                "Allow While Using App",
            ),
            (
                "“Notes” Would Like to Send You Notifications",
                "Don't Allow",
                "Allow",
            ),
            (
                "“Reader” Would Like Permission to Track You Across Apps and Websites",
                "Ask App Not to Track",
                "Allow",
            ),
        ]

        for title, deny, allow in cases:
            with self.subTest(title=title):
                bridge = SequencedAlertRestartBridge(
                    [permission_alert(title, deny, allow), authored_content()]
                )

                result = bridge.restart_app(clear_state=True, preflight=True)

                self.assertTrue(result.success, result.error)
                self.assertEqual(bridge.commands, [["press", "@e7"]])
                self.assertEqual(
                    bridge.last_restart_diagnostics,
                    [
                        {
                            "kind": "permission_alert",
                            "phase": "preflight",
                            "alert": title,
                            "action": "dismissed",
                            "button": deny,
                        }
                    ],
                )

    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_spec_unknown_preflight_alert_aborts_without_blind_dismissal(
        self,
        _sleep,
    ) -> None:
        """Specification: the harness never guesses on an unknown alert.

        Oracle: an unrecognized blocking alert returns its title immediately and
        issues no press command.
        Catches: blind cancel/coordinate taps or a full readiness timeout.
        """
        title = "Sign in to your Apple Account"
        bridge = SequencedAlertRestartBridge(
            [
                [
                    {"type": "Application", "label": "Authored App"},
                    {"type": "Alert", "label": "System Alert"},
                    {"type": "StaticText", "label": title},
                    {"type": "Button", "label": "Cancel", "ref": "e7"},
                    {"type": "Button", "label": "Continue", "ref": "e8"},
                ]
            ]
        )

        result = bridge.restart_app(clear_state=True, preflight=True)

        self.assertFalse(result.success)
        self.assertEqual(
            result.error,
            'restart_app: blocked by unrecognized iOS system alert: "Sign in to your Apple Account"',
        )
        self.assertEqual(bridge.commands, [])

    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_regression_known_expo_continue_alert_keeps_existing_handler(
        self,
        _sleep,
    ) -> None:
        """Regression: system-alert detection does not intercept Expo shell UI.

        Oracle: the established Continue affordance is pressed before unknown
        alert classification, then authored app content becomes ready.
        Catches: treating every UIAlert tree as an unknown iOS permission block.
        """
        bridge = SequencedAlertRestartBridge(
            [
                [
                    {"type": "Application", "label": "Expo Go"},
                    {"type": "Alert", "label": "Open this project?"},
                    {"type": "Button", "label": "Continue", "ref": "e8"},
                ],
                authored_content(),
            ]
        )

        result = bridge.restart_app(clear_state=True, preflight=True)

        self.assertTrue(result.success, result.error)
        self.assertEqual(bridge.commands, [["press", 'label="Continue"']])

    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_spec_in_session_restart_preserves_permission_alert_for_evaluator(
        self,
        _sleep,
    ) -> None:
        """Specification: permission assertions remain under model/tool control.

        Oracle: outside preflight, a recognized permission dialog is a ready UI
        state and no neutral response is pressed.
        Catches: silently deciding permission after a formal plan has begun.
        """
        title = "“Notes” Would Like to Send You Notifications"
        bridge = SequencedAlertRestartBridge(
            [permission_alert(title, "Don't Allow", "Allow")]
        )

        result = bridge.restart_app(clear_state=False)

        self.assertTrue(result.success, result.error)
        self.assertEqual(result.output, "ready (system alert preserved for evaluator)")
        self.assertEqual(bridge.commands, [])
        self.assertEqual(bridge.last_restart_diagnostics, [])

    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_spec_no_alert_still_requires_authored_app_content(self, _sleep) -> None:
        """Specification: ordinary preflight readiness keeps the app-owned gate.

        Oracle: an authored testID node returns ready without alert diagnostics.
        Catches: weakening readiness to arbitrary shell text while adding alerts.
        """
        bridge = SequencedAlertRestartBridge([authored_content()])

        result = bridge.restart_app(clear_state=True, preflight=True)

        self.assertTrue(result.success, result.error)
        self.assertEqual(result.output, "ready")
        self.assertEqual(bridge.commands, [])
        self.assertEqual(bridge.last_restart_diagnostics, [])

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
