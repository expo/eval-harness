"""Code-driven uptake checks, registered via registry.register.

Distinct from checks_data.json's declarative lexical/structural checks for
one of four reasons:

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
- Engagement gating for negative/anti-pattern checks (third review round):
  a declarative text_absent/path_absent check always reads `passed` when
  its forbidden pattern is absent, even when the check's skill was never
  engaged with at all -- that's not evidence of correct usage, just absence
  of any usage. expo_ui_no_host_from_subpackage, data_fetching_no_axios,
  and the expo-native-ui anti-pattern checks are code-driven specifically
  so each can require its own engagement precondition before a clean pass
  counts as real uptake; see the "engagement preconditions" section below.

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

# --- engagement preconditions (third review round) -------------------------
#
# A declarative text_absent/path_absent check always reads `passed` when its
# forbidden pattern is absent -- including when the check's skill was never
# engaged with at all, which isn't evidence of correct usage. The checks
# below are code-driven specifically so each can require an explicit
# engagement precondition before a "no violation found" result counts as a
# real pass; without engagement, they return not_applicable instead. A
# *failing* check never needs gating -- finding the forbidden pattern is
# itself proof the app touched that area, so it's always scored.

# Same patterns as declarative check expo_ui_import_used (checks_data.json) --
# duplicated here (JSON can't share a Python regex) because this is also the
# engagement precondition for expo-ui's two anti-pattern checks below.
_EXPO_UI_IMPORT_RES = [
    re.compile(r"""from\s*['"]@expo/ui['"]"""),
    re.compile(r"""from\s*['"]@expo/ui/swift-ui['"]"""),
    re.compile(r"""from\s*['"]@expo/ui/jetpack-compose['"]"""),
    re.compile(r"""from\s*['"]@expo/ui/community/"""),
]


def _expo_ui_imported(app_tree: AppTree) -> bool:
    return any(
        pattern.search(strip_comments(text))
        for text in app_tree.files.values()
        for pattern in _EXPO_UI_IMPORT_RES
    )


_EXPO_UI_HOST_FROM_SUBPACKAGE_RE = re.compile(
    r"""\bHost\b[^\n]*from\s*['"]@expo/ui/(swift-ui|jetpack-compose)['"]"""
)
_EXPO_UI_PLATFORM_TREE_GLOBS = ["app/**/*.ios.tsx", "app/**/*.android.tsx", "src/app/**/*.ios.tsx", "src/app/**/*.android.tsx"]

# Same patterns as declarative check data_fetching_uses_fetch_or_query_lib --
# duplicated for the same reason: it's also the engagement precondition for
# data_fetching_no_axios below (an axios import is itself engagement too, so
# that's checked directly rather than duplicated here).
_FETCH_OR_QUERY_LIB_RES = [
    re.compile(r"fetch\("),
    re.compile(r"""from\s*['"]@tanstack/react-query['"]"""),
    re.compile(r"""from\s*['"]swr['"]"""),
]
_AXIOS_IMPORT_RE = re.compile(r"""from\s*['"]axios['"]""")

# expo-native-ui's three anti-pattern checks each cover an independent
# feature area (media, window measurement, safe-area layout) -- fourth
# review round: a single shared "any of these four APIs" engagement signal
# let one unrelated signal (e.g. a safe-area import) activate the other two
# checks' applicability, even though using a safe-area library says nothing
# about whether the app made a correct audio/video or dimensions choice.
# Each check below now gates on only its own feature's positive replacement.
_EXPO_AV_IMPORT_RE = re.compile(r"""from\s*['"]expo-av['"]""")
_EXPO_AUDIO_OR_VIDEO_IMPORT_RES = [
    re.compile(r"""from\s*['"]expo-audio['"]"""),
    re.compile(r"""from\s*['"]expo-video['"]"""),
]
_DIMENSIONS_GET_RE = re.compile(r"Dimensions\.get\(")
_USE_WINDOW_DIMENSIONS_RE = re.compile(r"useWindowDimensions\(")
_SAFE_AREA_VIEW_FROM_REACT_NATIVE_RE = re.compile(
    r"""import\s*\{[^}]*\bSafeAreaView\b[^}]*\}\s*from\s*['"]react-native['"]"""
)
_SAFE_AREA_CONTEXT_IMPORT_RE = re.compile(r"""from\s*['"]react-native-safe-area-context['"]""")


_EXPO_ROUTER_IMPORT_RE = re.compile(r"""from\s*['"]expo-router['"]|require\(['"]expo-router['"]\)""")
_REACT_NAVIGATION_IMPORT_RE = re.compile(r"""from\s*['"]@react-navigation/""")


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
    "counts as the violation. not_applicable if the app has no real confirmed DOM component at "
    "all (third review round: gating this only on 'no _layout files' let an ordinary app with "
    "zero DOM usage vacuously pass, since almost every expo-router app has _layout files -- this "
    "now matches dom_single_default_export_and_no_native_jsx's own not_applicable precondition), "
    "or if the app has a confirmed DOM component but no _layout files at all.",
)
def _dom_layout_excludes_use_dom(app_tree: AppTree) -> CheckResult:
    confirmed, unavailable_paths = _dom_candidate_files(app_tree)
    layout_paths = {path for path in app_tree.files if _LAYOUT_FILENAME_RE.match(path.name)}

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
    if not confirmed:
        return _not_applicable(
            "dom_layout_excludes_use_dom", "syntax-tree",
            "no file has a confirmed 'use dom' directive -- this rule only applies once a real "
            "DOM component exists",
        )
    if not layout_paths:
        return _not_applicable("dom_layout_excludes_use_dom", "syntax-tree", "no _layout files found")
    return _passed(
        "dom_layout_excludes_use_dom", "syntax-tree",
        f"{len(confirmed)} confirmed DOM component(s); none of {len(layout_paths)} _layout file(s) "
        "has a confirmed 'use dom' directive",
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


@register(
    "expo_ui_no_host_from_subpackage",
    category="lexical",
    description="expo-ui rule: Host must always be imported from the '@expo/ui' root, never from "
    "a platform-specific subpackage. Converted from a declarative text_absent check (third review "
    "round): a bare absence check vacuously passed for apps that never imported @expo/ui at all, "
    "so this is now not_applicable unless the app actually imports @expo/ui somewhere.",
)
def _expo_ui_no_host_from_subpackage(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if _EXPO_UI_HOST_FROM_SUBPACKAGE_RE.search(strip_comments(text)):
            return _failed(
                "expo_ui_no_host_from_subpackage", "lexical",
                f"{path}: imports Host from a platform-specific @expo/ui subpackage",
            )
    if not _expo_ui_imported(app_tree):
        return _not_applicable(
            "expo_ui_no_host_from_subpackage", "lexical",
            "no @expo/ui import found -- this rule only applies once the skill is engaged",
        )
    return _passed(
        "expo_ui_no_host_from_subpackage", "lexical",
        "no file imports Host from a platform-specific @expo/ui subpackage",
    )


@register(
    "expo_ui_platform_specific_trees_not_in_app_dir",
    category="structural",
    description="expo-ui rule: platform-specific @expo/ui trees must live in components/, never "
    "under app/ -- Expo Router doesn't support platform extensions for route files. Converted "
    "from a declarative path_absent check (third review round): same vacuous-pass problem as "
    "expo_ui_no_host_from_subpackage above.",
)
def _expo_ui_platform_specific_trees_not_in_app_dir(app_tree: AppTree) -> CheckResult:
    matches = app_tree.glob_any(_EXPO_UI_PLATFORM_TREE_GLOBS)
    if matches:
        return _failed(
            "expo_ui_platform_specific_trees_not_in_app_dir", "structural",
            f"forbidden path exists: {matches[0].relative_to(app_tree.root)}",
        )
    if not _expo_ui_imported(app_tree):
        return _not_applicable(
            "expo_ui_platform_specific_trees_not_in_app_dir", "structural",
            "no @expo/ui import found -- this rule only applies once the skill is engaged",
        )
    return _passed(
        "expo_ui_platform_specific_trees_not_in_app_dir", "structural",
        f"no path matched any of {_EXPO_UI_PLATFORM_TREE_GLOBS!r}",
    )


@register(
    "data_fetching_no_axios",
    category="lexical",
    description="expo-data-fetching rule: avoid axios, prefer the built-in fetch (or expo/fetch). "
    "Converted from a declarative text_absent check (third review round): a bare absence check "
    "vacuously passed for apps with no observable data-fetching behavior at all. Finding axios "
    "itself is always scored (importing it is proof the app engaged with data fetching, even if "
    "the wrong way); a clean pass additionally requires observable fetch/query-lib usage as "
    "independent proof of engagement -- otherwise not_applicable.",
)
def _data_fetching_no_axios(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if _AXIOS_IMPORT_RE.search(strip_comments(text)):
            return _failed("data_fetching_no_axios", "lexical", f"{path}: imports axios")
    engaged = any(
        pattern.search(strip_comments(text))
        for text in app_tree.files.values()
        for pattern in _FETCH_OR_QUERY_LIB_RES
    )
    if not engaged:
        return _not_applicable(
            "data_fetching_no_axios", "lexical",
            "no observable data-fetching behavior (no fetch/query-lib usage, no axios import)",
        )
    return _passed(
        "data_fetching_no_axios", "lexical",
        "data-fetching behavior observed via fetch/query-lib usage, and no axios import found",
    )


@register(
    "native_ui_no_expo_av",
    category="lexical",
    description="expo-native-ui rule: expo-av is removed -- use expo-audio/expo-video instead. "
    "Fourth review round: gated on this feature's OWN positive replacement (expo-audio/expo-video "
    "usage), not a shared skill-wide signal -- using react-native-safe-area-context or "
    "useWindowDimensions says nothing about whether the app made a correct media choice. Finding "
    "expo-av itself is always scored regardless of gating, since importing it is proof this "
    "feature area was engaged.",
)
def _native_ui_no_expo_av(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if _EXPO_AV_IMPORT_RE.search(strip_comments(text)):
            return _failed("native_ui_no_expo_av", "lexical", f"{path}: imports expo-av")
    engaged = any(
        pattern.search(strip_comments(text))
        for text in app_tree.files.values()
        for pattern in _EXPO_AUDIO_OR_VIDEO_IMPORT_RES
    )
    if not engaged:
        return _not_applicable(
            "native_ui_no_expo_av", "lexical",
            "no observable audio/video implementation (no expo-audio/expo-video usage)",
        )
    return _passed("native_ui_no_expo_av", "lexical", "uses expo-audio/expo-video and does not import expo-av")


@register(
    "native_ui_no_dimensions_get",
    category="lexical",
    description="expo-native-ui rule: use useWindowDimensions, not Dimensions.get(). Fourth review "
    "round: gated on this feature's OWN positive replacement (useWindowDimensions usage), not a "
    "shared skill-wide signal -- see native_ui_no_expo_av above for why. Finding Dimensions.get() "
    "itself is always scored regardless of gating.",
)
def _native_ui_no_dimensions_get(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if _DIMENSIONS_GET_RE.search(strip_comments(text)):
            return _failed("native_ui_no_dimensions_get", "lexical", f"{path}: calls Dimensions.get()")
    engaged = any(_USE_WINDOW_DIMENSIONS_RE.search(strip_comments(text)) for text in app_tree.files.values())
    if not engaged:
        return _not_applicable(
            "native_ui_no_dimensions_get", "lexical",
            "no observable window measurement (no useWindowDimensions() usage)",
        )
    return _passed(
        "native_ui_no_dimensions_get", "lexical",
        "uses useWindowDimensions() and does not call Dimensions.get()",
    )


@register(
    "native_ui_no_safe_area_view_from_react_native",
    category="lexical",
    description="expo-native-ui rule: use react-native-safe-area-context, not react-native's own "
    "SafeAreaView. Fourth review round: gated on this feature's OWN positive replacement "
    "(react-native-safe-area-context usage), not a shared skill-wide signal -- see "
    "native_ui_no_expo_av above for why. Anchored to the import statement (not a bare word match) "
    "to avoid flagging the correct import from react-native-safe-area-context. Finding SafeAreaView "
    "imported from react-native itself is always scored regardless of gating.",
)
def _native_ui_no_safe_area_view_from_react_native(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if _SAFE_AREA_VIEW_FROM_REACT_NATIVE_RE.search(strip_comments(text)):
            return _failed(
                "native_ui_no_safe_area_view_from_react_native", "lexical",
                f"{path}: imports SafeAreaView from react-native",
            )
    engaged = any(_SAFE_AREA_CONTEXT_IMPORT_RE.search(strip_comments(text)) for text in app_tree.files.values())
    if not engaged:
        return _not_applicable(
            "native_ui_no_safe_area_view_from_react_native", "lexical",
            "no observable safe-area handling (no react-native-safe-area-context usage)",
        )
    return _passed(
        "native_ui_no_safe_area_view_from_react_native", "lexical",
        "uses react-native-safe-area-context and does not import SafeAreaView from react-native",
    )


@register(
    "router_no_direct_react_navigation_import",
    category="lexical",
    description="SDK 56+ rule: never import @react-navigation/* directly -- use expo-router/"
    "react-navigation instead. Converted from a declarative text_absent check (third review "
    "round): shared by expo-router and expo-native-ui, and a bare absence check vacuously passed "
    "for an app with zero navigation engagement of any kind. Gated on an expo-router import "
    "(virtually always present in a real expo-router app, so this rarely changes expo-router's "
    "own scoring) -- finding a direct @react-navigation import is itself scored regardless of "
    "gating, since importing it is proof of navigation engagement.",
)
def _router_no_direct_react_navigation_import(app_tree: AppTree) -> CheckResult:
    for path, text in app_tree.files.items():
        if _REACT_NAVIGATION_IMPORT_RE.search(strip_comments(text)):
            return _failed(
                "router_no_direct_react_navigation_import", "lexical",
                f"{path}: imports @react-navigation/* directly",
            )
    engaged = any(_EXPO_ROUTER_IMPORT_RE.search(strip_comments(text)) for text in app_tree.files.values())
    if not engaged:
        return _not_applicable(
            "router_no_direct_react_navigation_import", "lexical",
            "no expo-router import found -- this rule only applies once the app engages with routing",
        )
    return _passed(
        "router_no_direct_react_navigation_import", "lexical",
        "no file imports @react-navigation/* directly",
    )
