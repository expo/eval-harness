"""Atomic uptake-check registry.

Design: checks are deliberately NOT owned by a skill. Each check verifies one
durable, skill-agnostic fact about the authored source (or, for a future
code-driven category, about running a real tool against it). `skill_map.json`
is the only place that says "skill X currently cares about checks [A, B, C]"
-- when skills get renamed, merged, or split later, only that mapping needs
to change; the checks themselves don't move. See dataset/prd_skills.json for
the separate, PRD-level question of which skills an app should trigger at
all.

Two kinds of checks share one `Check` shape so `skill_map.json` never needs to
know which backs a given id:
  - data-driven (category: lexical/structural): declared in checks_data.json,
    interpreted by the generic `run_check` dispatch below (kinds: import,
    text, text_any, text_absent, path_exists, path_absent,
    package_dependency).
  - code-driven (e.g. a future syntax-tree/route-graph category): registered
    via the `@register` decorator with a real `run(app_tree)` function --
    none currently exist (see checks_data.json's header comment), but the
    dispatch already treats them identically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
import re
from typing import Any, Callable

from ..utils import read_json


SOURCE_SUFFIXES = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}
# "scripts" is tooling, not app code (expo-project-structure's own SKILL.md
# lists it as living outside src/, alongside app.json/eas.json/package.json).
# Verified against a real authored app: create-expo-app's standard
# scripts/reset-project.js embeds example code as string template literals
# (e.g. a literal `import { Stack } from "expo-router"` inside a JS template
# string it writes out) that would otherwise satisfy lexical checks with zero
# real implementation anywhere in the actual app.
SKIP_DIR_PARTS = {"node_modules", ".git", ".expo", "ios", "android", "build", "dist", "scripts"}
SKIP_FILENAMES = {
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
}

_LINE_COMMENT_RE = re.compile(r"//.*")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def _strip_comments(text: str) -> str:
    """Best-effort JS/TS comment stripping. Not a real parser (doesn't
    understand `//`/`/*` inside strings or template literals), but closes the
    common false-positive case: a stray `// TODO: add loading state` comment
    with no real implementation satisfying a check."""
    return _LINE_COMMENT_RE.sub("", _BLOCK_COMMENT_RE.sub("", text))


@dataclass
class CheckResult:
    id: str
    category: str
    kind: str
    target: Any
    passed: bool
    evidence: str


@dataclass
class Check:
    id: str
    category: str
    kind: str
    target: Any = None
    description: str = ""
    run: Callable[["AppTree"], CheckResult] | None = None  # set only for code-driven checks


class AppTree:
    """Lazily-read source-file view over an authored app's directory, shared
    across every check in a run so each file is only read from disk once."""

    def __init__(self, app_dir: Path):
        self.root = Path(app_dir)
        self._files: dict[Path, str] | None = None

    @property
    def files(self) -> dict[Path, str]:
        if self._files is None:
            self._files = self._read_source_files()
        return self._files

    def _read_source_files(self) -> dict[Path, str]:
        files: dict[Path, str] = {}
        for path in self.root.rglob("*"):
            if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
                continue
            if path.name in SKIP_FILENAMES:
                continue
            if any(part in SKIP_DIR_PARTS for part in path.parts):
                continue
            try:
                files[path.relative_to(self.root)] = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
        return files

    def glob_any(self, patterns: list[str]) -> list[Path]:
        matches: list[Path] = []
        for pattern in patterns:
            for path in sorted(self.root.glob(pattern)):
                if any(part in SKIP_DIR_PARTS for part in path.relative_to(self.root).parts):
                    continue
                matches.append(path)
        return matches


@dataclass
class UptakeResults:
    checks: list[CheckResult] = field(default_factory=list)

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

    def category_breakdown(self) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for c in self.checks:
            bucket = out.setdefault(c.category, {"passed": 0, "total": 0})
            bucket["total"] += 1
            if c.passed:
                bucket["passed"] += 1
        return out


# --- code-driven check registration -----------------------------------

_CODE_REGISTRY: dict[str, Check] = {}


def register(check_id: str, category: str, description: str = ""):
    """Decorator for code-driven checks: fn(app_tree: AppTree) -> CheckResult."""

    def decorator(fn: Callable[[AppTree], CheckResult]):
        _CODE_REGISTRY[check_id] = Check(id=check_id, category=category, kind="code", description=description, run=fn)
        return fn

    return decorator


# --- loading ------------------------------------------------------------

def load_checks_data(checks_dir: Path | str) -> dict[str, Check]:
    """Load the declarative (lexical/structural) checks from checks_data.json,
    indexed by id."""
    path = Path(checks_dir) / "checks_data.json"
    if not path.exists():
        return {}
    data = read_json(path)
    out: dict[str, Check] = {}
    for entry in data.get("checks", []):
        check = Check(
            id=str(entry["id"]),
            category=str(entry["category"]),
            kind=str(entry["kind"]),
            target=entry["target"],
            description=str(entry.get("description", "")),
        )
        out[check.id] = check
    return out


def load_skill_map(checks_dir: Path | str) -> dict[str, list[str]]:
    """skill id -> [check id, ...]. The only file coupled to the current
    skill taxonomy; everything else in this package is skill-agnostic.
    Keys starting with "_" (e.g. "_comment") are metadata, not skill ids."""
    path = Path(checks_dir) / "skill_map.json"
    if not path.exists():
        return {}
    return {str(k): list(v) for k, v in read_json(path).items() if not str(k).startswith("_")}


def all_checks(checks_dir: Path | str) -> dict[str, Check]:
    """Data-driven checks merged with every code-driven (@register) check,
    into one id -> Check lookup."""
    merged = dict(_CODE_REGISTRY)
    merged.update(load_checks_data(checks_dir))
    return merged


def resolve_checks_for_skills(expected_skills: list[str], checks_dir: Path | str) -> tuple[list[Check], list[str]]:
    """Every check mapped (via skill_map.json) to any of expected_skills,
    deduped. A skill absent from skill_map.json (or a mapped id missing from
    the registry) produces a warning, not a crash -- same degrade-don't-crash
    philosophy as the rest of this evaluator."""
    skill_map = load_skill_map(checks_dir)
    registry = all_checks(checks_dir)
    warnings: list[str] = []
    seen: set[str] = set()
    checks: list[Check] = []
    for skill_id in expected_skills:
        check_ids = skill_map.get(skill_id)
        if check_ids is None:
            warnings.append(f"no uptake checks mapped for skill {skill_id!r}")
            continue
        for check_id in check_ids:
            if check_id in seen:
                continue
            check = registry.get(check_id)
            if check is None:
                warnings.append(f"skill_map references unknown check id {check_id!r}")
                continue
            seen.add(check_id)
            checks.append(check)
    return checks, warnings


# --- running --------------------------------------------------------------

def run_checks(checks: list[Check], app_dir: Path | str) -> list[CheckResult]:
    app_tree = AppTree(Path(app_dir))
    return [run_check(check, app_tree) for check in checks]


def run_check(check: Check, app_tree: AppTree) -> CheckResult:
    if check.run is not None:
        return check.run(app_tree)
    kind = check.kind
    if kind == "import":
        return _check_import(check, app_tree)
    if kind == "text":
        return _check_text(check, app_tree)
    if kind == "text_any":
        return _check_text_any(check, app_tree)
    if kind == "text_absent":
        return _check_text_absent(check, app_tree)
    if kind == "path_exists":
        return _check_path_exists(check, app_tree)
    if kind == "path_absent":
        return _check_path_absent(check, app_tree)
    if kind == "package_dependency":
        return _check_package_dependency(check, app_tree)
    raise ValueError(f"Unknown check kind {kind!r} for check {check.id!r}")


def _result(check: Check, passed: bool, evidence: str) -> CheckResult:
    return CheckResult(check.id, check.category, check.kind, check.target, passed, evidence)


def _check_import(check: Check, app_tree: AppTree) -> CheckResult:
    target = str(check.target)
    needles = [f"from '{target}'", f'from "{target}"', f"require('{target}')", f'require("{target}")']
    for path, text in app_tree.files.items():
        if any(n in _strip_comments(text) for n in needles):
            return _result(check, True, f"{path}: imports {target}")
    return _result(check, False, f"No source file imports {target}")


def _check_text(check: Check, app_tree: AppTree) -> CheckResult:
    pattern = re.compile(str(check.target))
    for path, text in app_tree.files.items():
        if pattern.search(_strip_comments(text)):
            return _result(check, True, f"{path}: matches {check.target!r}")
    return _result(check, False, f"No source file matches {check.target!r}")


def _check_text_any(check: Check, app_tree: AppTree) -> CheckResult:
    options = check.target if isinstance(check.target, list) else [check.target]
    for option in options:
        pattern = re.compile(str(option))
        for path, text in app_tree.files.items():
            if pattern.search(_strip_comments(text)):
                return _result(check, True, f"{path}: matches {option!r}")
    return _result(check, False, f"No source file matches any of {options!r}")


def _check_text_absent(check: Check, app_tree: AppTree) -> CheckResult:
    pattern = re.compile(str(check.target))
    for path, text in app_tree.files.items():
        if pattern.search(_strip_comments(text)):
            return _result(check, False, f"{path}: contains forbidden {check.target!r}")
    return _result(check, True, f"No source file contains forbidden {check.target!r}")


def _check_path_exists(check: Check, app_tree: AppTree) -> CheckResult:
    patterns = check.target if isinstance(check.target, list) else [check.target]
    matches = app_tree.glob_any([str(p) for p in patterns])
    if matches:
        return _result(check, True, f"found {matches[0].relative_to(app_tree.root)}")
    return _result(check, False, f"no path matched any of {patterns!r}")


def _check_path_absent(check: Check, app_tree: AppTree) -> CheckResult:
    patterns = check.target if isinstance(check.target, list) else [check.target]
    matches = app_tree.glob_any([str(p) for p in patterns])
    if matches:
        return _result(check, False, f"forbidden path exists: {matches[0].relative_to(app_tree.root)}")
    return _result(check, True, f"no path matched any of {patterns!r}")


def _check_package_dependency(check: Check, app_tree: AppTree) -> CheckResult:
    target = str(check.target)
    pkg = app_tree.root / "package.json"
    if not pkg.exists():
        return _result(check, False, "package.json is missing")
    data = json.loads(pkg.read_text(encoding="utf-8"))
    deps: dict[str, str] = {}
    deps.update(data.get("dependencies") or {})
    deps.update(data.get("devDependencies") or {})
    passed = target in deps
    return _result(check, passed, f"package.json {'contains' if passed else 'does not contain'} {target}")
