"""Static context-uptake checks over generated Expo app source trees."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any


SOURCE_SUFFIXES = {".js", ".jsx", ".ts", ".tsx", ".json", ".mjs", ".cjs"}
SKIP_FILENAMES = {
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
}


@dataclass
class StaticCheckResult:
    id: str
    kind: str
    target: str
    passed: bool
    evidence: str


@dataclass
class StaticUptakeResult:
    checks: list[StaticCheckResult]

    @property
    def passed(self) -> int:
        return sum(1 for c in self.checks if c.passed)

    @property
    def total(self) -> int:
        return len(self.checks)

    @property
    def uptake_rate(self) -> float | None:
        if not self.checks:
            return None
        return round(self.passed / self.total, 4)


def run_static_checks(app_dir: Path | str, checks: list[dict[str, Any]]) -> StaticUptakeResult:
    app_dir = Path(app_dir)
    files = _read_source_files(app_dir)
    results = [run_static_check(app_dir, files, check) for check in checks]
    return StaticUptakeResult(results)


def run_static_check(app_dir: Path, files: dict[Path, str], check: dict[str, Any]) -> StaticCheckResult:
    check_id = str(check["id"])
    kind = str(check["kind"])
    target = str(check["target"])
    if kind == "import":
        return _check_import(check_id, kind, target, files)
    if kind == "text":
        return _check_text(check_id, kind, target, files)
    if kind == "text_any":
        return _check_text_any(check_id, kind, target, files)
    if kind == "text_absent":
        return _check_text_absent(check_id, kind, target, files)
    if kind == "file_exists":
        exists = (app_dir / target).exists()
        return StaticCheckResult(check_id, kind, target, exists, f"{target} {'exists' if exists else 'is missing'}")
    if kind == "package_dependency":
        return _check_package_dependency(check_id, kind, target, app_dir)
    raise ValueError(f"Unknown static check kind: {kind}")


def _check_import(check_id: str, kind: str, target: str, files: dict[Path, str]) -> StaticCheckResult:
    needles = [f"from '{target}'", f'from "{target}"', f"require('{target}')", f'require("{target}")']
    for path, text in files.items():
        if any(n in text for n in needles):
            return StaticCheckResult(check_id, kind, target, True, f"{path}: imports {target}")
    return StaticCheckResult(check_id, kind, target, False, f"No source file imports {target}")


def _check_text(check_id: str, kind: str, target: str, files: dict[Path, str]) -> StaticCheckResult:
    for path, text in files.items():
        if target in text:
            return StaticCheckResult(check_id, kind, target, True, f"{path}: contains {target!r}")
    return StaticCheckResult(check_id, kind, target, False, f"No source file contains {target!r}")


def _check_text_any(check_id: str, kind: str, target: str, files: dict[Path, str]) -> StaticCheckResult:
    options = [part for part in target.split("|") if part]
    for option in options:
        for path, text in files.items():
            if option in text:
                return StaticCheckResult(check_id, kind, target, True, f"{path}: contains {option!r}")
    return StaticCheckResult(check_id, kind, target, False, f"No source file contains any of {options!r}")


def _check_text_absent(check_id: str, kind: str, target: str, files: dict[Path, str]) -> StaticCheckResult:
    for path, text in files.items():
        if target in text:
            return StaticCheckResult(check_id, kind, target, False, f"{path}: contains forbidden {target!r}")
    return StaticCheckResult(check_id, kind, target, True, f"No source file contains forbidden {target!r}")


def _check_package_dependency(check_id: str, kind: str, target: str, app_dir: Path) -> StaticCheckResult:
    pkg = app_dir / "package.json"
    if not pkg.exists():
        return StaticCheckResult(check_id, kind, target, False, "package.json is missing")
    data = json.loads(pkg.read_text(encoding="utf-8"))
    deps = {}
    deps.update(data.get("dependencies") or {})
    deps.update(data.get("devDependencies") or {})
    passed = target in deps
    return StaticCheckResult(
        check_id,
        kind,
        target,
        passed,
        f"package.json {'contains' if passed else 'does not contain'} {target}",
    )


def _read_source_files(app_dir: Path) -> dict[Path, str]:
    files: dict[Path, str] = {}
    skip_parts = {"node_modules", ".git", ".expo", "ios", "android", "build", "dist"}
    for path in app_dir.rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        if path.name in SKIP_FILENAMES:
            continue
        if any(part in skip_parts for part in path.parts):
            continue
        try:
            files[path.relative_to(app_dir)] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
    return files
