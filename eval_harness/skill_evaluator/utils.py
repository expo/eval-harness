"""Shared helpers for Expo skill evaluation."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import tarfile
from typing import Any


@dataclass
class SkillEvalCase:
    id: str
    feature_focus: str
    expected_skills: list[str]
    static_uptake_checks: list[dict[str, Any]]


def load_case_spec(path: Path | str) -> SkillEvalCase:
    path = Path(path)
    data = load_structured(path)
    required = [
        "id",
        "feature_focus",
        "expected_skills",
        "static_uptake_checks",
    ]
    missing = [key for key in required if key not in data]
    if missing:
        raise ValueError(f"{path} missing required fields: {', '.join(missing)}")
    return SkillEvalCase(
        id=str(data["id"]),
        feature_focus=str(data["feature_focus"]),
        expected_skills=list(data["expected_skills"]),
        static_uptake_checks=list(data["static_uptake_checks"]),
    )


def load_structured(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    if path.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except Exception as exc:
            raise RuntimeError("YAML case specs require PyYAML; use JSON or install yaml") from exc
        return yaml.safe_load(text)
    raise ValueError(f"Unsupported case spec extension: {path.suffix}")


def read_json(path: Path | str) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(data: dict[str, Any], path: Path | str) -> None:
    Path(path).write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def unpack_artifact(artifact_path: Path | str, dest_dir: Path | str) -> Path:
    """Return a directory containing an artifact's contents."""

    artifact_path = Path(artifact_path)
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    if artifact_path.is_dir():
        archive = first_archive(artifact_path)
        if archive:
            extract_tar(archive, dest_dir)
            return dest_dir
        return artifact_path
    extract_tar(artifact_path, dest_dir)
    return dest_dir


def first_archive(path: Path) -> Path | None:
    for pattern in ("*.tar.gz", "*.tgz", "*.tar"):
        matches = sorted(path.glob(pattern))
        if matches:
            return matches[0]
    return None


def extract_tar(path: Path, dest_dir: Path) -> None:
    dest_root = dest_dir.resolve()
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            target = (dest_root / member.name).resolve()
            if target != dest_root and dest_root not in target.parents:
                raise ValueError(f"Refusing to extract unsafe tar member: {member.name}")
        archive.extractall(dest_root)


def flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        out: list[str] = []
        for key, item in value.items():
            out.extend(flatten_strings(key))
            out.extend(flatten_strings(item))
        return out
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            out.extend(flatten_strings(item))
        return out
    return []


def dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out
