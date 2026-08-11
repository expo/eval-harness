import copy
import json
import os
import subprocess
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
        return authored_content()


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


class BindingAwareRestartBridge(SequencedAlertRestartBridge):
    """Model a reusable agent-device session initially bound to another app."""

    def __init__(self, *, bind_success: bool = True) -> None:
        super().__init__([authored_content()])
        self.bound_app_id = "com.example.other"
        self.bind_success = bind_success
        self.events: list[tuple[str, object]] = []
        self.snapshot_count = 0

    def _run_cmd(
        self,
        args: list[str],
        timeout: int | None = None,
    ) -> AgentDeviceResult:
        self.commands.append(args)
        self.events.append(("command", args))
        if args == ["open", self.config["app_id"]]:
            if not self.bind_success:
                return AgentDeviceResult(
                    success=False,
                    output="",
                    error="fixture bind rejected",
                )
            self.bound_app_id = args[1]
        return AgentDeviceResult(success=True, output="ok")

    def _snapshot_raw(self) -> list[dict]:
        self.snapshot_count += 1
        self.events.append(("snapshot", self.bound_app_id))
        nodes = authored_content()
        if self.bound_app_id != self.config["app_id"]:
            nodes[0]["label"] = "Other App"
            nodes[2]["label"] = "Other account"
            nodes[3]["label"] = "Continue"
        return nodes


def permission_alert(title: str, deny: str, allow: str) -> list[dict]:
    nodes = raw_snapshot_with_content("Alert", title, positive_rect=True)
    nodes.append(
        {
            **copy.deepcopy(nodes[2]),
            "index": 3,
            "type": "Button",
            "label": deny,
            "hittable": True,
        }
    )
    nodes.append(
        {
            **copy.deepcopy(nodes[2]),
            "index": 4,
            "type": "Button",
            "label": allow,
            "hittable": True,
        }
    )
    return nodes


AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT = [
    {
        "index": 0,
        "type": "Application",
        "label": "Notes",
        "identifier": None,
        "value": None,
        "rect": {"x": 0, "y": 0, "width": 402, "height": 874},
        "enabled": True,
        "focused": False,
        "selected": False,
        "hittable": True,
        "depth": 0,
        "parentIndex": None,
    },
    {
        "index": 1,
        "type": "Window",
        "label": None,
        "identifier": None,
        "value": None,
        "rect": {"x": 0, "y": 0, "width": 402, "height": 874},
        "enabled": True,
        "focused": False,
        "selected": False,
        "hittable": False,
        "depth": 1,
        "parentIndex": 0,
    },
    {
        "index": 2,
        "type": "StaticText",
        "label": "Notes",
        "identifier": None,
        "value": None,
        "rect": {"x": 24, "y": 72, "width": 130, "height": 34},
        "enabled": True,
        "focused": False,
        "selected": False,
        "hittable": False,
        "depth": 2,
        "parentIndex": 1,
    },
    {
        "index": 3,
        "type": "Button",
        "label": "New note",
        "identifier": None,
        "value": None,
        "rect": {"x": 24, "y": 124, "width": 354, "height": 48},
        "enabled": True,
        "focused": False,
        "selected": False,
        "hittable": True,
        "depth": 2,
        "parentIndex": 1,
    },
]


def authored_content() -> list[dict]:
    nodes = copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT)
    nodes[3]["identifier"] = "authored-app-ready"
    return nodes


def authored_content_without_identifiers() -> list[dict]:
    """Raw iOS 0.17.6 tree for an accessible app that defines no testIDs."""
    return copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT)


def raw_snapshot_with_content(
    type_: str,
    label: str | None,
    *,
    identifier: str | None = None,
    hittable: bool = False,
    positive_rect: bool = True,
) -> list[dict]:
    """Build a minimal tree using only the pinned iOS SnapshotNode fields."""
    nodes = copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT[:2])
    nodes.append(
        {
            "index": 2,
            "type": type_,
            "label": label,
            "identifier": identifier,
            "value": None,
            "rect": {
                "x": 24,
                "y": 72,
                "width": 120 if positive_rect else 0,
                "height": 44 if positive_rect else 0,
            },
            "enabled": True,
            "focused": False,
            "selected": False,
            "hittable": hittable,
            "depth": 2,
            "parentIndex": 1,
        }
    )
    return nodes


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


class AgentDeviceBridgeSimulatorRoutingTests(unittest.TestCase):
    @patch.dict(os.environ, {"EVAL_DEV_UDID": "SELECTED-UDID"})
    def test_agent_device_commands_target_selected_simulator_udid(self) -> None:
        """UI commands cannot attach to a lower runtime that is also booted."""
        commands: list[list[str]] = []

        def run(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, stdout="ready", stderr="")

        with patch(
            "eval_harness.evaluator.ios_agentic.agent_device.bridge.subprocess.run",
            side_effect=run,
        ):
            result = AgentDeviceBridge()._run_cmd(["open", "com.example.authored"])

        self.assertTrue(result.success, result.error)
        self.assertEqual(
            commands,
            [[
                "agent-device",
                "open",
                "com.example.authored",
                "--session",
                "adaptive",
                "--platform",
                "ios",
                "--udid",
                "SELECTED-UDID",
            ]],
        )

    @patch.dict(os.environ, {"EVAL_DEV_UDID": ""})
    def test_agent_device_commands_preserve_legacy_device_autodiscovery(self) -> None:
        """Standalone bridge use keeps its historical no-UDID fallback."""
        commands: list[list[str]] = []

        def run(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, stdout="ready", stderr="")

        with patch(
            "eval_harness.evaluator.ios_agentic.agent_device.bridge.subprocess.run",
            side_effect=run,
        ):
            result = AgentDeviceBridge()._run_cmd(["snapshot", "-i"])

        self.assertTrue(result.success, result.error)
        self.assertEqual(
            commands,
            [[
                "agent-device",
                "snapshot",
                "-i",
                "--session",
                "adaptive",
                "--platform",
                "ios",
            ]],
        )


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
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_preflight_binds_exact_app_before_first_snapshot_in_both_paths(
        self,
        _sleep,
    ) -> None:
        """A stale reusable session cannot make another app look ready."""
        for mode in ("native", "hybrid"):
            with self.subTest(mode=mode):
                bridge = BindingAwareRestartBridge()
                if mode == "hybrid":
                    bridge._maestro = RecordingMaestroRestart()
                    result = bridge.restart_app_hybrid(preflight=True)
                else:
                    result = bridge.restart_app(preflight=True)

                self.assertTrue(result.success, result.error)
                self.assertEqual(bridge.bound_app_id, "com.example.authored")
                self.assertEqual(
                    bridge.events[:2],
                    [
                        ("command", ["open", "com.example.authored"]),
                        ("snapshot", "com.example.authored"),
                    ],
                )

    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_preflight_bind_failure_aborts_before_snapshot_in_both_paths(
        self,
        _sleep,
    ) -> None:
        """A failed exact-app bind is one immediate infrastructure diagnostic."""
        for mode in ("native", "hybrid"):
            with self.subTest(mode=mode):
                bridge = BindingAwareRestartBridge(bind_success=False)
                if mode == "hybrid":
                    bridge._maestro = RecordingMaestroRestart()
                    result = bridge.restart_app_hybrid(preflight=True)
                else:
                    result = bridge.restart_app(preflight=True)

                self.assertFalse(result.success)
                self.assertEqual(
                    result.error,
                    "restart_app: failed to bind agent-device session to "
                    '"com.example.authored" before preflight readiness: '
                    "fixture bind rejected",
                )
                self.assertEqual(bridge.snapshot_count, 0)
                self.assertEqual(
                    bridge.commands,
                    [["open", "com.example.authored"]],
                )

    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_formal_restarts_do_not_add_an_automatic_session_bind(self, _sleep) -> None:
        """Once the model is active, lifecycle keeps existing focus semantics."""
        native = SequencedAlertRestartBridge([authored_content()])
        native_result = native.restart_app(preflight=False)
        hybrid = SequencedAlertRestartBridge([authored_content()])
        hybrid._maestro = RecordingMaestroRestart()
        hybrid_result = hybrid.restart_app_hybrid(preflight=False)

        self.assertTrue(native_result.success, native_result.error)
        self.assertTrue(hybrid_result.success, hybrid_result.error)
        self.assertEqual(native.commands, [])
        self.assertEqual(hybrid.commands, [])

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
                safe_deny = deny.replace('"', '\\"')
                self.assertEqual(
                    bridge.commands,
                    [
                        ["open", "com.example.authored"],
                        ["press", f'label="{safe_deny}"'],
                    ],
                )
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
        self.assertEqual(bridge.commands, [["open", "com.example.authored"]])

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
        self.assertEqual(
            bridge.commands,
            [
                ["open", "com.example.authored"],
                ["press", 'label="Continue"'],
            ],
        )

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
        self.assertEqual(bridge.commands, [["open", "com.example.authored"]])
        self.assertEqual(bridge.last_restart_diagnostics, [])

    @patch.dict(os.environ, {"EVAL_APP_READY_TIMEOUT_SEC": "0.02"})
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_preflight_accepts_labelled_authored_ui_without_identifiers(
        self,
        _sleep,
    ) -> None:
        """Accessible authored content must not depend on optional React Native testIDs.

        Catches: requiring a nonempty accessibilityIdentifier even when the raw
        tree identifies the expected app process and exposes useful labelled UI.
        """
        bridge = SequencedAlertRestartBridge(
            [authored_content_without_identifiers()]
        )

        result = bridge.restart_app(clear_state=True, preflight=True)

        self.assertTrue(result.success, result.error)
        self.assertEqual(result.output, "ready")
        self.assertEqual(bridge.commands, [["open", "com.example.authored"]])

    def test_readiness_rejects_non_authored_and_generic_shell_trees(self) -> None:
        """Arbitrary shell accessibility text is not app-owned readiness.

        Catches: replacing the testID gate with any-labelled-node and thereby
        accepting the runner, Expo launcher, alert, error, or a bare root view.
        """
        bridge = AgentDeviceBridge(app_id="com.example.authored")
        runner = raw_snapshot_with_content(
            "StaticText", "Runner Ready", identifier="runner-ready"
        )
        runner[0]["label"] = "AgentDeviceRunner"
        launcher = raw_snapshot_with_content(
            "StaticText", "Development servers", identifier="launcher-title"
        )
        launcher.append(
            {
                **copy.deepcopy(launcher[2]),
                "index": 3,
                "type": "Button",
                "label": "Enter URL manually",
                "identifier": "launcher-enter-url",
                "hittable": True,
            }
        )
        system_alert = raw_snapshot_with_content(
            "Button", "Allow", identifier="permission-allow", hittable=True
        )
        system_alert.insert(
            2,
            {
                **copy.deepcopy(system_alert[2]),
                "index": 3,
                "type": "Alert",
                "label": "System Alert",
                "identifier": None,
                "hittable": False,
            },
        )
        cases = {
            "agent-device runner": runner,
            "Expo dev-client launcher": launcher,
            "system alert": system_alert,
            "known error shell": raw_snapshot_with_content(
                "StaticText",
                "Unable to resolve module ./missing",
                identifier="error-message",
            ),
            "bare generic root": raw_snapshot_with_content(
                "Other", "Content View", identifier="root"
            ),
        }

        for name, nodes in cases.items():
            with self.subTest(name=name):
                self.assertFalse(bridge._has_target_app_content(nodes))

    def test_readiness_rejects_malformed_or_nonrendered_raw_ios_trees(self) -> None:
        """Readiness requires supported structure plus positive UI evidence."""
        bridge = AgentDeviceBridge(app_id="com.example.authored")
        missing_application = raw_snapshot_with_content("Button", "Ready", hittable=True)[1:]
        malformed_application = raw_snapshot_with_content("Button", "Ready", hittable=True)
        malformed_application[0]["index"] = 4
        malformed_application[0]["depth"] = 1
        malformed_application[0]["parentIndex"] = 99
        disconnected_content = raw_snapshot_with_content("Button", "Ready", hittable=True)
        disconnected_content[2]["parentIndex"] = 99
        duplicate_index = authored_content_without_identifiers()
        duplicate_index.append(copy.deepcopy(duplicate_index[3]))
        negative_index = authored_content_without_identifiers()
        negative_index[2]["index"] = -1
        boolean_index = authored_content_without_identifiers()
        boolean_index[2]["index"] = True
        string_index = authored_content_without_identifiers()
        string_index[2]["index"] = "2"
        equal_parent_depth = authored_content_without_identifiers()
        equal_parent_depth[2]["depth"] = 1
        decreasing_parent_depth = authored_content_without_identifiers()
        decreasing_parent_depth[2]["depth"] = 0
        forward_parent = authored_content_without_identifiers()
        forward_parent[2]["parentIndex"] = 3
        negative_depth = authored_content_without_identifiers()
        negative_depth[2]["depth"] = -1
        boolean_parent = authored_content_without_identifiers()
        boolean_parent[2]["parentIndex"] = True
        cyclic_parents = authored_content_without_identifiers()
        cyclic_parents[2]["parentIndex"] = 3
        cyclic_parents[3]["parentIndex"] = 2
        cases = {
            "missing Application root": missing_application,
            "malformed Application root": malformed_application,
            "content disconnected from root": disconnected_content,
            "duplicate index": duplicate_index,
            "negative index": negative_index,
            "boolean index": boolean_index,
            "string index": string_index,
            "equal parent/child depth": equal_parent_depth,
            "decreasing child depth": decreasing_parent_depth,
            "forward parent index": forward_parent,
            "negative depth": negative_depth,
            "boolean parent index": boolean_parent,
            "cyclic parent chain": cyclic_parents,
            "zero-size non-hittable content": raw_snapshot_with_content(
                "Button", "Ready", positive_rect=False
            ),
            "content without meaningful signal": raw_snapshot_with_content(
                "Button", None, positive_rect=True
            ),
        }

        for name, nodes in cases.items():
            with self.subTest(name=name):
                self.assertFalse(bridge._has_target_app_content(nodes))

    def test_readiness_reports_every_structural_rejection_reason(self) -> None:
        """Each raw-tree invariant identifies the exact failed shape.

        Catches: collapsing a live schema mismatch back into an opaque timeout.
        """
        bridge = AgentDeviceBridge(app_id="com.example.authored")
        non_object_node = authored_content_without_identifiers()
        non_object_node.append("secret-node-text")
        invalid_index = authored_content_without_identifiers()
        invalid_index[2]["index"] = True
        duplicate_index = authored_content_without_identifiers()
        duplicate_index.append(copy.deepcopy(duplicate_index[3]))
        invalid_depth = authored_content_without_identifiers()
        invalid_depth[2]["depth"] = -1
        invalid_root = authored_content_without_identifiers()
        invalid_root[0]["index"] = 4
        invalid_parent = authored_content_without_identifiers()
        invalid_parent[2]["parentIndex"] = True
        missing_parent = authored_content_without_identifiers()
        missing_parent[2]["parentIndex"] = 99
        parent_cycle = authored_content_without_identifiers()
        parent_cycle[2]["parentIndex"] = 3
        parent_cycle[3]["parentIndex"] = 2
        equal_parent_depth = authored_content_without_identifiers()
        equal_parent_depth[2]["depth"] = 1
        decreasing_parent_depth = authored_content_without_identifiers()
        decreasing_parent_depth[2]["depth"] = 0
        forward_parent = authored_content_without_identifiers()
        forward_parent[2]["parentIndex"] = 3
        cases = {
            "empty snapshot": ([], "snapshot_empty"),
            "non-object node": (non_object_node, "snapshot_node_not_object"),
            "invalid node index": (invalid_index, "node_index_invalid"),
            "duplicate node index": (duplicate_index, "node_index_duplicate"),
            "invalid node depth": (invalid_depth, "node_depth_invalid"),
            "invalid Application root": (invalid_root, "application_root_invalid"),
            "invalid parent index": (invalid_parent, "node_parent_index_invalid"),
            "missing parent": (missing_parent, "node_parent_missing"),
            "parent cycle": (parent_cycle, "node_parent_cycle"),
            "equal parent/child depth": (
                equal_parent_depth,
                "node_depth_not_increasing",
            ),
            "decreasing child depth": (
                decreasing_parent_depth,
                "node_depth_not_increasing",
            ),
            "forward parent index": (
                forward_parent,
                "node_parent_not_preceding_child",
            ),
        }
        rejection = getattr(bridge, "_target_app_content_rejection", lambda _nodes: None)

        for name, (nodes, expected) in cases.items():
            with self.subTest(name=name):
                self.assertEqual(rejection(nodes), expected)
                self.assertFalse(bridge._has_target_app_content(nodes))

    def test_readiness_accepts_filtered_ios_tree_with_original_depth_gaps(self) -> None:
        """Pinned `-i --raw` reparents included nodes but preserves AX depth.

        Catches: requiring direct-child depth equality and timing out on rich
        authored screens whose filtered tree skips intermediary nodes.
        """
        nodes = copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT[:2])
        nodes.extend([
            {
                **copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT[2]),
                "index": 2,
                "type": "Other",
                "label": "Notes",
                "depth": 4,
                "parentIndex": 1,
            },
            {
                **copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT[3]),
                "index": 3,
                "label": "New note",
                "depth": 7,
                "parentIndex": 2,
            },
            {
                **copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT[2]),
                "index": 4,
                "type": "Keyboard",
                "label": None,
                "depth": 3,
                "parentIndex": 1,
            },
            {
                **copy.deepcopy(AGENT_DEVICE_0176_NO_TEST_ID_SNAPSHOT[3]),
                "index": 5,
                "type": "Key",
                "label": "return",
                "depth": 8,
                "parentIndex": 4,
            },
        ])
        bridge = AgentDeviceBridge(app_id="com.example.authored")

        self.assertTrue(bridge._has_valid_ios_snapshot_tree(nodes))
        self.assertTrue(bridge._has_target_app_content(nodes))

    def test_readiness_reports_non_app_shell_and_content_rejection_reasons(self) -> None:
        """Valid trees distinguish shell ownership from absent UI evidence."""
        bridge = AgentDeviceBridge(app_id="com.example.authored")
        runner = raw_snapshot_with_content("StaticText", "Runner Ready")
        runner[0]["label"] = "AgentDeviceRunner"
        alert = raw_snapshot_with_content("Button", "Allow", hittable=True)
        alert[2]["type"] = "Alert"
        continue_shell = raw_snapshot_with_content("Button", "Continue", hittable=True)
        continue_shell[0]["label"] = "Expo Go"
        reconnect_shell = raw_snapshot_with_content("StaticText", "Unable to connect")
        reconnect_shell.append({
            **copy.deepcopy(reconnect_shell[2]),
            "index": 3,
            "type": "Button",
            "label": "OK",
            "hittable": True,
        })
        cases = {
            "runner": (runner, "agent_device_runner"),
            "system alert": (alert, "system_alert_visible"),
            "app shell error": (
                raw_snapshot_with_content("StaticText", "Unable to resolve module ./secret"),
                "app_shell_error",
            ),
            "bundle loading": (
                raw_snapshot_with_content("StaticText", "Bundling 50%"),
                "expo_bundle_loading_shell",
            ),
            "Open in dialog": (
                raw_snapshot_with_content("Button", "Open in Notes Open", hittable=True),
                "expo_open_dialog_shell",
            ),
            "Continue shell": (continue_shell, "expo_continue_shell"),
            "dev tools": (
                raw_snapshot_with_content("Button", "Open DevTools", hittable=True),
                "expo_dev_tools_shell",
            ),
            "reconnect shell": (reconnect_shell, "expo_reconnect_shell"),
            "launcher": (
                raw_snapshot_with_content("StaticText", "Development servers"),
                "expo_launcher_shell",
            ),
            "bottom sheet": (
                raw_snapshot_with_content("Other", "Bottom Sheet"),
                "expo_bottom_sheet_shell",
            ),
            "unsupported content type": (
                raw_snapshot_with_content("Window", "Ready"),
                "no_supported_content_nodes",
            ),
            "not rendered or hittable": (
                raw_snapshot_with_content("Button", "Ready", positive_rect=False),
                "content_not_rendered_or_hittable",
            ),
            "missing meaningful signal": (
                raw_snapshot_with_content("Other", "Content View"),
                "content_signal_missing_or_generic",
            ),
        }
        rejection = getattr(bridge, "_target_app_content_rejection", lambda _nodes: None)

        for name, (nodes, expected) in cases.items():
            with self.subTest(name=name):
                self.assertEqual(rejection(nodes), expected)
                self.assertFalse(bridge._has_target_app_content(nodes))

    def test_readiness_schema_summary_is_bounded_and_contains_no_app_text(self) -> None:
        """Diagnostics expose field shape without labels, identifiers, refs, or values."""
        bridge = AgentDeviceBridge(app_id="com.example.authored")
        nodes = authored_content_without_identifiers()
        for index in range(4, 12):
            nodes.append({
                **copy.deepcopy(nodes[2]),
                "index": index,
                "label": f"secret-label-{index}",
                "value": f"secret-value-{index}",
                "identifier": f"secret-id-{index}",
                "ref": f"secret-ref-{index}",
        })
        nodes[2].update({
            "type": "SecretTypeValue",
            "label": "secret-label-2",
            "value": "secret-value-2",
            "identifier": "secret-id-2",
            "ref": "secret-ref-2",
            "rect": {"width": "secret-width", "height": 44},
            "hittable": "secret-hittable",
        })
        summarize = getattr(bridge, "_snapshot_schema_summary", lambda _nodes: None)

        summary = summarize(nodes)

        self.assertIsInstance(summary, dict)
        self.assertEqual(summary["node_count"], 12)
        self.assertTrue(summary["nodes_truncated"])
        self.assertEqual(len(summary["nodes"]), 8)
        self.assertEqual(
            summary["nodes"][0],
            {
                "node_is_object": True,
                "type": "Application",
                "index": 0,
                "depth": 0,
                "parentIndex": None,
                "rect_present": True,
                "rect_is_object": True,
                "rect_width_is_number": True,
                "rect_height_is_number": True,
                "rect_positive_size": True,
                "hittable_present": True,
                "hittable_is_boolean": True,
                "hittable_true": True,
            },
        )
        serialized = json.dumps(summary, sort_keys=True)
        self.assertLess(len(serialized), 5_000)
        for secret in (
            "SecretTypeValue",
            "secret-label",
            "secret-value",
            "secret-id",
            "secret-ref",
            "secret-width",
            "secret-hittable",
        ):
            self.assertNotIn(secret, serialized)
        for forbidden_field in ('"label"', '"value"', '"identifier"', '"ref"'):
            self.assertNotIn(forbidden_field, serialized)

    @patch.dict(os.environ, {"EVAL_APP_READY_TIMEOUT_SEC": "0.5"})
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_readiness_timeout_includes_final_safe_reason_and_schema_summary(
        self,
        _sleep,
    ) -> None:
        """The final evaluator error explains rejection without app-owned strings."""
        nodes = raw_snapshot_with_content("Other", "Content View")
        nodes[0].update({
            "label": "secret-app-label",
            "value": "secret-note-body",
            "identifier": "secret-note-id",
        })
        nodes[2].update({
            "ref": "secret-note-ref",
        })
        bridge = SequencedAlertRestartBridge([nodes])

        with patch(
            "eval_harness.evaluator.ios_agentic.agent_device.bridge.time.time",
            side_effect=[10.0, 10.0, 11.0],
        ):
            result = bridge._wait_for_target_app_content(
                is_dev_client=False,
                deep_link="example://ready",
                preflight=True,
            )

        self.assertFalse(result.success)
        self.assertIn(
            "final_readiness_rejection=content_signal_missing_or_generic",
            result.error,
        )
        self.assertIn("snapshot_schema=", result.error)
        summary = json.loads(result.error.split("snapshot_schema=", 1)[1])
        self.assertEqual(summary["node_count"], 3)
        self.assertEqual(len(summary["nodes"]), 3)
        self.assertNotIn("secret-app-label", result.error)
        self.assertNotIn("secret-note-body", result.error)
        self.assertNotIn("secret-note-id", result.error)
        self.assertNotIn("secret-note-ref", result.error)

    def test_readiness_accepts_nonhittable_label_with_positive_rect(self) -> None:
        """Rendered text is positive UI evidence even when it is not interactive."""
        bridge = AgentDeviceBridge(app_id="com.example.authored")
        nodes = raw_snapshot_with_content("StaticText", "No notes yet")

        self.assertTrue(bridge._has_target_app_content(nodes))

    @patch.dict(os.environ, {"EVAL_APP_READY_TIMEOUT_SEC": "0.02"})
    @patch("eval_harness.evaluator.ios_agentic.agent_device.bridge.time.sleep")
    def test_readiness_does_not_reject_authored_copy_by_keyword_alone(
        self,
        _sleep,
    ) -> None:
        """A shell keyword is not a shell without its established structure.

        Catches: rejecting an authored offline screen merely because its copy
        overlaps one phrase used by Expo's reconnect dialog.
        """
        nodes = authored_content_without_identifiers()
        nodes[2]["label"] = "Unable to connect to your notes"
        nodes[3]["label"] = "Retry sync"
        bridge = SequencedAlertRestartBridge([nodes])

        result = bridge.restart_app(clear_state=True, preflight=True)

        self.assertTrue(result.success, result.error)
        self.assertEqual(result.output, "ready")

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
