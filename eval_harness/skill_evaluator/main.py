"""Command-line entry point for Expo skill evaluation helpers."""

from __future__ import annotations

import argparse
from pathlib import Path

from .analysis import analyze_artifacts, print_summary
from .utils import unpack_artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Expo skill-eval helpers")
    sub = parser.add_subparsers(dest="cmd", required=True)

    artifacts = sub.add_parser("analyze-artifacts", help="Analyze authored/eval EAS artifacts")
    artifacts.add_argument("--case", required=True, type=Path)
    artifacts.add_argument("--authored-artifact", required=True, type=Path)
    artifacts.add_argument("--eval-artifact", type=Path)
    artifacts.add_argument("--scenario", required=True)
    artifacts.add_argument("--out-dir", required=True, type=Path)

    args = parser.parse_args()
    if args.cmd == "analyze-artifacts":
        _analyze_artifacts(args)


def _analyze_artifacts(args) -> None:
    unpack_root = args.out_dir / "unpacked"
    authored = unpack_artifact(args.authored_artifact, unpack_root / "authored")
    eval_artifact = None
    if args.eval_artifact and str(args.eval_artifact) not in {"undefined", "null", ""}:
        eval_artifact = unpack_artifact(args.eval_artifact, unpack_root / "eval")
    payload = analyze_artifacts(args.case, authored, eval_artifact, args.scenario, args.out_dir)
    print_summary(payload)


if __name__ == "__main__":
    main()
