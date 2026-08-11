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
        direct_app: bool = False,
        stale_direct_minimum_ios: str | None = None,
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
        if stale_direct_minimum_ios is not None:
            stale_app = (
                app
                / "ios/build/Build/Products/Release-iphonesimulator/Stale.app"
            )
            stale_app.mkdir(parents=True)
            (stale_app / "Info.plist").write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                "<plist version=\"1.0\"><dict><key>MinimumOSVersion</key>"
                f"<string>{stale_direct_minimum_ios}</string></dict></plist>",
                encoding="utf-8",
            )

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
            {f'''mkdir -p {app!s}/ios/build/Build/Products/Release-iphonesimulator/Fixture.app
            printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.fixture</string></dict></plist>' > {app!s}/ios/build/Build/Products/Release-iphonesimulator/Fixture.app/Info.plist''' if direct_app else ':'}
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

    def test_low_deployment_target_warning_does_not_mask_compile_failure(self) -> None:
        """An old minimum-target warning is not a newer-runtime incompatibility.

        Catches: scanning an unrelated compile failure log for the generic
        supported-target-range phrase and falsely declaring the environment
        unsupported with iOS 9.0 as the required newer version.
        """
        result, _, _, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --output <dir>",
            build_exit=17,
            build_output_text=(
                "CompileSwift failed for authored source.\n"
                "The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' "
                "is set to 9.0, but the range of supported deployment target "
                "versions is 12.0 to 26.5.99."
            ),
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OUTCOME=17|generic_output|failed|not_run||", result.stdout)
        self.assertNotIn("unsupported_environment", result.stdout)

    def test_future_target_warning_does_not_mask_authored_build_failure(self) -> None:
        """A coincident high-target warning cannot erase an authored failure.

        Catches: treating any parseable future deployment warning as exclusive
        proof of environment incompatibility when native or Metro work fails.
        """
        failures = [
            "CompileSwift failed for authored source.",
            "CommandError: Unable to resolve module ./missing from App.tsx",
        ]
        cases = [
            ("Usage: expo run:ios [options]\n  --output <dir>", "generic_output"),
            ("Usage: expo run:ios [options]\n  --device <device>", "direct_install"),
        ]

        for authored_failure in failures:
            output = (
                f"{authored_failure}\n"
                "The iOS Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' "
                "is set to 27.0, but the range of supported deployment target "
                "versions is 12.0 to 26.5.99."
            )
            for help_text, mode in cases:
                with self.subTest(mode=mode, failure=authored_failure):
                    result, _, _, _ = self.run_release_build(
                        help_text=help_text,
                        build_exit=17,
                        build_output_text=output,
                    )

                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn(f"OUTCOME=17|{mode}|failed|not_run||", result.stdout)
                    self.assertNotIn("unsupported_environment", result.stdout)

    def test_old_cli_built_app_install_failure_preserves_native_build_success(self) -> None:
        """SDK 53/54 can fail after producing the simulator app.

        Catches: collapsing Expo's post-build install/launch failure into a
        native compilation failure even though the physical .app proves the
        build completed.
        """
        result, _, _, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --device <device>",
            build_exit=19,
            build_output_text=(
                "** BUILD SUCCEEDED **\n"
                "Installation failed: simulator service unavailable"
            ),
            direct_app=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OUTCOME=19|direct_install|passed|failed||", result.stdout)

    def test_old_cli_stale_app_does_not_mask_compile_failure(self) -> None:
        """A partial product from a failed invocation is not proof of a good build."""
        result, _, _, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --device <device>",
            build_exit=17,
            build_output_text="CompileSwift failed for authored source",
            direct_app=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OUTCOME=17|direct_install|failed|not_run||", result.stdout)

    def test_old_cli_stale_future_target_app_does_not_claim_unsupported(self) -> None:
        """A stale product cannot turn a source failure into an environment N/A.

        Catches: inspecting a persistent pre-invocation `.app` target before
        proving that the current Expo invocation successfully built it.
        """
        result, _, _, _ = self.run_release_build(
            help_text="Usage: expo run:ios [options]\n  --device <device>",
            build_exit=17,
            build_output_text="CompileSwift failed for authored source",
            stale_direct_minimum_ios="27.0",
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OUTCOME=17|direct_install|failed|not_run||", result.stdout)
        self.assertNotIn("unsupported_environment", result.stdout)


class ProbeSnapshotSimulatorRoutingTests(unittest.TestCase):
    def run_probe(self, *, release_launch: bool) -> tuple[subprocess.CompletedProcess[str], list[str]]:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        out = root / "out"
        bin_dir = root / "bin"
        out.mkdir()
        bin_dir.mkdir()
        simctl_args = root / "simctl-args.txt"
        snapshot_count = root / "snapshot-count.txt"
        executable(
            bin_dir / "xcrun",
            """\
            #!/usr/bin/env bash
            printf '%s\n' "$*" >> "$TEST_SIMCTL_ARGS"
            """,
        )
        executable(
            bin_dir / "agent-device",
            """\
            #!/usr/bin/env bash
            if [ "$1" = "alert" ]; then exit 1; fi
            if [ "$1" = "snapshot" ]; then
              count=0
              [ ! -f "$TEST_SNAPSHOT_COUNT" ] || count="$(cat "$TEST_SNAPSHOT_COUNT")"
              count=$((count + 1))
              printf '%s' "$count" > "$TEST_SNAPSHOT_COUNT"
              if [ "${TEST_LAUNCHER_FIRST:-0}" = "1" ] && [ "$count" = "1" ]; then
                printf '%s\n' 'Development servers' 'Recently opened'
              else
                printf '%s\n' 'button id="authored-ready" "Ready"'
              fi
            fi
            exit 0
            """,
        )
        mode = (
            "export EVAL_APP_USE_SIMCTL_LAUNCH=1; unset EVAL_APP_DEEP_LINK"
            if release_launch
            else "unset EVAL_APP_USE_SIMCTL_LAUNCH; export EVAL_APP_DEEP_LINK=example://ready"
        )
        script = textwrap.dedent(
            f"""\
            set -uo pipefail
            source {APP_RUNTIME!s}
            eval::gate() {{ return "$1"; }}
            sleep() {{ :; }}
            export EVAL_DEV_UDID=SELECTED-UDID
            {mode}
            eval::probe_snapshot {out!s} com.example.authored
            """
        )
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        env["TEST_SIMCTL_ARGS"] = str(simctl_args)
        env["TEST_SNAPSHOT_COUNT"] = str(snapshot_count)
        env["TEST_LAUNCHER_FIRST"] = "0" if release_launch else "1"
        result = subprocess.run(
            ["bash", "-c", script],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        commands = simctl_args.read_text(encoding="utf-8").splitlines()
        return result, commands

    def test_release_launch_targets_selected_simulator_udid(self) -> None:
        result, commands = self.run_probe(release_launch=True)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            commands,
            ["simctl launch SELECTED-UDID com.example.authored"],
        )

    def test_dev_client_initial_and_retry_openurl_target_selected_udid(self) -> None:
        result, commands = self.run_probe(release_launch=False)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            commands,
            [
                "simctl openurl SELECTED-UDID example://ready",
                "simctl openurl SELECTED-UDID example://ready",
            ],
        )


class SimulatorSelectionTests(unittest.TestCase):
    def run_simulator_setup_failure(
        self,
        failure: str,
        exit_code: int,
    ) -> subprocess.CompletedProcess[str]:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        out = root / "out"
        bin_dir = root / "bin"
        out.mkdir()
        bin_dir.mkdir()
        devices = {
            "devices": {}
            if failure == "selection"
            else {
                "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                    {
                        "name": "iPhone 17 Pro",
                        "udid": "SELECTED-UDID",
                        "isAvailable": True,
                        "state": "Shutdown",
                    }
                ]
            }
        }
        executable(
            bin_dir / "xcrun",
            f"""\
            #!/usr/bin/env bash
            if [ "$*" = "simctl list devices available --json" ]; then
              printf '%s\n' {json.dumps(json.dumps(devices))}
            fi
            exit 0
            """,
        )
        executable(
            bin_dir / "bun",
            f"""\
            #!/usr/bin/env bash
            count=0
            [ ! -f "$TEST_BUN_COUNT" ] || count="$(cat "$TEST_BUN_COUNT")"
            count=$((count + 1))
            printf '%s' "$count" >"$TEST_BUN_COUNT"
            if [ {json.dumps(failure)} = boot ]; then exit {exit_code}; fi
            if [ {json.dumps(failure)} = runner ] && [ "$count" -gt 1 ]; then exit {exit_code}; fi
            exit 0
            """,
        )
        script = textwrap.dedent(
            f"""\
            set -uo pipefail
            source {IOS_RUNTIME!s}
            eval::gate() {{ return 0; }}
            sleep() {{ :; }}
            export _EVAL_STAGES_DIR=/unused
            export EVAL_IOS_BOOT_ATTEMPTS=1
            eval::boot_sim_and_runner {out!s}
            status=$?
            printf 'OUTCOME=%s|%s|%s|%s\n' "$status" \
              "${{EVAL_IOS_PREREQUISITE_REASON:-}}" \
              "${{EVAL_IOS_PREREQUISITE_LOG:-}}" \
              "${{EVAL_DEV_UDID:-unset}}"
            """
        )
        env = os.environ.copy()
        env["PATH"] = f"{bin_dir}:{env['PATH']}"
        env["TEST_BUN_COUNT"] = str(root / "bun-count")
        return subprocess.run(
            ["bash", "-c", script],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_missing_simulator_records_exact_preflight_reason_without_device_vars(self) -> None:
        """No-device selection must preserve its own diagnostic instead of falling through."""
        result = self.run_simulator_setup_failure("selection", 1)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "OUTCOME=1|evaluator simulator selection failed|logs/s4-simctl-devices.err|unset",
            result.stdout,
        )

    def test_agent_device_boot_failure_records_exact_preflight_log(self) -> None:
        """A selected simulator whose driver cannot boot remains evaluator infrastructure."""
        result = self.run_simulator_setup_failure("boot", 45)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "OUTCOME=45|evaluator simulator boot failed|logs/s4-boot.log|SELECTED-UDID",
            result.stdout,
        )

    def test_ios_runner_prepare_failure_records_exact_preflight_log(self) -> None:
        """A prepared simulator with a failed XCTest runner must retain the runner stage."""
        result = self.run_simulator_setup_failure("runner", 46)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "OUTCOME=46|evaluator ios-runner preparation failed|logs/s4-runner.log|SELECTED-UDID",
            result.stdout,
        )

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
                            "state": "Booted",
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
