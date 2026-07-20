"""Node/Babel subprocess helper backing build_health's syntax_check, and
(via extract_ast_facts) uptake_checks/code_checks.py's syntax-tree checks.

"Is this file syntactically valid JS/TS/JSX" and "how many default exports
does it have" have no regex substitute -- that's the entire reason this
shells out to a real parser instead of being another pattern-matched check.
Shells out to scripts/check-syntax.js and scripts/extract-ast-facts.js (one
shared package.json, npm-installed lazily on first use, both scripts using
the same @babel/parser dependency rather than each getting their own). Not
part of any authored app's own dependencies -- this is the evaluator's own
tooling, same category as `uv` for the Python side.
"""

from __future__ import annotations

import json
from pathlib import Path
import subprocess


SCRIPTS_DIR = Path(__file__).parent / "scripts"
CHECK_SCRIPT = SCRIPTS_DIR / "check-syntax.js"
FACTS_SCRIPT = SCRIPTS_DIR / "extract-ast-facts.js"

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


def _run_script(script: Path, path: Path) -> dict | None:
    """Shared subprocess plumbing for every script in this directory: all of
    them print a JSON result on stdout for success, or a JSON
    {"error": ..., "message": ...} on stderr with a non-zero exit for a real
    (informative) failure. Returns None only if the parser couldn't run at
    all (missing node/npm, timeout, unparseable output) -- callers decide
    what "can't tell" means for their specific use rather than this raising."""
    if not ensure_node_deps_installed():
        return None
    try:
        result = subprocess.run(
            ["node", str(script), str(path)],
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


def check_file_syntax(path: Path) -> dict | None:
    """Returns {"ok": true} or {"error": "parse_error", "message": ...} --
    the latter is a real, informative result, not a failure to run."""
    return _run_script(CHECK_SCRIPT, path)


def extract_ast_facts(path: Path) -> dict | None:
    """Returns {"ok": true, "hasUseDomDirective": bool,
    "defaultExportCount": int, "reactNativeJsxElementsUsed": [str, ...]} --
    the facts a syntax-tree uptake check needs that regex can't verify
    (export counting, JSX elements bound to a specific import source).
    Backs uptake_checks/code_checks.py's expo-dom check; not part of
    build_health's own syntax/bundle/build cascade, just co-located here
    since it's the same Babel subprocess plumbing."""
    return _run_script(FACTS_SCRIPT, path)
