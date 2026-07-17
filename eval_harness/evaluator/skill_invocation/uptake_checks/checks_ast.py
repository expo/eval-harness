"""Tier 3 (AST) uptake checks -- code-driven, registered via @register.

Needs real JS/JSX parsing, which Python can't do itself, so these shell out
to a small standalone Node/Babel script (scripts/parse-file-facts.js). That
script has its own package.json and gets `npm install`-ed once, lazily, on
first use -- it is NOT part of any authored app and needs no node_modules
from one; it's the evaluator's own tooling, same category as `uv` for the
Python side.
"""

from __future__ import annotations

from .node_parser import parse_file_facts
from .registry import CheckResult, register


# Every JSX tag expo-router accepts as a navigator/pass-through layout root.
# Verified against 4 real authored apps' _layout files: Stack and Tabs are
# common; Drawer showed up in a real app (expo-router/drawer) that a naive
# Stack/Tabs/NativeTabs-only list would have missed entirely.
_NAVIGATOR_TAGS = {"Stack", "Tabs", "NativeTabs", "Drawer", "Slot"}

_LAYOUT_GLOBS = ["app/**/_layout.*", "src/app/**/_layout.*", "app/_layout.*", "src/app/_layout.*"]


@register(
    "router_layout_defines_navigator",
    tier="T3",
    description=(
        "At least one _layout file's JSX tree actually renders a navigator "
        "(Stack/Tabs/NativeTabs/Drawer/Slot), not just imports one unused. "
        "Stronger than the tier-1 text_any check on the same tags: this "
        "parses real JSX structure, so a broken file or an unused import "
        "can't accidentally satisfy it."
    ),
)
def check_router_layout_defines_navigator(app_tree) -> CheckResult:
    check_id, tier, kind = "router_layout_defines_navigator", "T3", "code"
    layout_files = app_tree.glob_any(_LAYOUT_GLOBS)
    if not layout_files:
        return CheckResult(check_id, tier, kind, None, False, "no _layout file found")

    parse_failures = 0
    parse_errors = 0
    for path in layout_files:
        facts = parse_file_facts(path)
        if facts is None:
            parse_failures += 1
            continue
        if "error" in facts:
            parse_errors += 1
            continue
        matched = _NAVIGATOR_TAGS & set(facts.get("jsxTags", []))
        if matched:
            rel = path.relative_to(app_tree.root)
            return CheckResult(check_id, tier, kind, None, True, f"{rel}: renders {sorted(matched)}")

    if parse_failures == len(layout_files):
        return CheckResult(check_id, tier, kind, None, False, "AST parser unavailable (npm/node install failed)")
    if parse_errors:
        return CheckResult(
            check_id, tier, kind, None, False,
            f"no _layout file's JSX renders a navigator element ({parse_errors} file(s) had real syntax errors)",
        )
    return CheckResult(check_id, tier, kind, None, False, "no _layout file's JSX renders a navigator element")
