"""Shared helpers for Expo skill evaluation."""

from __future__ import annotations

import json
from pathlib import Path
import tarfile
from typing import Any


def load_prd_skills(path: Path | str) -> dict[str, list[str]]:
    """Load the app -> expected-skill-ids ground truth map (dataset/prd_skills.json)."""
    return {str(k): list(v) for k, v in read_json(path).items()}


def app_name_from_prd(prd_path: str) -> str | None:
    """Extract the app name from a `dataset/prds/<app>/prd/*.txt` style path."""
    parts = Path(prd_path).parts
    if "prds" in parts:
        idx = parts.index("prds")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return None


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
