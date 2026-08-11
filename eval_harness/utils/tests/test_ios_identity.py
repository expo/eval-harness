import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
NORMALIZE = ROOT / "eval_harness/utils/ios/normalize_ios_identity.mjs"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def normalize(workspace: Path, config: dict[str, object], output: Path) -> subprocess.CompletedProcess[str]:
    config_path = workspace / "resolved-expo-config.json"
    write_json(config_path, config)
    return subprocess.run(
        ["node", str(NORMALIZE), str(workspace), "Run 42", str(config_path), str(output)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class IosIdentityTests(unittest.TestCase):
    def test_static_config_missing_identity_gets_deterministic_valid_evaluator_values(self) -> None:
        """A static config with no native identity must build under stable evaluator values.

        Catches: retaining the missing-config failure, generating invalid values,
        or mutating the author source rather than its evaluator materialization.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "author-source"
            workspace = root / "evaluator-materialization"
            output = root / "ios-identity-adjustments.json"
            authored_config = {"expo": {"name": "Notes", "slug": "notes", "ios": {}}}
            write_json(source / "app.json", authored_config)
            shutil.copytree(source, workspace)

            result = normalize(workspace, {"name": "Notes", "slug": "notes", "ios": {}}, output)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((source / "app.json").read_text(encoding="utf-8")), authored_config)
            normalized = json.loads((workspace / "app.json").read_text(encoding="utf-8"))["expo"]
            self.assertEqual(normalized["ios"]["bundleIdentifier"], "com.evalharness.da74b6b1b847")
            self.assertEqual(normalized["scheme"], "eval-da74b6b1b847")
            self.assertRegex(normalized["ios"]["bundleIdentifier"], r"^[A-Za-z0-9.-]+$")
            self.assertRegex(normalized["scheme"], r"^[A-Za-z][A-Za-z0-9+.-]*$")
            adjustments = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(
                adjustments["adjustments"],
                [
                    {
                        "field": "ios.bundleIdentifier",
                        "from": None,
                        "to": "com.evalharness.da74b6b1b847",
                    },
                    {"field": "scheme", "from": None, "to": "eval-da74b6b1b847"},
                ],
            )

    def test_static_config_with_identity_is_not_rewritten(self) -> None:
        """Authored static identity is authoritative and must survive untouched.

        Catches: overwriting unique authored iOS identifiers on the evaluator.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            workspace = root / "evaluator-materialization"
            output = root / "ios-identity-adjustments.json"
            config = {
                "expo": {
                    "name": "Notes",
                    "slug": "notes",
                    "scheme": "notes",
                    "ios": {"bundleIdentifier": "com.example.notes"},
                }
            }
            write_json(workspace / "app.json", config)

            result = normalize(workspace, config["expo"], output)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((workspace / "app.json").read_text(encoding="utf-8")), config)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["adjustments"], [])

    def test_dynamic_config_missing_identity_keeps_author_logic_and_plugins(self) -> None:
        """Dynamic config must add identity without flattening its computed behavior.

        Catches: replacing app.config.js with resolved JSON and losing plugin or
        platform settings that native prebuild still needs.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "author-source"
            workspace = root / "evaluator-materialization"
            output = root / "ios-identity-adjustments.json"
            author_config = """module.exports = ({ config }) => ({
  ...config,
  name: 'Dynamic Notes',
  plugins: [['expo-router', { origin: 'author' }]],
  ios: { ...(config.ios || {}), buildNumber: '7' },
});
"""
            (source / "app.config.js").parent.mkdir(parents=True, exist_ok=True)
            (source / "app.config.js").write_text(author_config, encoding="utf-8")
            shutil.copytree(source, workspace)

            result = normalize(
                workspace,
                {
                    "name": "Dynamic Notes",
                    "slug": "dynamic-notes",
                    "plugins": [["expo-router", {"origin": "author"}]],
                    "ios": {"buildNumber": "7"},
                },
                output,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((source / "app.config.js").read_text(encoding="utf-8"), author_config)
            resolved = subprocess.run(
                [
                    "node",
                    "-e",
                    "const config = require(process.argv[1])({ config: { slug: 'dynamic-notes' } }); console.log(JSON.stringify(config));",
                    str(workspace / "app.config.js"),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(resolved.returncode, 0, resolved.stderr)
            normalized = json.loads(resolved.stdout)
            self.assertEqual(normalized["plugins"], [["expo-router", {"origin": "author"}]])
            self.assertEqual(normalized["ios"]["buildNumber"], "7")
            self.assertEqual(normalized["ios"]["bundleIdentifier"], "com.evalharness.da74b6b1b847")
            self.assertEqual(normalized["scheme"], "eval-da74b6b1b847")

    def test_dynamic_config_with_identity_is_not_wrapped(self) -> None:
        """Authored dynamic identity must not receive an evaluator wrapper.

        Catches: changing behavior of complete dynamic configs just to emit an
        empty adjustment log.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            workspace = root / "evaluator-materialization"
            output = root / "ios-identity-adjustments.json"
            author_config = "module.exports = () => ({ name: 'Notes' });\n"
            (workspace / "app.config.js").parent.mkdir(parents=True, exist_ok=True)
            (workspace / "app.config.js").write_text(author_config, encoding="utf-8")
            resolved = {
                "name": "Notes",
                "scheme": "notes",
                "ios": {"bundleIdentifier": "com.example.notes"},
            }

            result = normalize(workspace, resolved, output)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((workspace / "app.config.js").read_text(encoding="utf-8"), author_config)
            self.assertFalse((workspace / ".eval-ios-author-app.config.js").exists())
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["adjustments"], [])


if __name__ == "__main__":
    unittest.main()
