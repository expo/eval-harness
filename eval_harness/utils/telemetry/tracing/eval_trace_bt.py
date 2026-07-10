#!/usr/bin/env python3
"""
Push an evaluator trace directory to Braintrust.

The evaluator already writes durable JSONL under traces/<app>/<plan>_<ts>/:
conversation.jsonl, summary.json, and console.log. This script keeps that file
format as the source of truth and mirrors it into Braintrust as a span tree:

  Evaluator Run
    Step N
      LLM turn
      tool spans

Everything is fail-open. Missing BRAINTRUST_API_KEY or import errors return 0 so
artifact collection never blocks a workflow run.
"""

import argparse
import json
import os
import pathlib
from collections import defaultdict


def _load_jsonl(path):
    records = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except Exception:
                    records.append({"event": "malformed_jsonl", "raw": line})
    except FileNotFoundError:
        pass
    return records


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _usage_metrics(usage):
    if not isinstance(usage, dict):
        return {}
    mapping = {
        "input_tokens": "prompt_tokens",
        "output_tokens": "completion_tokens",
        "cache_creation_input_tokens": "cache_creation_input_tokens",
        "cache_read_input_tokens": "cache_read_input_tokens",
    }
    out = {}
    for src, dst in mapping.items():
        if usage.get(src) is not None:
            out[dst] = usage[src]
    if usage.get("input_tokens") is not None and usage.get("output_tokens") is not None:
        out["tokens"] = usage["input_tokens"] + usage["output_tokens"]
    return out


def push_trace(trace_dir, run_id=None, project=None):
    if not os.environ.get("BRAINTRUST_API_KEY"):
        print("[eval_trace_bt] BRAINTRUST_API_KEY unset; skipping")
        return False
    try:
        import braintrust
    except Exception as e:
        print(f"[eval_trace_bt] braintrust import failed; skipping: {e}")
        return False

    trace_dir = pathlib.Path(trace_dir)
    conversation = _load_jsonl(trace_dir / "conversation.jsonl")
    summary = _load_json(trace_dir / "summary.json")
    if not conversation:
        print(f"[eval_trace_bt] no conversation.jsonl records in {trace_dir}; skipping")
        return False

    project = (
        project
        or os.environ.get("BRAINTRUST_EVAL_PROJECT")
        or os.environ.get("BRAINTRUST_PROJECT")
        or "expo-evals"
    )
    plan_name = trace_dir.name
    try:
        braintrust.init_logger(project=project)
        root = braintrust.start_span(name="Evaluator Run", type="task")
        root.log(
            input={"trace_dir": str(trace_dir), "plan": plan_name},
            output=summary or None,
            metadata={
                "source": "agentic-evaluator",
                "run_id": run_id,
                "trace_dir": str(trace_dir),
                "project": project,
            },
            metrics=(summary.get("usage") if isinstance(summary.get("usage"), dict) else {}),
        )
        root_handle = root.export()

        step_records = defaultdict(list)
        run_records = []
        for rec in conversation:
            step = rec.get("step") or rec.get("step_number")
            if step is None:
                run_records.append(rec)
            else:
                step_records[int(step)].append(rec)

        if run_records:
            meta_span = braintrust.start_span(name="Run Events", type="task", parent=root_handle)
            meta_span.log(output=run_records, metadata={"run_id": run_id})
            meta_span.end()

        for step, records in sorted(step_records.items()):
            _log_step(braintrust, root_handle, step, records, run_id)

        root.end()
        braintrust.flush()
        print(f"[eval_trace_bt] pushed {trace_dir} to Braintrust project {project}")
        return True
    except Exception as e:
        print(f"[eval_trace_bt] swallowed error: {e}")
        return False


def _log_step(braintrust, root_handle, step, records, run_id):
    started = next((r for r in records if r.get("event") == "step_start"), None)
    completed = next((r for r in reversed(records) if r.get("event") == "step_complete"), None)
    step_span = braintrust.start_span(name=f"Evaluator Step {step}", type="task", parent=root_handle)
    step_span.log(
        input=started,
        output=completed,
        metadata={"step": step, "run_id": run_id},
    )
    step_handle = step_span.export()

    for rec in records:
        event = rec.get("event")
        if event == "turn":
            _log_turn(braintrust, step_handle, rec, run_id)
        elif event and event not in {"step_start", "step_complete"}:
            span = braintrust.start_span(name=event, type="task", parent=step_handle)
            span.log(output=rec, metadata={"step": step, "run_id": run_id})
            span.end()
    step_span.end()


def _log_turn(braintrust, step_handle, rec, run_id):
    llm = braintrust.start_span(name=f"Evaluator Turn {rec.get('turn', '?')}", type="llm", parent=step_handle)
    llm.log(
        input={"step": rec.get("step"), "turn": rec.get("turn")},
        output={"thinking": rec.get("thinking"), "text": rec.get("text")},
        metadata={
            "message_id": rec.get("message_id"),
            "stop_reason": rec.get("stop_reason"),
            "run_id": run_id,
            "duration_s": rec.get("duration_s"),
        },
        metrics=_usage_metrics(rec.get("usage")),
    )
    llm_handle = llm.export()
    for tool_use in rec.get("tool_uses") or []:
        tool = braintrust.start_span(name=tool_use.get("tool") or "tool", type="tool", parent=llm_handle)
        tool.log(
            input=tool_use.get("input"),
            output=tool_use.get("result_text"),
            metadata={
                "tool_use_id": tool_use.get("tool_use_id"),
                "success": tool_use.get("success"),
                "duration_ms": tool_use.get("duration_ms"),
                "run_id": run_id,
            },
        )
        tool.end()
    llm.end()


def main():
    ap = argparse.ArgumentParser(description="Push evaluator trace directory to Braintrust.")
    ap.add_argument("--trace-dir", required=True)
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--project", default=None)
    args = ap.parse_args()
    push_trace(args.trace_dir, args.run_id, args.project)


if __name__ == "__main__":
    main()
