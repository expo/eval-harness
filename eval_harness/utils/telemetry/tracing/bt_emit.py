#!/usr/bin/env python3
"""
Optional Braintrust emission for reconstructed agent traces.

Both Bun parsers (codex_rollout.ts and cc_transcript.ts) call this module
through a transitional Python subprocess bridge and produce the SAME
normalized shape:

    {"session_meta": {...},
     "turns": [{"turn_index", "turn_id", "user_input", "final_output",
                "model", "total_usage",
                "steps": [{"text", "reasoning", "usage",
                           "tool_calls": [{"call_id","name","args","output","error"}]}]}]}

This module turns that into a Braintrust span tree (trace-claude-code span
shape) when BRAINTRUST_API_KEY is present. It is import-light: `braintrust` is
imported lazily so the Bun parsers still work when Braintrust isn't installed.
Everything is fail-open — tracing never blocks a run. Span conversion and
emission will migrate in a later telemetry slice.

`run_id` is attached to the session span metadata so a Braintrust trace can be
correlated back to the harness run that produced it.
"""

import os


def log_session(turns, session_meta, project=None, run_id=None, source="agent", name=None):
    """Log a reconstructed session to Braintrust. No-op (returns False) if
    BRAINTRUST_API_KEY is unset or `braintrust` can't be imported."""
    if not os.environ.get("BRAINTRUST_API_KEY"):
        return False
    if not turns:
        return False
    try:
        import braintrust
    except Exception:
        return False

    source_project = (
        os.environ.get("BRAINTRUST_EVAL_PROJECT")
        if source == "agentic-evaluator"
        else os.environ.get("BRAINTRUST_CC_PROJECT")
    )
    project = project or source_project or os.environ.get("BRAINTRUST_PROJECT") or "expo-evals"
    try:
        braintrust.init_logger(project=project)
        session_id = session_meta.get("id") or session_meta.get("session_id") or "unknown"
        session_name = name or os.environ.get("BRAINTRUST_SESSION_NAME") or f"{source} Session"
        s = braintrust.start_span(
            name=session_name, type="task",
            metadata={"session_id": session_id, "source": source, "run_id": run_id,
                      "session_name": session_name,
                      "cli_version": session_meta.get("cli_version")})
        s.log(input=f"{session_name} {session_id}")
        session_handle = s.export()
        s.end()
        for turn in turns:
            _log_turn(braintrust, session_handle, turn, run_id)
        braintrust.flush()
        return True
    except Exception as e:  # fail open
        print(f"[bt_emit] swallowed error: {e}")
        return False


def _log_turn(braintrust, session_handle, turn, run_id):
    """Mirror of the trace-claude-code / codex_bt_hook span shape: a Turn task
    span with one llm span per model step and tool spans as siblings."""
    import json
    turn_span = braintrust.start_span(
        name=f"Turn {turn.get('turn_index', '?')}", type="task", parent=session_handle)
    turn_span.log(
        input=turn.get("user_input"),
        output=turn.get("final_output"),
        metadata={"turn_id": turn.get("turn_id"), "model": turn.get("model"),
                  "aborted": turn.get("aborted"), "run_id": run_id},
        metrics=turn.get("total_usage") or {},
    )
    turn_handle = turn_span.export()
    messages = []
    if turn.get("user_input"):
        messages.append({"role": "user", "content": turn["user_input"]})

    for i, step in enumerate(turn.get("steps", [])):
        tool_calls = step.get("tool_calls", [])
        assistant_msg = {"role": "assistant", "content": step.get("text") or None}
        if tool_calls:
            assistant_msg["tool_calls"] = [
                {"id": t.get("call_id"), "type": "function",
                 "function": {"name": t.get("name"),
                              "arguments": t["args"] if isinstance(t.get("args"), str)
                              else json.dumps(t.get("args"))}}
                for t in tool_calls
            ]
        llm = braintrust.start_span(name=turn.get("model") or "model", type="llm", parent=turn_handle)
        llm.log(input=list(messages), output=assistant_msg,
                metrics=step.get("usage") or {},
                metadata={"step_index": i, "reasoning": step.get("reasoning") or None})
        llm.end()
        messages.append(assistant_msg)
        for tc in tool_calls:
            tool = braintrust.start_span(name=tc.get("name") or "tool", type="tool", parent=turn_handle)
            tool.log(input=tc.get("args"), output=tc.get("output"),
                     metadata={"call_id": tc.get("call_id"), "error": tc.get("error")})
            tool.end()
            messages.append({"role": "tool", "tool_call_id": tc.get("call_id"),
                             "content": tc.get("output") if isinstance(tc.get("output"), str)
                             else json.dumps(tc.get("output"))})
    turn_span.end()
