#!/usr/bin/env python3
"""Copy an authored run tree into a physical, transport-safe artifact tree."""

from __future__ import annotations

import json
import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path


WORKSPACE_EXCLUSIONS = (
    ("node_modules",),
    (".expo",),
    (".git",),
    (".cache",),
    (".eval-bundle-export-tmp",),
    (".mcp.json",),
    ("skills-lock.json",),
    (".agents", "skills"),
    (".claude", "skills"),
    ("agent", "skills"),
    ("ios", "Pods"),
    ("ios", "build"),
    ("ios", "DerivedData"),
    ("android", ".gradle"),
    ("android", "build"),
    ("android", "app", "build"),
)

METADATA_EXCLUSIONS = (
    ("codex-home",),
    ("muse-xdg-data",),
    ("muse-data",),
    ("muse-bin",),
    ("muse-settings",),
    ("muse-xdg-config",),
    ("bundle",),
    ("telemetry", "meta.jsonl"),
)


def within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def excluded(profile: str, relative: Path, source_name: str) -> bool:
    parts = relative.parts
    exclusions = WORKSPACE_EXCLUSIONS if profile == "workspace" else METADATA_EXCLUSIONS
    if profile == "metadata" and parts == (f"{source_name}.tgz",):
        return True
    return any(parts[: len(prefix)] == prefix for prefix in exclusions)


def write_actions(log_path: Path, actions: list[dict[str, str]]) -> None:
    parent_info = log_path.parent.lstat()
    if not stat.S_ISDIR(parent_info.st_mode) or log_path.parent.is_symlink():
        raise ValueError("sanitization log parent must be a physical directory")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(log_path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        for action in actions:
            handle.write(json.dumps(action, sort_keys=True) + "\n")
        if not actions:
            handle.write('{"action": "none", "path": "."}\n')


def sanitize(source: Path, destination: Path, log_path: Path, profile: str) -> None:
    if profile not in {"workspace", "metadata"}:
        raise ValueError("sanitization profile must be workspace or metadata")
    source_info = source.lstat()
    if not stat.S_ISDIR(source_info.st_mode) or source.is_symlink():
        raise ValueError("author source must be a physical directory")
    source_root = source.resolve(strict=True)
    destination_parent = destination.parent.resolve(strict=True)
    if destination.exists() or destination.is_symlink():
        raise ValueError("author artifact destination must not exist")

    actions: list[dict[str, str]] = []
    staging: Path | None = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}-sanitize-", dir=destination_parent)
    )

    def record(action: str, display_path: Path) -> None:
        try:
            relative = display_path.relative_to(source)
        except ValueError:
            relative = Path(".")
        actions.append({"action": action, "path": relative.as_posix()})

    def copy_node(
        current: Path,
        target: Path,
        ancestors: frozenset[tuple[int, int]],
        display_path: Path,
        policy_path: Path,
    ) -> None:
        relative = policy_path.relative_to(source_root)
        if excluded(profile, relative, source.name):
            record("removed_excluded", display_path)
            return
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            try:
                resolved = current.resolve(strict=True)
            except (FileNotFoundError, RuntimeError):
                record("removed_broken_symlink", display_path)
                return
            if not within(source_root, resolved):
                record("removed_external_symlink", display_path)
                return
            resolved_relative = resolved.relative_to(source_root)
            if excluded(profile, resolved_relative, source.name):
                record("removed_excluded_symlink", display_path)
                return
            resolved_info = resolved.stat()
            if not (stat.S_ISREG(resolved_info.st_mode) or stat.S_ISDIR(resolved_info.st_mode)):
                record("removed_special", display_path)
                return
            resolved_identity = (resolved_info.st_dev, resolved_info.st_ino)
            if stat.S_ISDIR(resolved_info.st_mode) and resolved_identity in ancestors:
                record("removed_cycle", display_path)
                return
            record("materialized_symlink", display_path)
            copy_node(resolved, target, ancestors, display_path, resolved)
            return

        if stat.S_ISDIR(info.st_mode):
            identity = (info.st_dev, info.st_ino)
            if identity in ancestors:
                record("removed_cycle", display_path)
                return
            # Build through a writable directory, then retain the authored
            # mode while keeping the collector owner's write/traverse bits.
            # This preserves readonly source trees without mutating them.
            target.mkdir(mode=0o700)
            nested_ancestors = ancestors | {identity}
            for child in sorted(current.iterdir(), key=lambda path: tuple(map(ord, path.name))):
                copy_node(
                    child,
                    target / child.name,
                    nested_ancestors,
                    display_path / child.name,
                    policy_path / child.name,
                )
            shutil.copystat(current, target, follow_symlinks=False)
            target.chmod(stat.S_IMODE(info.st_mode) | stat.S_IWUSR | stat.S_IXUSR)
            return

        if stat.S_ISREG(info.st_mode):
            shutil.copy2(current, target, follow_symlinks=False)
            if info.st_nlink > 1:
                record("materialized_hardlink", display_path)
            return

        record("removed_special", display_path)

    try:
        root_identity = (source_info.st_dev, source_info.st_ino)
        for child in sorted(source.iterdir(), key=lambda path: tuple(map(ord, path.name))):
            copy_node(
                child,
                staging / child.name,
                frozenset({root_identity}),
                source / child.name,
                source_root / child.name,
            )
        shutil.copystat(source, staging, follow_symlinks=False)
        staging.chmod(stat.S_IMODE(source_info.st_mode) | stat.S_IWUSR | stat.S_IXUSR)
        write_actions(log_path, actions)
        os.replace(staging, destination)
        staging = None
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            "usage: sanitize_author_workspace.py SOURCE DESTINATION LOG PROFILE",
            file=sys.stderr,
        )
        return 2
    try:
        sanitize(Path(argv[0]), Path(argv[1]), Path(argv[2]), argv[3])
    except Exception as error:
        print(f"author workspace sanitization failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
