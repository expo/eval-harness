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


def load_expo_config(workspace: Path) -> subprocess.CompletedProcess[str]:
    """Resolve the workspace with Expo's production config loader."""
    node_modules = workspace / "node_modules"
    node_modules.mkdir(exist_ok=True)
    expo_packages = node_modules / "@expo"
    if not expo_packages.exists():
        expo_packages.symlink_to(ROOT / "node_modules" / "@expo", target_is_directory=True)
    return subprocess.run(
        [
            "node",
            "-e",
            """
const { getConfig } = require('@expo/config');
const workspace = process.argv[1];
console.log(JSON.stringify(getConfig(workspace, {
  skipSDKVersionRequirement: true,
}).exp));
""",
            str(workspace),
        ],
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
            write_json(workspace / "package.json", {})
            write_json(workspace / "app.json", {"expo": {"name": "Dynamic Notes", "slug": "dynamic-notes"}})
            plugin = workspace / "node_modules" / "expo-router" / "app.plugin.js"
            plugin.parent.mkdir(parents=True, exist_ok=True)
            plugin.write_text(
                """module.exports = (config, props) => ({
  ...config,
  extra: { ...(config.extra || {}), pluginOrigin: props.origin },
});
""",
                encoding="utf-8",
            )

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
            loaded = load_expo_config(workspace)
            self.assertEqual(loaded.returncode, 0, loaded.stderr)
            effective = json.loads(loaded.stdout)
            self.assertEqual(effective["extra"]["pluginOrigin"], "author")
            self.assertEqual(effective["ios"]["buildNumber"], "7")
            self.assertEqual(effective["ios"]["bundleIdentifier"], "com.evalharness.da74b6b1b847")
            self.assertEqual(effective["scheme"], "eval-da74b6b1b847")

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

    def test_dynamic_expo_envelope_receives_identity_inside_expo_config(self) -> None:
        """Expo unwraps `{ expo }`, so generated fields must be placed inside it.

        Catches: adding identity at the wrapper root where Expo discards it.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            workspace = root / "evaluator-materialization"
            output = root / "ios-identity-adjustments.json"
            write_json(workspace / "package.json", {})
            write_json(workspace / "app.json", {"expo": {"name": "Dynamic Notes", "slug": "dynamic-notes"}})
            plugin = workspace / "node_modules" / "expo-router" / "app.plugin.js"
            plugin.parent.mkdir(parents=True, exist_ok=True)
            plugin.write_text(
                """module.exports = (config, props) => ({
  ...config,
  extra: { ...(config.extra || {}), pluginOrigin: props.origin },
});
""",
                encoding="utf-8",
            )
            (workspace / "app.config.js").parent.mkdir(parents=True, exist_ok=True)
            (workspace / "app.config.js").write_text(
                """module.exports = ({ config }) => ({ expo: {
  ...config,
  plugins: [['expo-router', { origin: 'author' }]],
  ios: { buildNumber: '7' },
} });
""",
                encoding="utf-8",
            )

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
            loaded = load_expo_config(workspace)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(loaded.returncode, 0, loaded.stderr)
            effective = json.loads(loaded.stdout)
            self.assertEqual(effective["extra"]["pluginOrigin"], "author")
            self.assertEqual(effective["ios"]["buildNumber"], "7")
            self.assertEqual(
                effective.get("ios", {}).get("bundleIdentifier"),
                "com.evalharness.da74b6b1b847",
            )
            self.assertEqual(effective.get("scheme"), "eval-da74b6b1b847")

    def test_dynamic_config_uses_expo_ts_precedence_before_js(self) -> None:
        """The evaluator must wrap the same dynamic config Expo will load.

        Catches: selecting app.config.js when Expo gives app.config.ts priority,
        or omitting TypeScript configs from the supported discovery set.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            workspace = root / "evaluator-materialization"
            output = root / "ios-identity-adjustments.json"
            write_json(workspace / "package.json", {})
            write_json(workspace / "app.json", {"expo": {"name": "Dynamic Notes", "slug": "dynamic-notes"}})
            (workspace / "app.config.js").parent.mkdir(parents=True, exist_ok=True)
            (workspace / "app.config.js").write_text(
                "module.exports = () => { throw new Error('wrong config selected'); };\n",
                encoding="utf-8",
            )
            (workspace / "app.config.ts").write_text(
                """import type { ConfigContext, ExpoConfig } from '@expo/config';
export default ({ config }: ConfigContext): { expo: ExpoConfig } => ({
  expo: { ...config, ios: { buildNumber: '8' } },
});
""",
                encoding="utf-8",
            )

            result = normalize(
                workspace,
                {"name": "Dynamic Notes", "slug": "dynamic-notes", "ios": {"buildNumber": "8"}},
                output,
            )
            loaded = load_expo_config(workspace)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((workspace / ".eval-ios-author-app.config.ts").exists())
            self.assertEqual(
                (workspace / "app.config.js").read_text(encoding="utf-8"),
                "module.exports = () => { throw new Error('wrong config selected'); };\n",
            )
            self.assertEqual(loaded.returncode, 0, loaded.stderr)
            effective = json.loads(loaded.stdout)
            self.assertEqual(effective["ios"]["buildNumber"], "8")
            self.assertEqual(effective["ios"]["bundleIdentifier"], "com.evalharness.da74b6b1b847")
            self.assertEqual(effective["scheme"], "eval-da74b6b1b847")

    def test_dynamic_config_supports_mts_and_cts_before_js(self) -> None:
        """Every Expo TypeScript dynamic-config extension must outrank JS.

        Catches: adding `.mts`/`.cts` to the helper's advertised support while
        still wrapping a lower-priority JS config in mixed projects.
        """
        cases = [
            (
                "mts",
                """import type { ConfigContext, ExpoConfig } from '@expo/config';
export default ({ config }: ConfigContext): { expo: ExpoConfig } => ({
  expo: { ...config, ios: { buildNumber: '9' } },
});
""",
            ),
            (
                "cts",
                """import type { ConfigContext, ExpoConfig } from '@expo/config';
export = ({ config }: ConfigContext): { expo: ExpoConfig } => ({
  expo: { ...config, ios: { buildNumber: '10' } },
});
""",
            ),
        ]
        for extension, config_source in cases:
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                workspace = root / "evaluator-materialization"
                output = root / "ios-identity-adjustments.json"
                write_json(workspace / "package.json", {})
                write_json(workspace / "app.json", {"expo": {"name": "Dynamic Notes", "slug": "dynamic-notes"}})
                (workspace / "app.config.js").parent.mkdir(parents=True, exist_ok=True)
                (workspace / "app.config.js").write_text(
                    "module.exports = () => { throw new Error('wrong config selected'); };\n",
                    encoding="utf-8",
                )
                (workspace / f"app.config.{extension}").write_text(config_source, encoding="utf-8")

                result = normalize(
                    workspace,
                    {"name": "Dynamic Notes", "slug": "dynamic-notes", "ios": {}},
                    output,
                )
                loaded = load_expo_config(workspace)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((workspace / f".eval-ios-author-app.config.{extension}").exists())
                self.assertEqual(loaded.returncode, 0, loaded.stderr)
                effective = json.loads(loaded.stdout)
                self.assertEqual(effective["ios"]["bundleIdentifier"], "com.evalharness.da74b6b1b847")
                self.assertEqual(effective["scheme"], "eval-da74b6b1b847")


if __name__ == "__main__":
    unittest.main()
