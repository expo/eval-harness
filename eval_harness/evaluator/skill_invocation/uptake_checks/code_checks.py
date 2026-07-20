"""Code-driven uptake checks, registered via registry.register.

Distinct from checks_data.json's declarative lexical/structural checks for
one of two reasons:

- Per-file-subset filtering that the generic dispatch can't express. The
  generic dispatch only ever answers "does any file match X" / "does no
  file match X" -- it has no way to say "no file *of this specific kind*
  matches X" (e.g. "_layout files must not have a 'use dom' directive",
  which would be wrong as a blanket text_absent check since ordinary DOM
  component files are supposed to have that directive).
- Real AST parsing, where regex would have too many false positives/
  negatives (e.g. counting default exports, or telling a react-native
  <Text> apart from an unrelated <Text> defined locally).

Importing this module -- done once, from uptake_checks/__init__.py -- is
what populates registry._CODE_REGISTRY.
"""

from __future__ import annotations

import re

from ..build_health.node_parser import extract_ast_facts
from .registry import AppTree, CheckResult, register

_USE_DOM_RE = re.compile(r"""['"]use dom['"]""")
_LAYOUT_FILENAME_RE = re.compile(r"^_layout\.(t|j)sx?$")
_API_ROUTE_FILENAME_RE = re.compile(r"\+api\.(t|j)sx?$")
_BANNED_NODE_IMPORT_RE = re.compile(
    r"""from\s+['"](fs|node:fs|node:crypto|node-fetch)['"]|require\(['"](fs|node:fs|node:crypto|node-fetch)['"]\)"""
)


def _result(check_id: str, category: str, passed: bool, evidence: str) -> CheckResult:
    return CheckResult(check_id, category, "code", None, passed, evidence)


@register(
    "dom_layout_excludes_use_dom",
    category="lexical",
    description="expo-dom rule: a _layout file must never itself be a DOM component. "
    "Code-driven (not a declarative text_absent check) because it must filter to just "
    "_layout files -- ordinary DOM component files are supposed to have the directive.",
)
def _dom_layout_excludes_use_dom(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if not _LAYOUT_FILENAME_RE.match(path.name):
            continue
        if _USE_DOM_RE.search(text):
            return _result(
                "dom_layout_excludes_use_dom", "lexical", False,
                f"{path}: a _layout file has a 'use dom' directive",
            )
    return _result(
        "dom_layout_excludes_use_dom", "lexical", True,
        "no _layout file has a 'use dom' directive",
    )


@register(
    "hosting_no_banned_node_imports_in_api_routes",
    category="lexical",
    description="eas-hosting rule: +api.ts route files run on an edge runtime and must not "
    "import Node-only builtins (fs, node:crypto) or node-fetch. Code-driven because it must "
    "filter to just +api.* files, not the whole app. Vacuously passes if the app has no "
    "+api routes at all.",
)
def _hosting_no_banned_node_imports_in_api_routes(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if not _API_ROUTE_FILENAME_RE.search(path.name):
            continue
        if _BANNED_NODE_IMPORT_RE.search(text):
            return _result(
                "hosting_no_banned_node_imports_in_api_routes", "lexical", False,
                f"{path}: imports a banned Node-only builtin in an API route",
            )
    return _result(
        "hosting_no_banned_node_imports_in_api_routes", "lexical", True,
        "no +api route imports a banned Node-only builtin (or no +api routes exist)",
    )


@register(
    "dom_single_default_export_and_no_native_jsx",
    category="syntax-tree",
    description="expo-dom rule: a 'use dom' file must have exactly one default export and "
    "must not render a react-native primitive as JSX. Both need real AST facts (export "
    "counting, import-bound JSX element names) that regex can't verify without false "
    "positives/negatives -- see extract-ast-facts.js. Uses the same Babel subprocess as "
    "build_health's syntax check. Passes (doesn't fail) if the app has no 'use dom' files, "
    "or if the parser can't run at all -- a missing tool isn't evidence of a violation.",
)
def _dom_single_default_export_and_no_native_jsx(app_tree: AppTree) -> CheckResult:
    dom_paths = [path for path, text in app_tree.files.items() if _USE_DOM_RE.search(text)]
    if not dom_paths:
        return _result(
            "dom_single_default_export_and_no_native_jsx", "syntax-tree", True,
            "no 'use dom' files found",
        )
    for path in dom_paths:
        facts = extract_ast_facts(app_tree.root / path)
        if facts is None or facts.get("error"):
            continue  # parser unavailable or file doesn't parse -- not this check's call
        if facts.get("defaultExportCount") != 1:
            return _result(
                "dom_single_default_export_and_no_native_jsx", "syntax-tree", False,
                f"{path}: has {facts.get('defaultExportCount')} default exports, expected exactly 1",
            )
        native_elements = facts.get("reactNativeJsxElementsUsed") or []
        if native_elements:
            return _result(
                "dom_single_default_export_and_no_native_jsx", "syntax-tree", False,
                f"{path}: renders react-native JSX element(s) {native_elements!r} inside a DOM component",
            )
    return _result(
        "dom_single_default_export_and_no_native_jsx", "syntax-tree", True,
        f"{len(dom_paths)} 'use dom' file(s) each have exactly one default export and no react-native JSX",
    )
