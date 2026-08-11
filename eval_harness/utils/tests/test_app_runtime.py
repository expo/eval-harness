import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
APP_RUNTIME = ROOT / "eval_harness" / "utils" / "shell" / "app_runtime.sh"


class ReleaseIosBuildTests(unittest.TestCase):
    def test_release_build_targets_generic_simulator_then_installs_app(self) -> None:
        """Catch regressions that make CI request physical-device signing."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / "app"
            out = root / "out"
            bin_dir = root / "bin"
            app.mkdir()
            out.mkdir()
            bin_dir.mkdir()

            bun_args = root / "bun-args.txt"
            install_args = root / "install-args.txt"
            bun = bin_dir / "bun"
            bun.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -eu
                    printf '%s\\n' "$@" > "$TEST_BUN_ARGS"
                    output=""
                    previous=""
                    for argument in "$@"; do
                      if [ "$previous" = "--output" ]; then output="$argument"; fi
                      previous="$argument"
                    done
                    if [ -n "$output" ]; then mkdir -p "$output/Fixture.app"; fi
                    echo "Build complete"
                    """
                ),
                encoding="utf-8",
            )
            bun.chmod(0o755)
            agent_device = bin_dir / "agent-device"
            agent_device.write_text(
                "#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' \"$@\" > \"$TEST_INSTALL_ARGS\"\n",
                encoding="utf-8",
            )
            agent_device.chmod(0o755)

            script = textwrap.dedent(
                f"""\
                set -uo pipefail
                source {APP_RUNTIME!s}
                eval::gate() {{ return "$1"; }}
                sleep() {{ :; }}
                export _EVAL_STAGES_DIR=/unused
                export EVAL_APP_BUNDLE_ID=com.example.fixture
                eval::build_release_ios_app {app!s} {out!s} "iPhone 17 Pro"
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

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            build_arguments = bun_args.read_text(encoding="utf-8").splitlines()
            self.assertIn("--device", build_arguments)
            device_index = build_arguments.index("--device")
            self.assertEqual(build_arguments[device_index + 1], "generic")
            self.assertIn("--output", build_arguments)
            output_index = build_arguments.index("--output")
            build_output = Path(build_arguments[output_index + 1])
            self.assertFalse(build_output.exists(), "temporary .app build output should be removed")

            install_arguments = install_args.read_text(encoding="utf-8").splitlines()
            self.assertEqual(install_arguments[0], "install")
            self.assertEqual(install_arguments[1], "com.example.fixture")
            self.assertEqual(Path(install_arguments[2]).name, "Fixture.app")
            self.assertEqual(
                install_arguments[3:],
                ["--platform", "ios", "--device", "iPhone 17 Pro"],
            )


if __name__ == "__main__":
    unittest.main()
