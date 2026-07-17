"""Syntax half of the build-health cascade: does every source file in the
authored app actually parse? Cheapest, most generic signal available --
catches broken code before spending anything on a real bundle/build.

Deliberately NOT a per-skill check (no skill_map.json entry, doesn't go
through the uptake_checks registry) -- this is app-wide, independent of
which skill(s) were expected, so it surfaces as its own top-level
"build_health" key in metrics.json rather than a category under some skill.

Reuses uptake_checks.registry's source-file scanning (AppTree, same
node_modules/scripts/lockfile exclusions as the lexical checks) rather than
duplicating it -- that part is still genuinely shared, general-purpose
infrastructure, unlike the parser (which only this module uses now).
"""

from __future__ import annotations

from pathlib import Path

from .node_parser import check_file_syntax
from ..uptake_checks.registry import AppTree


def check_syntax(app_dir: Path) -> dict:
    app_tree = AppTree(app_dir)
    failed: list[dict] = []
    skipped_unavailable = 0
    for rel_path in app_tree.files:
        facts = check_file_syntax(app_dir / rel_path)
        if facts is None:
            skipped_unavailable += 1
            continue
        if "error" in facts:
            failed.append({"file": str(rel_path), "message": facts.get("message")})

    total = len(app_tree.files)
    checked = total - skipped_unavailable
    return {
        "total_files": total,
        "checked_files": checked,
        "skipped_unavailable": skipped_unavailable,
        "failed_files": failed,
        "ok": len(failed) == 0 if checked > 0 else None,
    }
