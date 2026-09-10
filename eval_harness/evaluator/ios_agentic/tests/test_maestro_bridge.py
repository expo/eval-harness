import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from eval_harness.evaluator.ios_agentic.maestro.bridge import (
    MaestroBridge,
    MaestroResult,
)


class RecordingMaestroBridge(MaestroBridge):
    def _find_maestro(self) -> str:
        return "maestro"

    def _build_env(self) -> dict:
        return {}

    def execute_yaml(
        self,
        commands_yaml: str,
        timeout_override=None,
    ) -> MaestroResult:
        return MaestroResult(success=True, output="ready")


class CommandMaestroBridge(MaestroBridge):
    def _find_maestro(self) -> str:
        return "maestro"

    def _build_env(self) -> dict:
        return {}


class MaestroBridgeSimulatorRoutingTests(unittest.TestCase):
    @patch.dict(os.environ, {"EVAL_DEV_UDID": "SELECTED-UDID"})
    def test_maestro_commands_target_selected_simulator_udid(self) -> None:
        """Maestro's UI driver must use the same selected simulator as simctl.

        Catches: routing only the native launch to the selected UDID while
        hierarchy/test silently attach to another booted simulator.
        """
        commands: list[list[str]] = []

        def run(command, **kwargs):
            commands.append(command)
            output = '{"root": {}}' if "hierarchy" in command else "ready"
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

        with patch(
            "eval_harness.evaluator.ios_agentic.maestro.bridge.subprocess.run",
            side_effect=run,
        ):
            bridge = CommandMaestroBridge()
            self.addCleanup(bridge.cleanup)
            bridge.capture_hierarchy()
            result = bridge.execute_yaml("- assertVisible: Ready")

        self.assertTrue(result.success, result.error)
        self.assertEqual(
            commands[0],
            ["maestro", "--udid=SELECTED-UDID", "hierarchy"],
        )
        self.assertEqual(
            commands[1][:3],
            ["maestro", "--udid=SELECTED-UDID", "test"],
        )

    @patch.dict(os.environ, {"EVAL_DEV_UDID": ""})
    def test_maestro_commands_preserve_legacy_device_autodiscovery(self) -> None:
        """Standalone Maestro use keeps its historical no-UDID fallback."""
        commands: list[list[str]] = []

        def run(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(
                command,
                0,
                stdout='{"root": {}}',
                stderr="",
            )

        with patch(
            "eval_harness.evaluator.ios_agentic.maestro.bridge.subprocess.run",
            side_effect=run,
        ):
            bridge = CommandMaestroBridge()
            self.addCleanup(bridge.cleanup)
            bridge.capture_hierarchy()

        self.assertEqual(commands, [["maestro", "hierarchy"]])

    @patch.dict(os.environ, {"EVAL_DEV_UDID": "SELECTED-UDID"})
    def test_restart_lifecycle_targets_selected_simulator_udid(self) -> None:
        """Hybrid lifecycle operations cannot drift across booted runtimes.

        Catches: terminate, container clearing, or openurl using the ambiguous
        `booted` alias after ios.sh selected a specific simulator UDID.
        """
        with tempfile.TemporaryDirectory() as td:
            container = Path(td) / "container"
            for child in ("Documents", "Library", "tmp"):
                (container / child).mkdir(parents=True)
            commands: list[list[str]] = []

            def run(command, **kwargs):
                commands.append(command)
                output = f"{container}\n" if "get_app_container" in command else ""
                return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

            with patch(
                "eval_harness.evaluator.ios_agentic.maestro.bridge.subprocess.run",
                side_effect=run,
            ):
                bridge = RecordingMaestroBridge(
                    app_id="com.example.authored",
                    deep_link="example://ready",
                )
                self.addCleanup(bridge.cleanup)
                result = bridge.restart_app(clear_state=True)

            self.assertTrue(result.success, result.error)
            self.assertEqual(
                commands,
                [
                    [
                        "xcrun",
                        "simctl",
                        "terminate",
                        "SELECTED-UDID",
                        "com.example.authored",
                    ],
                    [
                        "xcrun",
                        "simctl",
                        "get_app_container",
                        "SELECTED-UDID",
                        "com.example.authored",
                        "data",
                    ],
                    [
                        "xcrun",
                        "simctl",
                        "openurl",
                        "SELECTED-UDID",
                        "example://ready",
                    ],
                ],
            )


if __name__ == "__main__":
    unittest.main()
