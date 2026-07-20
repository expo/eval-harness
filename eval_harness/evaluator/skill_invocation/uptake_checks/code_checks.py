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
  <Text> apart from an unrelated <Text> defined locally, or a real leading
  directive apart from a same-shaped string statement anywhere else in the
  file).
- Conditional applicability: some rules only make sense to evaluate when a
  precondition holds (e.g. "API routes use TypeScript" presupposes the app
  has API routes at all; "client env vars use the EXPO_PUBLIC_ prefix"
  presupposes the app reads any client-side env var at all -- and doesn't
  apply to a server-only +api.ts route's own secrets, which are correctly
  unprefixed). The generic dispatch has no not_applicable concept -- only
  code-driven checks can return it.

Every check here must return not_applicable when its precondition doesn't
hold, and unavailable when evidence genuinely couldn't be collected (e.g.
the AST parser can't run) -- never silently treat either as a pass, and
never let a partial success (one file confirmed clean) hide a real failure
to evaluate a *different* candidate file. See registry.CheckResult's
docstring for why: a vacuous pass, a parser-failure pass, or a
partially-checked pass all let something other than real evidence count as
uptake.

Regex scans in this file always run against `strip_comments(text)`, matching
every declarative check in registry.py -- a regex over raw text has the same
comment-false-positive risk regardless of which dispatch path runs it.

Importing this module -- done once, from uptake_checks/__init__.py -- is
what populates registry._CODE_REGISTRY.
"""

from __future__ import annotations

import re
from pathlib import Path

from ..build_health.node_parser import extract_ast_facts
from .registry import (
    STATUS_FAILED,
    STATUS_NOT_APPLICABLE,
    STATUS_PASSED,
    STATUS_UNAVAILABLE,
    AppTree,
    CheckResult,
    register,
    strip_comments,
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


def _dom_candidate_files(app_tree: AppTree) -> tuple[list[tuple[Path, dict]], set[Path]]:
    """Shared by every expo-dom check that needs to know which files are
    *real* DOM components, so the regex-prefilter + AST-confirmation logic
    isn't duplicated three times.

    Returns `(confirmed, unavailable_paths)`:
    - `confirmed`: (path, facts) pairs where extract_ast_facts confirms a
      genuine 'use dom' directive-prologue entry -- not just the regex
      prefilter, which also matches a plain string statement like
      `"use dom";` appearing after other code (not a real directive) or
      inside an ordinary variable assignment.
    - `unavailable_paths`: candidate files (regex-matched) the parser
      couldn't resolve either way (missing tool, or the file itself doesn't
      parse). Callers decide whether an unavailable candidate is relevant to
      their specific check -- e.g. only a _layout-named unavailable
      candidate matters to the layout-exclusion check, but any unavailable
      candidate matters to the "does the app have a real DOM component"
      check.
    """
    candidate_paths = [
        path for path, text in app_tree.files.items()
        if _USE_DOM_CANDIDATE_RE.search(strip_comments(text))
    ]
    confirmed: list[tuple[Path, dict]] = []
    unavailable_paths: set[Path] = set()
    for path in candidate_paths:
        facts = extract_ast_facts(app_tree.root / path)
        if facts is None or facts.get("error"):
            unavailable_paths.add(path)
            continue
        if facts.get("hasUseDomDirective"):
            confirmed.append((path, facts))
    return confirmed, unavailable_paths


@register(
    "dom_use_dom_directive_present",
    category="syntax-tree",
    description="expo-dom rule: a DOM component file must start with the 'use dom' directive. "
    "AST-backed (not a declarative regex check) because a directive is a specific JS-grammar "
    "position (a leading string-literal-expression-statement) -- a regex anchored to 'appears "
    "alone on its own line' still matches a `\"use dom\";` statement placed after other code, "
    "which is not a real directive and has no DOM-component effect. If the app has zero "
    "real 'use dom' files, this is the check that should read failed (this skill was "
    "expected but never engaged with at all) -- its sibling checks (dom_layout_excludes_use_dom, "
    "dom_single_default_export_and_no_native_jsx) read not_applicable in that case instead, "
    "since their own rules only make sense once at least one real DOM component exists.",
)
def _dom_use_dom_directive_present(app_tree: AppTree) -> CheckResult:
    confirmed, unavailable_paths = _dom_candidate_files(app_tree)
    if confirmed:
        path = confirmed[0][0]
        return _passed("dom_use_dom_directive_present", "syntax-tree", f"{path}: has a real 'use dom' directive")
    if unavailable_paths:
        return _unavailable(
            "dom_use_dom_directive_present", "syntax-tree",
            "parser could not confirm any candidate 'use dom' file",
        )
    return _failed(
        "dom_use_dom_directive_present", "syntax-tree",
        "no file has a confirmed 'use dom' directive",
    )


@register(
    "dom_layout_excludes_use_dom",
    category="syntax-tree",
    description="expo-dom rule: a _layout file must never itself be a DOM component. "
    "AST-backed (uses the same confirmed-directive facts as dom_use_dom_directive_present) so "
    "an unrelated 'use dom'-shaped string inside a _layout file (a comment, an unrelated "
    "string constant) doesn't false-fail this check -- only a real, AST-confirmed directive "
    "counts as the violation. not_applicable if the app has no _layout files at all.",
)
def _dom_layout_excludes_use_dom(app_tree: AppTree) -> CheckResult:
    layout_paths = {path for path in app_tree.files if _LAYOUT_FILENAME_RE.match(path.name)}
    if not layout_paths:
        return _not_applicable("dom_layout_excludes_use_dom", "syntax-tree", "no _layout files found")

    confirmed, unavailable_paths = _dom_candidate_files(app_tree)
    violating_layouts = sorted(path for path, _ in confirmed if path in layout_paths)
    if violating_layouts:
        return _failed(
            "dom_layout_excludes_use_dom", "syntax-tree",
            f"{violating_layouts[0]}: a _layout file has a real 'use dom' directive",
        )
    unresolved_layouts = sorted(layout_paths & unavailable_paths)
    if unresolved_layouts:
        return _unavailable(
            "dom_layout_excludes_use_dom", "syntax-tree",
            f"parser could not confirm whether {unresolved_layouts[0]} has a real 'use dom' directive",
        )
    return _passed(
        "dom_layout_excludes_use_dom", "syntax-tree",
        f"none of {len(layout_paths)} _layout file(s) has a confirmed 'use dom' directive",
    )


@register(
    "dom_single_default_export_and_no_native_jsx",
    category="syntax-tree",
    description="expo-dom rule: a 'use dom' file must have exactly one default export and "
    "must not render a react-native primitive as JSX (including namespace imports like "
    "`import * as RN` and JSXMemberExpression usages like <RN.Text>) -- both need real AST "
    "facts that regex can't verify without false positives/negatives. Aggregation across "
    "every confirmed 'use dom' file, in order: (1) any confirmed file with a real violation "
    "-> failed; (2) else, any candidate the parser couldn't resolve -> unavailable (a second "
    "file parsing cleanly must not hide a different file's parser failure); (3) else, if no "
    "file was ever confirmed as a real DOM component -> not_applicable; (4) else -> passed.",
)
def _dom_single_default_export_and_no_native_jsx(app_tree: AppTree) -> CheckResult:
    confirmed, unavailable_paths = _dom_candidate_files(app_tree)

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

    if unavailable_paths:
        return _unavailable(
            "dom_single_default_export_and_no_native_jsx", "syntax-tree",
            f"{len(unavailable_paths)} candidate 'use dom' file(s) could not be parsed, so full "
            "coverage can't be confirmed even though every confirmed file passes",
        )

    if not confirmed:
        return _not_applicable(
            "dom_single_default_export_and_no_native_jsx", "syntax-tree",
            "no file has a confirmed 'use dom' directive",
        )

    return _passed(
        "dom_single_default_export_and_no_native_jsx", "syntax-tree",
        f"{len(confirmed)} confirmed 'use dom' file(s) each have exactly one default export "
        "and no react-native JSX",
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
        if _BANNED_NODE_IMPORT_RE.search(strip_comments(app_tree.files[path])):
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
    description="eas-hosting rule: use TypeScript for API routes -- a plain-JS +api.js/+api.jsx "
    "file is the anti-pattern. not_applicable if the app has no API routes at all.",
)
def _hosting_api_routes_use_typescript(app_tree: AppTree) -> CheckResult:
    api_paths = [path for path in app_tree.files if _API_ROUTE_FILENAME_RE.search(path.name)]
    if not api_paths:
        return _not_applicable("hosting_api_routes_use_typescript", "structural", "no +api routes found")
    non_ts_paths = [path for path in api_paths if path.suffix not in (".ts", ".tsx")]
    if non_ts_paths:
        return _failed(
            "hosting_api_routes_use_typescript", "structural",
            f"{non_ts_paths[0]}: a +api route uses {non_ts_paths[0].suffix} instead of .ts/.tsx",
        )
    return _passed(
        "hosting_api_routes_use_typescript", "structural",
        f"all {len(api_paths)} +api route(s) use TypeScript",
    )


@register(
    "data_fetching_expo_public_env_prefix",
    category="lexical",
    description="expo-data-fetching rule: only EXPO_PUBLIC_-prefixed env vars are exposed "
    "client-side. Code-driven (not a bare presence-of-EXPO_PUBLIC_ regex) so it can verify the "
    "naming convention against whichever env vars the app actually reads, and return "
    "not_applicable rather than a scored fail when the app reads no client env var at all -- "
    "confirmed live: both real hot_chocolate and wiki_reader apps read zero client env vars (a "
    "self-contained app and a WebView wrapper respectively), so a presence-only check would "
    "always fail them regardless of true skill uptake. Excludes +api.* route files entirely: "
    "the skill explicitly endorses unprefixed server-only secrets there (e.g. an OpenAI API "
    "key read inside a +api.ts handler), which is the opposite of a violation. Strips comments "
    "before scanning, same as every declarative check, so a commented-out example doesn't count.",
)
def _data_fetching_expo_public_env_prefix(app_tree: AppTree) -> CheckResult:
    env_var_names: set[str] = set()
    for path, text in app_tree.files.items():
        if _API_ROUTE_FILENAME_RE.search(path.name):
            continue  # server-side secrets in API routes are correctly unprefixed
        env_var_names.update(_PROCESS_ENV_READ_RE.findall(strip_comments(text)))
    env_var_names -= _ENV_PREFIX_EXEMPT
    if not env_var_names:
        return _not_applicable(
            "data_fetching_expo_public_env_prefix", "lexical",
            "no client-side process.env.* reads found -- no client config needed",
        )
    non_public = sorted(name for name in env_var_names if not name.startswith("EXPO_PUBLIC_"))
    if non_public:
        return _failed(
            "data_fetching_expo_public_env_prefix", "lexical",
            f"reads client-side env var(s) {non_public!r} without the EXPO_PUBLIC_ prefix",
        )
    return _passed(
        "data_fetching_expo_public_env_prefix", "lexical",
        f"all client-read env var(s) {sorted(env_var_names)!r} use the EXPO_PUBLIC_ prefix",
    )
