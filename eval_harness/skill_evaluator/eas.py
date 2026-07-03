"""EAS workflow metadata/log ingestion helpers."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from typing import Any


ARTIFACT_RE = re.compile(r"(gs://[^\s\"')]+|https?://[^\s\"')]+)")


@dataclass
class EasWorkflowRun:
    id: str
    status: str | None
    raw: dict[str, Any]


def extract_artifact_refs(log_text: str) -> list[str]:
    refs: list[str] = []
    seen: set[str] = set()
    for match in ARTIFACT_RE.finditer(log_text):
        ref = match.group(1).rstrip(".,")
        if ref not in seen:
            refs.append(ref)
            seen.add(ref)
    return refs


def list_workflow_runs(workflow: str | None = None, limit: int = 10) -> list[EasWorkflowRun]:
    cmd = ["eas", "workflow:runs", "--json", "--limit", str(limit)]
    if workflow:
        cmd.extend(["--workflow", workflow])
    data = _run_json(cmd)
    rows = data if isinstance(data, list) else data.get("runs", [])
    runs: list[EasWorkflowRun] = []
    for row in rows:
        run_id = str(row.get("id") or row.get("workflowRunId") or "")
        if run_id:
            runs.append(EasWorkflowRun(id=run_id, status=row.get("status"), raw=row))
    return runs


def view_workflow_run(run_id: str) -> dict[str, Any]:
    return _run_json(["eas", "workflow:view", run_id, "--json", "--non-interactive"])


def workflow_logs(run_id_or_job_id: str) -> str:
    proc = subprocess.run(
        ["eas", "workflow:logs", run_id_or_job_id, "--json", "--non-interactive", "--all-steps"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return proc.stdout
    return json.dumps(data)


def _run_json(cmd: list[str]) -> Any:
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout)
    return json.loads(proc.stdout)
