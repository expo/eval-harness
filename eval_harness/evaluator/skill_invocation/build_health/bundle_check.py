"""Bundle half of the build-health cascade: does the whole app survive a
real Metro bundle (`expo export`)? Needs the authored app's own
node_modules, which the analysis-time artifact doesn't ship (excluded
before upload) -- so unlike syntax_check, this can NOT run at analysis
time. It runs once, at AUTHORING time (author-app.sh, right after the
coding agent stops, while node_modules still exists), and persists its
result as a small JSON file inside the workspace itself -- which DOES
survive into the artifact -- for analysis to read later.

CLI: python3 -m eval_harness.evaluator.skill_invocation.build_health.bundle_check <workspace-dir>
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys


RESULT_FILENAME = ".eval-build-health-bundle.json"
_TIMEOUT_SECONDS = 180


def compute_bundle_result(app_dir: Path) -> dict:
    """Never raises -- a failure to even invoke `expo export` (missing
    node_modules, timeout, etc.) is itself a result, not an exception."""
    expo_bin = app_dir / "node_modules" / ".bin" / "expo"
    if not expo_bin.exists():
        return {"ok": None, "reason": "no node_modules/.bin/expo in workspace"}

    export_dir = app_dir / ".eval-bundle-export-tmp"
    try:
        result = subprocess.run(
            [str(expo_bin), "export", "--platform", "ios", "--output-dir", str(export_dir)],
            cwd=app_dir,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": f"expo export timed out after {_TIMEOUT_SECONDS}s"}
    except Exception as exc:
        return {"ok": False, "reason": f"failed to invoke expo export: {exc}"}
    finally:
        shutil.rmtree(export_dir, ignore_errors=True)

    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "")[-1500:]
        return {"ok": False, "reason": tail}
    return {"ok": True}


def persist_bundle_result(app_dir: Path) -> dict:
    result = compute_bundle_result(app_dir)
    (app_dir / RESULT_FILENAME).write_text(json.dumps(result))
    return result


def read_bundle_result(app_dir: Path) -> dict | None:
    """Analysis-time read of the result persisted at authoring time. None
    means the authoring-time stage never ran (e.g. an artifact from before
    this feature existed) -- distinct from a real {"ok": False, ...}."""
    path = app_dir / RESULT_FILENAME
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


if __name__ == "__main__":
    workspace = Path(sys.argv[1])
    outcome = persist_bundle_result(workspace)
    print(f"bundle check: {outcome}")
