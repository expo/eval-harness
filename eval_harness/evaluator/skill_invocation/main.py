"""Command-line entry point for Expo skill evaluation helpers."""

from __future__ import annotations

import argparse
from pathlib import Path

from .analysis import analyze_artifacts, print_summary
from .utils import unpack_artifact

_PACKAGE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _PACKAGE_DIR.parents[2]
_DEFAULT_CHECKS_DIR = _PACKAGE_DIR / "uptake_checks"
_DEFAULT_PRD_SKILLS = _REPO_ROOT / "dataset" / "prd_skills.json"


def main() -> None:
    parser = argparse.ArgumentParser(description="Expo skill-eval helpers")
    sub = parser.add_subparsers(dest="cmd", required=True)

    artifacts = sub.add_parser("analyze-artifacts", help="Analyze authored/eval EAS artifacts")
    artifacts.add_argument("--authored-artifact", required=True, type=Path)
    artifacts.add_argument("--eval-artifact", type=Path)
    artifacts.add_argument("--scenario", required=True)
    artifacts.add_argument("--out-dir", required=True, type=Path)
    artifacts.add_argument(
        "--prd-skills", type=Path, default=_DEFAULT_PRD_SKILLS,
        help="Path to the app -> expected-skills ground-truth map (default: dataset/prd_skills.json)",
    )
    artifacts.add_argument(
        "--checks-dir", type=Path, default=_DEFAULT_CHECKS_DIR,
        help="Directory of checks_data.json + skill_map.json providing uptake checks per skill (default: uptake_checks)",
    )

    args = parser.parse_args()
    if args.cmd == "analyze-artifacts":
        _analyze_artifacts(args)


def _analyze_artifacts(args) -> None:
    unpack_root = args.out_dir / "unpacked"
    authored = unpack_artifact(args.authored_artifact, unpack_root / "authored")
    eval_artifact = None
    if args.eval_artifact and str(args.eval_artifact) not in {"undefined", "null", ""}:
        eval_artifact = unpack_artifact(args.eval_artifact, unpack_root / "eval")
    payload = analyze_artifacts(
        authored,
        eval_artifact,
        args.scenario,
        args.out_dir,
        prd_skills_path=args.prd_skills,
        checks_dir=args.checks_dir,
    )
    print_summary(payload)


if __name__ == "__main__":
    main()
