"""Tier 3 (AST) uptake checks -- code-driven, registered via @register.

Needs real JS/JSX parsing, which Python can't do itself, so these shell out
to a small standalone Node/Babel script (scripts/parse-file-facts.js). That
script has its own package.json and gets `npm install`-ed once, lazily, on
first use -- it is NOT part of any authored app and needs no node_modules
from one; it's the evaluator's own tooling, same category as `uv` for the
Python side.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess

from .registry import CheckResult, register


_SCRIPTS_DIR = Path(__file__).parent / "scripts"
_PARSE_SCRIPT = _SCRIPTS_DIR / "parse-file-facts.js"

# Every JSX tag expo-router accepts as a navigator/pass-through layout root.
# Verified against 4 real authored apps' _layout files: Stack and Tabs are
# common; Drawer showed up in a real app (expo-router/drawer) that a naive
# Stack/Tabs/NativeTabs-only list would have missed entirely.
_NAVIGATOR_TAGS = {"Stack", "Tabs", "NativeTabs", "Drawer", "Slot"}

_LAYOUT_GLOBS = ["app/**/_layout.*", "src/app/**/_layout.*", "app/_layout.*", "src/app/_layout.*"]

_npm_install_done = False


def _ensure_node_deps_installed() -> bool:
    """Lazily npm-installs the parser script's own dependencies, once per
    process. Returns False (never raises) if npm/node aren't available or
    the install fails -- callers must treat that as "can't run this check
    right now", not a crash."""
    global _npm_install_done
    if _npm_install_done:
        return True
    if (_SCRIPTS_DIR / "node_modules").exists():
        _npm_install_done = True
        return True
    try:
        subprocess.run(
            ["npm", "install", "--silent"],
            cwd=_SCRIPTS_DIR,
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )
    except Exception:
        return False
    _npm_install_done = True
    return True


def _parse_file_facts(path: Path) -> dict | None:
    """Returns the parsed facts dict, or None if the file doesn't parse (or
    the parser itself couldn't run) -- callers decide what "can't tell" means
    for their specific check rather than this raising."""
    if not _ensure_node_deps_installed():
        return None
    try:
        result = subprocess.run(
            ["node", str(_PARSE_SCRIPT), str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception:
        return None
    if result.returncode != 0:
        # A genuine parse error prints {"error": "parse_error", "message":
        # "..."} to stderr (see parse-file-facts.js) -- surface it as a real,
        # informative result, not the same "couldn't tell" None as a missing
        # node/npm. Callers key off the "error" field to distinguish this
        # from a passing parse.
        try:
            return json.loads(result.stderr)
        except json.JSONDecodeError:
            return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


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
        facts = _parse_file_facts(path)
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
