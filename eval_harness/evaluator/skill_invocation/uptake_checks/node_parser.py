"""Shared Node/Babel subprocess helpers, used by tier 3 (checks_ast.py) and
by the syntax half of build_health/ -- both need "parse this file for real,"
just for different purposes (JSX-tag inspection vs. plain pass/fail).

Shells out to scripts/parse-file-facts.js (its own package.json, npm-
installed lazily on first use). Not part of any authored app's own
dependencies -- this is the evaluator's own tooling, same category as `uv`
for the Python side.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess


SCRIPTS_DIR = Path(__file__).parent / "scripts"
PARSE_SCRIPT = SCRIPTS_DIR / "parse-file-facts.js"

_npm_install_done = False


def ensure_node_deps_installed() -> bool:
    """Lazily npm-installs the parser script's own dependencies, once per
    process. Returns False (never raises) if npm/node aren't available or
    the install fails -- callers must treat that as "can't run this check
    right now", not a crash."""
    global _npm_install_done
    if _npm_install_done:
        return True
    if (SCRIPTS_DIR / "node_modules").exists():
        _npm_install_done = True
        return True
    try:
        subprocess.run(
            ["npm", "install", "--silent"],
            cwd=SCRIPTS_DIR,
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )
    except Exception:
        return False
    _npm_install_done = True
    return True


def parse_file_facts(path: Path) -> dict | None:
    """Returns the parsed facts dict, or None if the parser itself couldn't
    run (missing node/npm, timeout, etc.) -- callers decide what "can't
    tell" means for their specific use rather than this raising. A genuine
    parse error is NOT None -- it's {"error": "parse_error", "message": ...},
    a real, informative result the caller can act on."""
    if not ensure_node_deps_installed():
        return None
    try:
        result = subprocess.run(
            ["node", str(PARSE_SCRIPT), str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception:
        return None
    if result.returncode != 0:
        try:
            return json.loads(result.stderr)
        except json.JSONDecodeError:
            return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
