"""
Append-only JSONL tracer for the adaptive evaluator.

Each test plan run writes to traces/<plan_stem>_<timestamp>/:
  - conversation.jsonl  — one record per event (request_sent, assistant_response,
                          tool_call, tool_result, step_complete, usage_snapshot, etc.)
  - summary.json        — final score + aggregate token usage, written at end

Records are flushed after every write so a crashed run leaves a usable trace.
Designed to be replayable by future Claude Code sessions for analysis.
"""

import io
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any


class Tracer:
    """One Tracer instance per test plan run."""

    def __init__(self, plan_stem: str, root: Path | None = None):
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.root = (root or Path("traces")) / f"{plan_stem}_{ts}"
        self.root.mkdir(parents=True, exist_ok=True)
        self._f = open(self.root / "conversation.jsonl", "a", encoding="utf-8")
        self.start_time = time.time()

    def log(self, event: str, **payload: Any) -> None:
        """Write one structured record by event name + keyword payload."""
        record = {
            "ts": time.time(),
            "elapsed_s": round(time.time() - self.start_time, 3),
            "event": event,
            **payload,
        }
        self._f.write(json.dumps(record, default=_json_default) + "\n")
        self._f.flush()

    def log_record(self, record: dict) -> None:
        """Write a pre-built record (already has `event` and any timing fields)."""
        if "ts" not in record:
            record["ts"] = time.time()
        if "elapsed_s" not in record:
            record["elapsed_s"] = round(time.time() - self.start_time, 3)
        self._f.write(json.dumps(record, default=_json_default) + "\n")
        self._f.flush()

    def write_summary(self, summary: dict) -> None:
        """Write the final summary.json with scoring + aggregate usage."""
        (self.root / "summary.json").write_text(
            json.dumps(summary, indent=2, default=_json_default)
        )

    def capture_console(self) -> None:
        """Mirror stdout/stderr to an in-memory buffer; dumped to console.log on close."""
        self._buf = io.StringIO()
        self._orig_stdout = sys.stdout
        self._orig_stderr = sys.stderr
        sys.stdout = _Tee(sys.stdout, self._buf)
        sys.stderr = _Tee(sys.stderr, self._buf)

    def close(self) -> None:
        if not self._f.closed:
            self._f.close()
        buf = getattr(self, "_buf", None)
        if buf is not None:
            sys.stdout = self._orig_stdout
            sys.stderr = self._orig_stderr
            (self.root / "console.log").write_text(buf.getvalue(), encoding="utf-8")
            self._buf = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class _Tee:
    def __init__(self, *streams):
        self._streams = streams

    def write(self, x):
        for s in self._streams:
            s.write(x)

    def flush(self):
        for s in self._streams:
            s.flush()


def _json_default(obj):
    """Best-effort serializer for non-JSON-native types (dataclasses, SDK message objects)."""
    if hasattr(obj, "__dict__"):
        return {k: v for k, v in obj.__dict__.items() if not k.startswith("_")}
    if hasattr(obj, "_asdict"):
        return obj._asdict()
    return repr(obj)
