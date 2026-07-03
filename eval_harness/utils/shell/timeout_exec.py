#!/usr/bin/env python3
"""Run a command with a timeout, including on macOS where GNU timeout is absent."""

from __future__ import annotations

import os
import signal
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: timeout_exec.py <seconds> <cmd> [args...]", file=sys.stderr)
        return 2
    try:
        seconds = float(sys.argv[1])
    except ValueError:
        print(f"invalid timeout: {sys.argv[1]}", file=sys.stderr)
        return 2

    proc = subprocess.Popen(sys.argv[2:], start_new_session=True)
    try:
        return proc.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        print(
            f"timeout_exec.py: command exceeded {seconds:g}s; terminating process group",
            file=sys.stderr,
        )
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return 124


if __name__ == "__main__":
    raise SystemExit(main())
