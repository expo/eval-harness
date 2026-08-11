#!/usr/bin/env python3
"""Keep iOS producer evidence physical, minimal, and confined to its root."""

from __future__ import annotations

import os
import re
import shutil
import stat
import sys
from pathlib import Path


ROOT_FILES = {"result.json", "report.html"}
ROOT_DIRS = {"traces", "telemetry", "logs"}
LOG_FILES = {
    "collect-evaluator-trace.log",
    "d-devclient.log",
    "d-devclient-config.log",
    "d-expo-config.err",
    "d-expo-run-ios-help.log",
    "d-ios-identity-adjustments.json",
    "d-ios-identity-normalize.log",
    "s1-agent-device.log",
    "s2-maestro.log",
    "s3-uv.log",
    "s4-boot.log",
    "s4-runner.log",
    "s4-simctl-devices.err",
    "s5-npm.log",
    "s6-metro.log",
    "s6-devbuild.log",
    "s6-release.log",
    "s6b-alert.log",
    "s6b-open.log",
    "s6b-snap.log",
    "s7-eval.log",
}
PLAN_FILES = {"summary.json", "conversation.jsonl", "console.log"}
OTEL_PAYLOAD = re.compile(r"^[0-9]+_[A-Za-z0-9_]+\.pb$")


def lstat_or_none(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def remove_node(path: Path) -> None:
    info = lstat_or_none(path)
    if info is None:
        return
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        shutil.rmtree(path)
    else:
        path.unlink()


def is_physical_directory(path: Path) -> bool:
    info = lstat_or_none(path)
    return info is not None and stat.S_ISDIR(info.st_mode)


def is_single_link_regular(path: Path) -> bool:
    info = lstat_or_none(path)
    return (
        info is not None
        and stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
    )


def ensure_physical_directory(path: Path) -> None:
    if is_physical_directory(path):
        return
    remove_node(path)
    path.mkdir(parents=True, exist_ok=False)


def prepare(out: Path) -> None:
    for name in ROOT_DIRS:
        ensure_physical_directory(out / name)
    for name in ("result.json", "result.html", "report.html"):
        path = out / name
        if lstat_or_none(path) is not None and not is_single_link_regular(path):
            remove_node(path)


def copy_regular(source: Path, destination: Path) -> None:
    if not is_single_link_regular(source):
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def copy_trace(source: Path, destination_root: Path) -> None:
    if not is_physical_directory(source):
        return
    ensure_physical_directory(destination_root)
    destination = destination_root / source.name
    remove_node(destination)
    destination.mkdir()
    for name in PLAN_FILES:
        copy_regular(source / name, destination / name)
    screenshots = source / "screenshots"
    if not is_physical_directory(screenshots):
        return
    destination_screenshots = destination / "screenshots"
    for entry in screenshots.iterdir():
        if entry.name.lower().endswith(".png") and is_single_link_regular(entry):
            copy_regular(entry, destination_screenshots / entry.name)


def prune_directory(path: Path, allowed_files: set[str]) -> None:
    ensure_physical_directory(path)
    for entry in path.iterdir():
        if entry.name in allowed_files and is_single_link_regular(entry):
            continue
        remove_node(entry)


def prune_plan_traces(path: Path) -> None:
    ensure_physical_directory(path)
    for plan in path.iterdir():
        if not is_physical_directory(plan):
            remove_node(plan)
            continue
        for entry in plan.iterdir():
            if entry.name in PLAN_FILES and is_single_link_regular(entry):
                continue
            if entry.name == "screenshots" and is_physical_directory(entry):
                for screenshot in entry.iterdir():
                    if (
                        screenshot.name.lower().endswith(".png")
                        and is_single_link_regular(screenshot)
                    ):
                        continue
                    remove_node(screenshot)
                continue
            remove_node(entry)


def prune_traces(path: Path) -> None:
    ensure_physical_directory(path)
    for entry in path.iterdir():
        if entry.name == "agentic-evaluator.json" and is_single_link_regular(entry):
            continue
        if entry.name == "test-plans" and is_physical_directory(entry):
            prune_plan_traces(entry)
            continue
        remove_node(entry)


def prune_telemetry(path: Path) -> None:
    ensure_physical_directory(path)
    for entry in path.iterdir():
        if entry.name == "anthropic.jsonl" and is_single_link_regular(entry):
            continue
        if entry.name == "otel" and is_physical_directory(entry):
            for payload in entry.iterdir():
                allowed = payload.name == "index.jsonl" or OTEL_PAYLOAD.fullmatch(payload.name)
                if allowed and is_single_link_regular(payload):
                    continue
                remove_node(payload)
            continue
        remove_node(entry)


def finalize(out: Path) -> None:
    prune_directory(out / "logs", LOG_FILES)
    prune_traces(out / "traces")
    prune_telemetry(out / "telemetry")
    for entry in out.iterdir():
        if entry.name in ROOT_FILES and is_single_link_regular(entry):
            continue
        if entry.name in ROOT_DIRS and is_physical_directory(entry):
            continue
        remove_node(entry)


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: sanitize_ios_artifact.py prepare|finalize|copy-trace PATH [DEST]", file=sys.stderr)
        return 2
    command = argv[1]
    path = Path(argv[2])
    if command == "prepare" and len(argv) == 3:
        prepare(path)
    elif command == "finalize" and len(argv) == 3:
        finalize(path)
    elif command == "copy-trace" and len(argv) == 4:
        copy_trace(path, Path(argv[3]))
    else:
        print("invalid sanitize_ios_artifact.py invocation", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
