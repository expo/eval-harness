import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
APP_RUNTIME = ROOT / "eval_harness" / "utils" / "shell" / "app_runtime.sh"
IOS_RUNTIME = ROOT / "eval_harness" / "utils" / "shell" / "ios.sh"


def executable(path: Path, contents: str) -> None:
    path.write_text(textwrap.dedent(contents), encoding="utf-8")
    path.chmod(0o755)


class ReleaseIosBuildTests(unittest.TestCase):
    def run_release_build(
        self,
        *,
        help_text: str,
        minimum_ios: str | None = None,
        build_exit: int = 0,
        build_output_text: str = "",
    ) -> tuple[subprocess.CompletedProcess[str], Path, Path, Path]:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        app = root / "app"
        out = root / "out"
        bin_dir = root / "bin"
        app.mkdir()
        out.mkdir()
        bin_dir.mkdir()

        bun_args = root / "bun-args.txt"
        install_args = root / "install-args.txt"
        npx = bin_dir / "npx"
        executable(
            npx,
            f"""\
            #!/usr/bin/env bash
            printf '%s\n' {json.dumps(help_text)}
            """,
        )
        bun = bin_dir / "bun"
        executable(
            bun,
            f"""\
            #!/usr/bin/env bash
            set -eu
            printf '%s\n' "$@" > "$TEST_BUN_ARGS"
            output=""
            previous=""
            for argument in "$@"; do
              if [ "$previous" = "--output" ]; then output="$argument"; fi
              previous="$argument"
            done
            if [ -n "$output" ]; then
              mkdir -p "$output/Fixture.app"
              {f'''printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>MinimumOSVersion</key><string>{minimum_ios}</string></dict></plist>' > "$output/Fixture.app/Info.plist"''' if minimum_ios else ':'}
            fi
            printf '%s\n' {json.dumps(build_output_text)}
            exit {build_exit}
            """,
        )
        agent_device = bin_dir / "agent-device"
        executable(
            agent_device,
            """\
            #!/usr/bin/env bash
            set -eu
            printf '%s\n' "$@" > "$TEST_INSTALL_ARGS"
            """,
        )

        script = textwrap.dedent(
            f"""\
            set -uo pipefail
            source {APP_RUNTIME!s}
            eval::gate() {{ return "$1"; }}
            sleep() {{ :; }}
            export _EVAL_STAGES_DIR=/unused
            export EVAL_APP_BUNDLE_ID=com.example.fixture
            export EVAL_IOS_RUNTIME_VERSION=26.5
            export EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON='["26.5", "18.6"]'
            eval::build_release_ios_app {app!s} {out!s} ABCD-1234
            status=$?
            printf 'OUTCOME=%s|%s|%s|%s|%s|%s\n' "$status" \
              "${{EVAL_IOS_RELEASE_MODE:-}}" \
              "${{EVAL_IOS_NATIVE_BUILD_OUTCOME:-}}" \
              "${{EVAL_IOS_INSTALL_OUTCOME:-}}" \
              "${{EVAL_IOS_RESULT_STATUS:-}}" \
              "${{EVAL_IOS_REQUIRED_VERSION:-}}"
            exit 0
            """
        )
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        env["TEST_BUN_ARGS"] = str(bun_args)
        env["TEST_INSTALL_ARGS"] = str(install_args)
        result = subprocess.run(
            ["bash", "-c", script],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        return result, bun_args, install_args, out

    def test_release_build_uses_generic_output_when_project_cli_supports_it(self) -> None:
        """Removing capability detection must not send a modern CLI down the fallback path."""
        result, bun_args, install_args, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --output <dir>"
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OUTCOME=0|generic_output|passed|passed||", result.stdout)
        build_arguments = bun_args.read_text(encoding="utf-8").splitlines()
        self.assertIn("--device", build_arguments)
        self.assertEqual(build_arguments[build_arguments.index("--device") + 1], "generic")
        self.assertIn("--output", build_arguments)
        build_output = Path(build_arguments[build_arguments.index("--output") + 1])
        self.assertFalse(build_output.exists(), "temporary .app build output should be removed")

        install_arguments = install_args.read_text(encoding="utf-8").splitlines()
        self.assertEqual(install_arguments[0:2], ["install", "com.example.fixture"])
        self.assertEqual(Path(install_arguments[2]).name, "Fixture.app")
        self.assertEqual(
            install_arguments[3:],
            ["--platform", "ios", "--device", "ABCD-1234"],
        )

    def test_release_build_falls_back_to_booted_udid_when_output_is_unsupported(self) -> None:
        """Adding SDK-version assumptions must not break older project-local Expo CLIs."""
        result, bun_args, install_args, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --device <device>"
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OUTCOME=0|direct_install|passed|passed||", result.stdout)
        build_arguments = bun_args.read_text(encoding="utf-8").splitlines()
        self.assertNotIn("--output", build_arguments)
        self.assertEqual(
            build_arguments[build_arguments.index("--device") + 1],
            "ABCD-1234",
        )
        self.assertFalse(
            install_args.exists(),
            "the older Expo CLI owns install/launch in direct-install mode",
        )

    def test_newer_authored_deployment_target_is_unsupported_not_build_failure(self) -> None:
        """A successful compile for newer iOS must not be scored as an authored build defect."""
        result, _, install_args, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --output <dir>",
            minimum_ios="27.0",
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "OUTCOME=42|generic_output|passed|warning|unsupported_environment|27.0",
            result.stdout,
        )
        self.assertFalse(install_args.exists(), "an incompatible app must not be installed")
        self.assertIn("available iOS simulator runtimes: 26.5, 18.6", result.stdout)

    def test_old_cli_install_error_preserves_exact_required_and_available_versions(self) -> None:
        """A direct-install runtime failure must retain the authored target in diagnostics."""
        result, _, install_args, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --device <device>",
            build_exit=1,
            build_output_text=(
                "Installation failed: This app requires iOS 27.0 or later. "
                "Requires a newer version of iOS."
            ),
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "OUTCOME=42|direct_install|passed|warning|unsupported_environment|27.0",
            result.stdout,
        )
        self.assertFalse(install_args.exists())
        self.assertIn("available iOS simulator runtimes: 26.5, 18.6", result.stdout)

    def test_xcode_rejecting_future_deployment_target_is_environment_unsupported(self) -> None:
        """An installed Xcode SDK ceiling must not be reported as authored build quality."""
        result, _, install_args, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --output <dir>",
            build_exit=1,
            build_output_text=(
                "The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' "
                "is set to 27.0, but the range of supported deployment target "
                "versions is 12.0 to 26.5.99."
            ),
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "OUTCOME=42|generic_output|passed|warning|unsupported_environment|27.0",
            result.stdout,
        )
        self.assertFalse(install_args.exists())


class SimulatorSelectionTests(unittest.TestCase):
    def test_highest_available_ios_runtime_is_selected_by_udid_from_json(self) -> None:
        """Text-order changes or duplicate simulator names must not choose an older runtime."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            out = root / "out"
            bin_dir = root / "bin"
            out.mkdir()
            bin_dir.mkdir()
            simctl_args = root / "simctl-args.txt"
            devices = {
                "devices": {
                    "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
                        {
                            "name": "iPhone 16 Pro",
                            "udid": "OLD-UDID",
                            "isAvailable": True,
                            "state": "Shutdown",
                        }
                    ],
                    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                        {
                            "name": "iPhone 17 Pro",
                            "udid": "NEW-UDID",
                            "isAvailable": True,
                            "state": "Shutdown",
                        }
                    ],
                }
            }
            executable(
                bin_dir / "xcrun",
                f"""\
                #!/usr/bin/env bash
                set -eu
                if [ "$*" = "simctl list devices available --json" ]; then
                  printf '%s\n' {json.dumps(json.dumps(devices))}
                else
                  printf '%s\n' "$*" >> "$TEST_SIMCTL_ARGS"
                fi
                """,
            )
            executable(bin_dir / "bun", "#!/usr/bin/env bash\nexit 0\n")

            script = textwrap.dedent(
                f"""\
                set -uo pipefail
                source {IOS_RUNTIME!s}
                eval::gate() {{ return "$1"; }}
                sleep() {{ :; }}
                export _EVAL_STAGES_DIR=/unused
                eval::boot_sim_and_runner {out!s}
                printf 'DEVICE=%s|%s|%s|%s|%s\n' "$EVAL_DEVNAME" "$EVAL_DEV_UDID" \
                  "$EVAL_IOS_RUNTIME_VERSION" "$AGENT_DEVICE_IOS_DEVICE" \
                  "$EVAL_IOS_AVAILABLE_RUNTIME_VERSIONS_JSON"
                """
            )
            env = os.environ.copy()
            env["PATH"] = f"{bin_dir}:{env['PATH']}"
            env["TEST_SIMCTL_ARGS"] = str(simctl_args)
            result = subprocess.run(
                ["bash", "-c", script],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(
                'DEVICE=iPhone 17 Pro|NEW-UDID|26.5|NEW-UDID|["26.5", "18.6"]',
                result.stdout,
            )
            simctl_commands = simctl_args.read_text(encoding="utf-8").splitlines()
            self.assertIn("simctl boot NEW-UDID", simctl_commands)
            self.assertIn("simctl bootstatus NEW-UDID -b", simctl_commands)


if __name__ == "__main__":
    unittest.main()
