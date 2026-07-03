"""Analyze skill-eval inputs from unpacked EAS workflow artifacts."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
import shutil
import tarfile
from typing import Any

from .aggregate import aggregate_skill_results
from .manifest import load_case_spec
from .metrics import classify_skill, score_case_run
from .report import write_html_report, write_json_report
from .static_checks import run_static_checks
from .trace import detect_triggered_skills, load_trace


TRACE_CANDIDATES = (
    "claude-code-authoring.json",
    "claude-authoring.json",
    "codex-authoring.json",
    "claude-code.json",
    "claude.json",
    "codex.json",
)


@dataclass
class ArtifactLayout:
    root: Path
    app_dir: Path | None
    trace_path: Path | None
    manifest_path: Path | None
    result_path: Path | None
    screenshots: list[Path]


def unpack_artifact(artifact_path: Path | str, dest_dir: Path | str) -> Path:
    """Return a directory containing an artifact's contents.

    EAS download_artifact may yield either a tarball path, a directory containing
    the tarball, or a directory already containing the unpacked files.
    """

    artifact_path = Path(artifact_path)
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    if artifact_path.is_dir():
        archive = _first_archive(artifact_path)
        if archive:
            _extract_tar(archive, dest_dir)
            return dest_dir
        return artifact_path
    _extract_tar(artifact_path, dest_dir)
    return dest_dir


def discover_artifact_layout(root: Path | str) -> ArtifactLayout:
    root = Path(root)
    return ArtifactLayout(
        root=root,
        app_dir=_find_app_dir(root),
        trace_path=_find_trace(root),
        manifest_path=_first_existing(root, ["bundle/manifest.json", "manifest.json"], "manifest.json"),
        result_path=_first_existing(root, ["bundle/eval/result.json", "eval/result.json", "result.json"], "result.json"),
        screenshots=_find_screenshots(root),
    )


def analyze_artifact_inputs(
    case_spec: Path | str,
    authored_artifact: Path | str,
    eval_artifact: Path | str | None,
    scenario: str,
    out_dir: Path | str,
) -> dict[str, Any]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    case = load_case_spec(case_spec)
    author_layout = discover_artifact_layout(authored_artifact)
    eval_layout = discover_artifact_layout(eval_artifact) if eval_artifact else None
    warnings: list[str] = []

    if author_layout.app_dir is None:
        warnings.append("app tree not found")
        static = None
        static_passed = 0
        static_total = len(case.static_uptake_checks)
        static_rows: list[dict[str, Any]] = []
    else:
        static = run_static_checks(author_layout.app_dir, case.static_uptake_checks)
        static_passed = static.passed
        static_total = static.total
        static_rows = [asdict(check) for check in static.checks]

    if author_layout.trace_path is None:
        warnings.append("author trace not found")
        trace = {}
    else:
        trace = load_trace(author_layout.trace_path)
    triggered = detect_triggered_skills(trace)

    result_path = eval_layout.result_path if eval_layout else None
    evaluator_pct = _read_evaluator_pct(result_path) if result_path else None
    build_success = True if result_path else None
    score = score_case_run(
        expected_skills=case.expected_skills,
        triggered_skills=triggered,
        static_passed=static_passed,
        static_total=static_total,
        evaluator_pct=evaluator_pct,
        build_success=build_success,
        visual_quality=None,
    )
    uptake = score.context_uptake.uptake_rate
    outcome_status = "complete" if evaluator_pct is not None else "pending"
    if outcome_status == "pending":
        classification = "Outcome pending"
    else:
        classification = classify_skill(
            score.trigger_quality.recall,
            score.trigger_quality.precision,
            uptake,
            evaluator_pct or 0.0,
            1.0 if build_success else 0.0,
        )

    screenshots = _copy_screenshots((eval_layout.screenshots if eval_layout else []), out_dir / "screenshots")
    run = {
        "case_id": case.id,
        "scenario": scenario,
        "skill_id": ",".join(case.expected_skills),
        "classification": classification,
        "trigger_recall": score.trigger_quality.recall,
        "trigger_precision": score.trigger_quality.precision,
        "uptake_rate": uptake,
        "evaluator_pct": evaluator_pct,
        "build_success": build_success,
    }
    payload = {
        "summary": f"Skill eval artifact analysis for {case.id}",
        "case": asdict(case),
        "scenario": scenario,
        "outcome_status": outcome_status,
        "warnings": warnings,
        "score": asdict(score),
        "static_checks": static_rows,
        "runs": [run],
        "skills": aggregate_skill_results([run]),
        "screenshots": screenshots,
        "artifacts": {
            "authored_root": str(author_layout.root),
            "app_dir": str(author_layout.app_dir) if author_layout.app_dir else None,
            "author_trace": str(author_layout.trace_path) if author_layout.trace_path else None,
            "author_manifest": str(author_layout.manifest_path) if author_layout.manifest_path else None,
            "eval_root": str(eval_layout.root) if eval_layout else None,
            "eval_result": str(result_path) if result_path else None,
            "eval_manifest": str(eval_layout.manifest_path) if eval_layout and eval_layout.manifest_path else None,
        },
        "braintrust_refs": _collect_braintrust_refs(author_layout, eval_layout, trace),
    }
    if outcome_status == "pending":
        for skill in payload["skills"].values():
            skill["classification"] = "Outcome pending"
            skill["outcome_delta"] = None
    else:
        for skill in payload["skills"].values():
            if skill.get("baseline_evaluator_pct") is None:
                skill["classification"] = classification
    write_json_report(payload, out_dir / "metrics.json")
    write_html_report(payload, out_dir / "report.html")
    return payload


def _find_app_dir(root: Path) -> Path | None:
    direct = [root / "bundle" / "app", root / "app"]
    for path in direct:
        if (path / "package.json").exists():
            return path
    matches = sorted(root.glob("agent-workspace/*/package.json"))
    if matches:
        return matches[0].parent
    matches = sorted(root.rglob("package.json"))
    for match in matches:
        if "node_modules" not in match.parts:
            return match.parent
    return None


def _find_trace(root: Path) -> Path | None:
    for name in TRACE_CANDIDATES:
        matches = sorted(root.rglob(name))
        if matches:
            return matches[0]
    return None


def _first_existing(root: Path, preferred: list[str], filename: str) -> Path | None:
    for rel in preferred:
        path = root / rel
        if path.exists():
            return path
    matches = sorted(root.rglob(filename))
    return matches[0] if matches else None


def _find_screenshots(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.png") if "screenshots" in path.parts)


def _first_archive(path: Path) -> Path | None:
    for pattern in ("*.tar.gz", "*.tgz", "*.tar"):
        matches = sorted(path.glob(pattern))
        if matches:
            return matches[0]
    return None


def _extract_tar(path: Path, dest_dir: Path) -> None:
    with tarfile.open(path) as archive:
        archive.extractall(dest_dir)


def _read_evaluator_pct(path: Path) -> float | None:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("macro_avg_pct") is not None:
        return float(data["macro_avg_pct"])
    if data.get("micro_pct") is not None:
        return float(data["micro_pct"])
    return None


def _copy_screenshots(paths: list[Path], dest_dir: Path) -> list[dict[str, str]]:
    if not paths:
        return []
    dest_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in paths:
        dest = dest_dir / path.name
        if dest.exists():
            dest = dest_dir / f"{path.parent.name}-{path.name}"
        shutil.copy2(path, dest)
        rows.append({"label": path.name, "path": dest.relative_to(dest_dir.parent).as_posix()})
    return rows


def _collect_braintrust_refs(
    author_layout: ArtifactLayout,
    eval_layout: ArtifactLayout | None,
    trace: dict[str, Any],
) -> list[str]:
    values: list[str] = []
    for item in _flatten(trace):
        if "braintrust" in item.lower():
            values.append(item)
    for path in [
        author_layout.manifest_path,
        eval_layout.manifest_path if eval_layout else None,
    ]:
        if not path or not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for item in _flatten(data):
            if "braintrust" in item.lower():
                values.append(item)
    return _dedupe(values)


def _flatten(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        out: list[str] = []
        for key, item in value.items():
            out.extend(_flatten(key))
            out.extend(_flatten(item))
        return out
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            out.extend(_flatten(item))
        return out
    return []


def _dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out
