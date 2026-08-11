"""
Maestro CLI wrapper for the adaptive evaluator.

Wraps `maestro hierarchy` and `maestro test` commands, manages temp YAML files,
and handles platform-specific app restart.
"""

import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


PLATFORM_CONFIGS = {
    "ios": {
        "app_id": "host.exp.Exponent",
        "deep_link": "exp://localhost:8081",
    },
    "android": {
        "app_id": "host.exp.exponent",
        "deep_link": "exp://10.0.2.2:8081",
    },
}


@dataclass
class MaestroResult:
    success: bool
    output: str
    error: str = ""


class MaestroBridge:

    def __init__(
        self,
        platform: str = "ios",
        timeout: int = 60,
        verbose: bool = False,
        app_id: str | None = None,
        deep_link: str | None = None,
    ):
        self.platform = platform
        cfg = dict(PLATFORM_CONFIGS[platform])
        app_id = app_id or os.environ.get("EVAL_APP_BUNDLE_ID")
        deep_link = deep_link or os.environ.get("EVAL_APP_DEEP_LINK")
        if app_id:
            cfg["app_id"] = app_id
        if deep_link:
            cfg["deep_link"] = deep_link
        self.config = cfg
        self.simulator = os.environ.get("EVAL_DEV_UDID") or "booted"
        self.timeout = timeout
        self.verbose = verbose
        self.maestro_bin = self._find_maestro()
        self._env = self._build_env()
        self._tmp_dir = tempfile.mkdtemp(prefix="adaptive_eval_")
        self._cmd_counter = 0

    def _find_maestro(self) -> str:
        try:
            result = subprocess.run(
                ["which", "maestro"], capture_output=True, text=True, check=True
            )
            return result.stdout.strip()
        except subprocess.CalledProcessError:
            raise RuntimeError("Maestro CLI not found. Install with: brew install maestro")

    def _build_env(self) -> dict:
        # Respect a valid JAVA_HOME from the environment (portable: dev Mac AND CI
        # workers). Only fall back to discovery if it's unset/invalid. (Previously
        # hardcoded /opt/homebrew/opt/openjdk@21 — a local-only path that broke CI.)
        env = os.environ.copy()
        jh = env.get("JAVA_HOME", "")
        if not jh or not os.path.isdir(jh):
            try:
                jh = subprocess.run(
                    ["/usr/libexec/java_home"], capture_output=True, text=True
                ).stdout.strip()
            except Exception:
                jh = ""
        if jh and os.path.isdir(jh):
            env["JAVA_HOME"] = jh
            env["PATH"] = f"{jh}/bin:{env['PATH']}"
        return env

    def _next_yaml_path(self) -> Path:
        self._cmd_counter += 1
        return Path(self._tmp_dir) / f"cmd_{self._cmd_counter:04d}.yaml"

    def _build_yaml(self, commands_yaml: str) -> str:
        return f'appId: {self.config["app_id"]}\n---\n{commands_yaml}\n'

    def capture_hierarchy(self) -> str:
        """Run `maestro hierarchy` and return the raw JSON output."""
        try:
            result = subprocess.run(
                [self.maestro_bin, "hierarchy"],
                capture_output=True, text=True, timeout=30, env=self._env,
            )
            output = result.stdout
            # Strip the device info header line(s) before the JSON
            lines = output.strip().split("\n")
            json_start = None
            for i, line in enumerate(lines):
                if line.strip().startswith("{"):
                    json_start = i
                    break
            if json_start is not None:
                return "\n".join(lines[json_start:])
            return output
        except subprocess.TimeoutExpired:
            return '{"error": "hierarchy capture timed out"}'
        except Exception as e:
            return f'{{"error": "{e}"}}'

    def execute_yaml(self, commands_yaml: str, timeout_override=None) -> MaestroResult:
        """Write commands to a temp YAML file and run `maestro test`."""
        timeout = timeout_override or self.timeout
        yaml_path = self._next_yaml_path()
        full_yaml = self._build_yaml(commands_yaml)
        yaml_path.write_text(full_yaml)

        if self.verbose:
            print(f"  [maestro] Running {yaml_path.name}")

        try:
            result = subprocess.run(
                [self.maestro_bin, "test", str(yaml_path)],
                capture_output=True, text=True,
                timeout=timeout, env=self._env,
            )
            output = result.stdout + "\n" + result.stderr
            success = result.returncode == 0

            if self.verbose:
                status = "PASS" if success else "FAIL"
                print(f"  [maestro] {status}: {yaml_path.name}")

            return MaestroResult(success=success, output=output)

        except subprocess.TimeoutExpired:
            return MaestroResult(
                success=False, output="", error=f"Timed out after {timeout}s"
            )
        except Exception as e:
            return MaestroResult(success=False, output="", error=str(e))

    def restart_app(self, clear_state: bool = False) -> MaestroResult:
        """
        Restart the Notes app on the simulator.

        Strategy (iOS):
          1. Kill Expo Go directly via Apple's simctl — more reliable than
             Maestro's `stopApp`, works whether Expo Go is running or not.
          2. (optional) Wipe Expo Go's data container — Apple-blessed
             equivalent of Maestro's `clearState`.
          3. Open the deep link via simctl — Apple routes `exp://…` to Expo Go,
             which then loads our JS bundle from the dev server on :8081.
          4. Use ONE Maestro call to dismiss the Continue welcome dialog and
             the Reload dev tools bottom sheet (when each appears), and to
             wait for the app to fully render.

        Android falls back to the original Maestro-only flow.
        """
        if self.platform != "ios":
            return self._restart_app_android(clear_state)

        app_id = self.config["app_id"]
        deep_link = self.config["deep_link"]

        # 1. Kill Expo Go (Apple's API).
        subprocess.run(
            ["xcrun", "simctl", "terminate", self.simulator, app_id],
            capture_output=True, timeout=15,
        )

        # 2. Optionally wipe its data container.
        if clear_state:
            info = subprocess.run(
                [
                    "xcrun",
                    "simctl",
                    "get_app_container",
                    self.simulator,
                    app_id,
                    "data",
                ],
                capture_output=True, text=True, timeout=10,
            )
            if info.returncode == 0 and info.stdout.strip():
                import shutil
                data_path = info.stdout.strip()
                for sub in ("Documents", "Library", "tmp"):
                    shutil.rmtree(f"{data_path}/{sub}", ignore_errors=True)

        # 3. Open the deep link.
        subprocess.run(
            ["xcrun", "simctl", "openurl", self.simulator, deep_link],
            capture_output=True, timeout=15,
        )

        # 4. Maestro takes over: hardcoded dismissal of Expo's two overlays,
        #    then a long-timeout assertion that the app rendered.
        dismiss_parts = [
            # Welcome dialog (shows after a clean launch / clearState)
            '- runFlow:\n'
            '    when:\n'
            '      visible: "Continue"\n'
            '    commands:\n'
            '      - tapOn: "Continue"\n'
            '      - waitForAnimationToEnd\n',
            # Dev tools bottom sheet — first try
            '- runFlow:\n'
            '    when:\n'
            '      visible: "Reload"\n'
            '    commands:\n'
            '      - tapOn:\n'
            '          point: "50%,3%"\n'
            '      - waitForAnimationToEnd\n',
            # Dev tools bottom sheet — second try (sometimes reappears or appears late)
            '- runFlow:\n'
            '    when:\n'
            '      visible: "Reload"\n'
            '    commands:\n'
            '      - tapOn:\n'
            '          point: "50%,3%"\n'
            '      - waitForAnimationToEnd\n',
        ]
        # Note: we historically added an app-specific readiness check here
        # (`extendedWaitUntil` on a Notes testID), but that made the hybrid
        # restart Notes-only. Each dismissal block above includes its own
        # `waitForAnimationToEnd` which settles the simulator after the
        # overlay teardown; the caller's next `capture_screen` is the de
        # facto readiness check across all apps. If a specific app needs a
        # firmer ready signal, pass it in via a future `ready_testid` arg.
        return self.execute_yaml("".join(dismiss_parts), timeout_override=90)

    def _restart_app_android(self, clear_state: bool) -> MaestroResult:
        """Android path: keep the original Maestro-only flow (no simctl)."""
        clear = '- clearState\n' if clear_state else ''
        commands = (
            '- stopApp\n'
            f'{clear}'
            '- launchApp\n'
            f'- openLink: "{self.config["deep_link"]}"\n'
            '- waitForAnimationToEnd\n'
            '- runFlow:\n'
            '    when:\n'
            '      visible: "Continue"\n'
            '    commands:\n'
            '      - tapOn: "Continue"\n'
            '      - waitForAnimationToEnd\n'
            '- runFlow:\n'
            '    when:\n'
            '      visible: "Reload"\n'
            '    commands:\n'
            '      - tapOn:\n'
            '          point: "50%,3%"\n'
            '      - waitForAnimationToEnd\n'
            '- runFlow:\n'
            '    when:\n'
            '      visible: "Reload"\n'
            '    commands:\n'
            '      - tapOn:\n'
            '          point: "50%,3%"\n'
            '      - waitForAnimationToEnd\n'
        )
        return self.execute_yaml(commands, timeout_override=120)

    def cleanup(self):
        """Remove temp directory."""
        import shutil
        shutil.rmtree(self._tmp_dir, ignore_errors=True)
