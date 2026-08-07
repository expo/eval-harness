"""Shared helpers for Expo skill evaluation."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import tarfile
import tempfile
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
    if artifact_path.is_dir():
        archive = first_archive(artifact_path)
        if archive:
            _replace_with_extracted_archive(archive, dest_dir)
            return dest_dir
        return artifact_path
    _replace_with_extracted_archive(artifact_path, dest_dir)
    return dest_dir


def _replace_with_extracted_archive(path: Path, dest_dir: Path) -> None:
    """Extract safely, then replace the evaluator-owned destination."""

    dest_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(
        tempfile.mkdtemp(
            prefix=f".{dest_dir.name}-extract-",
            dir=dest_dir.parent,
        )
    )
    try:
        extract_tar(path, staging_dir)
        if dest_dir.is_symlink() or dest_dir.is_file():
            dest_dir.unlink()
        elif dest_dir.exists():
            shutil.rmtree(dest_dir)
        staging_dir.replace(dest_dir)
    except BaseException:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise


def first_archive(path: Path) -> Path | None:
    for pattern in ("*.tar.gz", "*.tgz", "*.tar"):
        matches = sorted(path.glob(pattern))
        if matches:
            return matches[0]
    return None


def extract_tar(path: Path, dest_dir: Path) -> None:
    dest_root = dest_dir.resolve()
    dest_root.mkdir(parents=True, exist_ok=True)
    if any(dest_root.iterdir()):
        raise ValueError(
            f"Refusing to extract into non-empty destination: {dest_root}"
        )
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        archive_symlink_paths = {
            (dest_root / member.name).resolve()
            for member in members
            if member.issym()
        }
        for member in members:
            if not (
                member.isfile()
                or member.isdir()
                or member.issym()
                or member.islnk()
            ):
                raise ValueError(
                    f"Refusing to extract unsupported tar member: {member.name}"
                )
            target = (dest_root / member.name).resolve()
            if not _path_is_within(target, dest_root):
                raise ValueError(f"Refusing to extract unsafe tar member: {member.name}")
            if any(parent in archive_symlink_paths for parent in target.parents):
                raise ValueError(
                    f"Refusing to extract through archive symlink: {member.name}"
                )
            if member.issym():
                link_target = (target.parent / member.linkname).resolve()
                if not _path_is_within(link_target, dest_root):
                    raise ValueError(
                        f"Refusing to extract unsafe tar link: {member.name} -> {member.linkname}"
                    )
            elif member.islnk():
                link_target = (dest_root / member.linkname).resolve()
                if not _path_is_within(link_target, dest_root):
                    raise ValueError(
                        f"Refusing to extract unsafe tar link: {member.name} -> {member.linkname}"
                    )
        try:
            archive.extractall(dest_root, filter="data")
        except tarfile.FilterError as exc:
            raise ValueError(f"Refusing to extract unsafe tar member: {exc}") from exc


def _path_is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


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
