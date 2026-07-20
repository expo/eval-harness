"""Code-driven uptake checks, registered via registry.register.

Distinct from checks_data.json's declarative lexical/structural checks for
one of three reasons:

- Per-file-subset filtering that the generic dispatch can't express. The
  generic dispatch only ever answers "does any file match X" / "does no
  file match X" -- it has no way to say "no file *of this specific kind*
  matches X" (e.g. "_layout files must not have a 'use dom' directive",
  which would be wrong as a blanket text_absent check since ordinary DOM
  component files are supposed to have that directive).
- Real AST parsing, where regex would have too many false positives/
  negatives (e.g. counting default exports, or telling a react-native
  <Text> apart from an unrelated <Text> defined locally).
- Conditional applicability: some rules only make sense to evaluate when a
  precondition holds (e.g. "API routes use TypeScript" presupposes the app
  has API routes at all; "client env vars use the EXPO_PUBLIC_ prefix"
  presupposes the app reads any client env var at all). The generic
  dispatch has no not_applicable concept -- only code-driven checks can
  return it.

Every check here must return not_applicable when its precondition doesn't
hold, and unavailable when evidence genuinely couldn't be collected (e.g.
the AST parser can't run) -- never silently treat either as a pass. See
registry.CheckResult's docstring for why: a vacuous pass or a parser-failure
pass would let a wholly irrelevant or unverified rule count as uptake
evidence, which is exactly the kind of over-precise coverage the review
that drove this file's design was warning against.

Importing this module -- done once, from uptake_checks/__init__.py -- is
what populates registry._CODE_REGISTRY.
"""

from __future__ import annotations

import re

from ..build_health.node_parser import extract_ast_facts
from .registry import (
    STATUS_FAILED,
    STATUS_NOT_APPLICABLE,
    STATUS_PASSED,
    STATUS_UNAVAILABLE,
    AppTree,
    CheckResult,
    register,
)

_USE_DOM_CANDIDATE_RE = re.compile(r"""['"]use dom['"]""")
_LAYOUT_FILENAME_RE = re.compile(r"^_layout\.(t|j)sx?$")
_API_ROUTE_FILENAME_RE = re.compile(r"\+api\.(t|j)sx?$")
_BANNED_NODE_IMPORT_RE = re.compile(
    r"""from\s+['"](fs|node:fs|node:crypto|node-fetch)['"]|require\(['"](fs|node:fs|node:crypto|node-fetch)['"]\)"""
)
_PROCESS_ENV_READ_RE = re.compile(r"process\.env\.([A-Za-z_][A-Za-z0-9_]*)")
# Framework/tooling-provided vars, not user client-config choices the
# EXPO_PUBLIC_ naming rule is about. EXPO_OS confirmed live: wiki_reader
# reads it for platform detection (the very process.env.EXPO_OS the
# expo-native-ui skill itself recommends over Platform.OS) -- it will never
# be EXPO_PUBLIC_-prefixed and was never meant to be.
_ENV_PREFIX_EXEMPT = {"NODE_ENV", "EXPO_OS"}


def _passed(check_id: str, category: str, evidence: str) -> CheckResult:
    return CheckResult(check_id, category, "code", None, True, evidence, STATUS_PASSED)


def _failed(check_id: str, category: str, evidence: str) -> CheckResult:
    return CheckResult(check_id, category, "code", None, False, evidence, STATUS_FAILED)


def _not_applicable(check_id: str, category: str, evidence: str) -> CheckResult:
    return CheckResult(check_id, category, "code", None, None, evidence, STATUS_NOT_APPLICABLE)


def _unavailable(check_id: str, category: str, evidence: str) -> CheckResult:
    return CheckResult(check_id, category, "code", None, None, evidence, STATUS_UNAVAILABLE)


@register(
    "dom_layout_excludes_use_dom",
    category="lexical",
    description="expo-dom rule: a _layout file must never itself be a DOM component. "
    "Code-driven (not a declarative text_absent check) because it must filter to just "
    "_layout files -- ordinary DOM component files are supposed to have the directive. "
    "not_applicable if the app has no _layout files at all (nothing to check).",
)
def _dom_layout_excludes_use_dom(app_tree: AppTree) -> CheckResult:
    layout_paths = [path for path in app_tree.files if _LAYOUT_FILENAME_RE.match(path.name)]
    if not layout_paths:
        return _not_applicable("dom_layout_excludes_use_dom", "lexical", "no _layout files found")
    for path in layout_paths:
        if _USE_DOM_CANDIDATE_RE.search(app_tree.files[path]):
            return _failed(
                "dom_layout_excludes_use_dom", "lexical",
                f"{path}: a _layout file has a 'use dom' directive",
            )
    return _passed(
        "dom_layout_excludes_use_dom", "lexical",
        f"none of {len(layout_paths)} _layout file(s) has a 'use dom' directive",
    )


@register(
    "hosting_no_banned_node_imports_in_api_routes",
    category="lexical",
    description="eas-hosting rule: +api.ts route files run on an edge runtime and must not "
    "import Node-only builtins (fs, node:crypto) or node-fetch. Code-driven because it must "
    "filter to just +api.* files, not the whole app. not_applicable if the app has no API "
    "routes at all (EAS Hosting also serves static sites with no API routes).",
)
def _hosting_no_banned_node_imports_in_api_routes(app_tree: AppTree) -> CheckResult:
    api_paths = [path for path in app_tree.files if _API_ROUTE_FILENAME_RE.search(path.name)]
    if not api_paths:
        return _not_applicable(
            "hosting_no_banned_node_imports_in_api_routes", "lexical", "no +api routes found"
        )
    for path in api_paths:
        if _BANNED_NODE_IMPORT_RE.search(app_tree.files[path]):
            return _failed(
                "hosting_no_banned_node_imports_in_api_routes", "lexical",
                f"{path}: imports a banned Node-only builtin in an API route",
            )
    return _passed(
        "hosting_no_banned_node_imports_in_api_routes", "lexical",
        f"none of {len(api_paths)} +api route(s) imports a banned Node-only builtin",
    )


@register(
    "hosting_api_routes_use_typescript",
    category="structural",
    description="eas-hosting rule: use TypeScript for API routes -- a plain-JS +api.js file "
    "is the anti-pattern. not_applicable if the app has no API routes at all (moved off a "
    "declarative path_absent check, which could only ever vacuously pass in that case rather "
    "than say so explicitly).",
)
def _hosting_api_routes_use_typescript(app_tree: AppTree) -> CheckResult:
    api_paths = [path for path in app_tree.files if _API_ROUTE_FILENAME_RE.search(path.name)]
    if not api_paths:
        return _not_applicable("hosting_api_routes_use_typescript", "structural", "no +api routes found")
    js_paths = [path for path in api_paths if path.suffix == ".js"]
    if js_paths:
        return _failed(
            "hosting_api_routes_use_typescript", "structural",
            f"{js_paths[0]}: a +api route uses .js instead of .ts",
        )
    return _passed(
        "hosting_api_routes_use_typescript", "structural",
        f"all {len(api_paths)} +api route(s) use TypeScript",
    )


@register(
    "data_fetching_expo_public_env_prefix",
    category="lexical",
    description="expo-data-fetching rule: only EXPO_PUBLIC_-prefixed env vars are exposed "
    "client-side. Code-driven (not a bare presence-of-EXPO_PUBLIC_ regex) so it can verify "
    "the naming convention against whichever env vars the app actually reads, and return "
    "not_applicable rather than a scored fail when the app reads no client env var at all -- "
    "confirmed live: both real hot_chocolate and wiki_reader apps read zero env vars (a "
    "self-contained app and a WebView wrapper respectively), so a presence-only check would "
    "always fail them regardless of true skill uptake.",
)
def _data_fetching_expo_public_env_prefix(app_tree: AppTree) -> CheckResult:
    env_var_names: set[str] = set()
    for text in app_tree.files.values():
        env_var_names.update(_PROCESS_ENV_READ_RE.findall(text))
    env_var_names -= _ENV_PREFIX_EXEMPT
    if not env_var_names:
        return _not_applicable(
            "data_fetching_expo_public_env_prefix", "lexical",
            "no process.env.* reads found -- no client-side config needed",
        )
    non_public = sorted(name for name in env_var_names if not name.startswith("EXPO_PUBLIC_"))
    if non_public:
        return _failed(
            "data_fetching_expo_public_env_prefix", "lexical",
            f"reads env var(s) {non_public!r} without the EXPO_PUBLIC_ prefix",
        )
    return _passed(
        "data_fetching_expo_public_env_prefix", "lexical",
        f"all client-read env var(s) {sorted(env_var_names)!r} use the EXPO_PUBLIC_ prefix",
    )


@register(
    "dom_single_default_export_and_no_native_jsx",
    category="syntax-tree",
    description="expo-dom rule: a 'use dom' file must have exactly one default export and "
    "must not render a react-native primitive as JSX. Both need real AST facts (export "
    "counting, import-bound JSX element names, including namespace imports like "
    "`import * as RN` and JSXMemberExpression usages like <RN.Text>) that regex can't verify "
    "without false positives/negatives -- see extract-ast-facts.js. Uses the same Babel "
    "subprocess as build_health's syntax check. A regex is only used to cheaply prefilter "
    "candidate files; the AST's own hasUseDomDirective fact -- not the regex -- decides "
    "whether a candidate is really a DOM file, so a string like `const label = \"use dom\"` "
    "doesn't get treated as one. not_applicable if no file is confirmed to have the "
    "directive; unavailable (not a silent pass) if the parser couldn't run at all.",
)
def _dom_single_default_export_and_no_native_jsx(app_tree: AppTree) -> CheckResult:
    candidate_paths = [path for path, text in app_tree.files.items() if _USE_DOM_CANDIDATE_RE.search(text)]
    if not candidate_paths:
        return _not_applicable(
            "dom_single_default_export_and_no_native_jsx", "syntax-tree",
            "no 'use dom'-like text found in any file",
        )

    confirmed: list[tuple] = []
    any_unavailable = False
    for path in candidate_paths:
        facts = extract_ast_facts(app_tree.root / path)
        if facts is None or facts.get("error"):
            any_unavailable = True
            continue
        if not facts.get("hasUseDomDirective"):
            continue  # regex prefilter false positive -- confirmed not a real directive
        confirmed.append((path, facts))

    if not confirmed:
        if any_unavailable:
            return _unavailable(
                "dom_single_default_export_and_no_native_jsx", "syntax-tree",
                "parser could not confirm any candidate 'use dom' file",
            )
        return _not_applicable(
            "dom_single_default_export_and_no_native_jsx", "syntax-tree",
            "no file has a confirmed 'use dom' directive (regex match(es) were false positives)",
        )

    for path, facts in confirmed:
        if facts.get("defaultExportCount") != 1:
            return _failed(
                "dom_single_default_export_and_no_native_jsx", "syntax-tree",
                f"{path}: has {facts.get('defaultExportCount')} default exports, expected exactly 1",
            )
        native_elements = facts.get("reactNativeJsxElementsUsed") or []
        if native_elements:
            return _failed(
                "dom_single_default_export_and_no_native_jsx", "syntax-tree",
                f"{path}: renders react-native JSX element(s) {native_elements!r} inside a DOM component",
            )
    return _passed(
        "dom_single_default_export_and_no_native_jsx", "syntax-tree",
        f"{len(confirmed)} confirmed 'use dom' file(s) each have exactly one default export "
        "and no react-native JSX",
    )
