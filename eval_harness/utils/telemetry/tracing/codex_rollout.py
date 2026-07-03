#!/usr/bin/env python3
"""
Codex rollout -> normalized agent trace (offline, no OTel, no live hook).

The `parse_rollout` state machine is vendored faithfully from the user's
codex_bt_hook.py (which mirrors Langfuse's codex-observability-plugin). The
difference here: instead of running as a live Codex `Stop` hook, this runs at
COLLECTION TIME — it finds the rollout JSONL(s) Codex wrote during a run, parses
them into the normalized turns->steps->tool_calls shape, and writes one JSON
file into the run bundle. That avoids the leftover background process the live
cc-trace/hook approach left behind.

Codex `exec` writes rollouts under $CODEX_HOME/sessions/**/rollout-*.jsonl
(default ~/.codex/sessions). We select rollouts modified at/after --since-mtime
(the orchestrator records the run's start time) so we only pick up THIS run.

Optional: with --braintrust and BRAINTRUST_API_KEY set, also push the spans
(reusing eval_harness/utils/telemetry/tracing/bt_emit.py), tagged with --run-id.

Test the parser standalone:  python codex_rollout.py --parse-only <rollout.jsonl>
"""

import argparse
import glob
import json
import os
import pathlib
import sys


# ---------- rollout parsing (faithful to the Langfuse plugin state machine) ----------

def _extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, dict):
                out.append(part.get("text") or part.get("output_text") or part.get("input_text") or "")
            elif isinstance(part, str):
                out.append(part)
        return "".join(out)
    return ""


def _extract_reasoning(payload) -> str:
    c = payload.get("content")
    if c:
        return _extract_text(c)
    summary = payload.get("summary")
    if isinstance(summary, list):
        return " ".join(_extract_text(s) for s in summary)
    return ""


def _is_wrapper(text: str) -> bool:
    t = (text or "").lstrip()
    return t.startswith("<environment_context>") or t.startswith("<user_instructions>")


def _maybe_json(s):
    if isinstance(s, (dict, list)):
        return s
    if isinstance(s, str):
        try:
            return json.loads(s)
        except Exception:
            return s
    return s


def _usage(info):
    if not isinstance(info, dict):
        return {}
    out = {}
    if info.get("input_tokens") is not None:
        out["prompt_tokens"] = info["input_tokens"]
    if info.get("output_tokens") is not None:
        out["completion_tokens"] = info["output_tokens"]
    if info.get("total_tokens") is not None:
        out["tokens"] = info["total_tokens"]
    if info.get("cached_input_tokens") is not None:
        out["cache_read_input_tokens"] = info["cached_input_tokens"]
    return out


def _tool_error(payload):
    return (payload.get("error") or payload.get("codex_error_info")
            or payload.get("stderr") or payload.get("aggregated_output")
            or (f"Exit code: {payload['exit_code']}" if payload.get("exit_code") else "failed"))


def parse_rollout(path):
    records = []
    with open(path) as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                records.append(json.loads(ln))
            except Exception:
                continue  # skip malformed line, don't abort

    session_meta, turns = {}, []
    cur = None        # current MutableTurn
    cur_step = None   # current model step
    tools_by_id = {}
    pending_tool_outputs = {}
    turn_index = 0

    def finish_step():
        nonlocal cur_step
        if cur is not None and cur_step is not None:
            cur["steps"].append(cur_step)
            cur_step = None

    def finish_turn(completed, aborted):
        nonlocal cur, tools_by_id, pending_tool_outputs
        if cur is None:
            return
        finish_step()
        cur["completed"], cur["aborted"] = completed, aborted
        if not cur.get("final_output"):
            for st in reversed(cur["steps"]):
                if st.get("text"):
                    cur["final_output"] = st["text"]
                    break
        if not cur.get("user_input"):
            cur["user_input"] = cur.get("user_input_fallback")
        turns.append(cur)
        cur, tools_by_id, pending_tool_outputs = None, {}, {}

    def tool_output(payload):
        return (
            payload.get("aggregated_output")
            or payload.get("stdout")
            or payload.get("result")
            or payload.get("output")
            or {
                k: payload.get(k)
                for k in ("status", "query", "action", "call_id")
                if payload.get(k) is not None
            }
        )

    def attach_pending(tc):
        call_id = tc.get("call_id")
        if not call_id or call_id not in pending_tool_outputs:
            return
        pending = pending_tool_outputs.pop(call_id)
        if pending.get("error"):
            tc["error"] = pending["error"]
        if pending.get("output") is not None:
            tc["output"] = pending["output"]

    for rec in records:
        typ = rec.get("type")
        payload = rec.get("payload") or {}

        if typ == "session_meta":
            session_meta = payload
        elif typ == "turn_context" and cur is not None:
            cur["model"] = payload.get("model") or cur.get("model")
            cur["invocation_params"] = payload
        elif typ == "response_item":
            if cur is None:
                continue
            if cur_step is None:
                cur_step = {"text": "", "reasoning": "", "tool_calls": []}
            pt = payload.get("type")
            if pt == "message":
                role = payload.get("role")
                text = _extract_text(payload.get("content"))
                if role == "assistant":
                    cur_step["text"] += text
                elif role in ("user", "developer") and not _is_wrapper(text):
                    cur.setdefault("user_input_fallback", text)
            elif pt == "reasoning":
                cur_step["reasoning"] += _extract_reasoning(payload)
            elif pt in ("function_call", "custom_tool_call"):
                tc = {
                    "call_id": payload.get("call_id"),
                    "name": payload.get("name"),
                    "args": _maybe_json(payload.get("arguments") if payload.get("arguments") is not None
                                        else payload.get("input")),
                }
                cur_step["tool_calls"].append(tc)
                if tc["call_id"]:
                    tools_by_id[tc["call_id"]] = tc
                    attach_pending(tc)
            elif pt == "web_search_call":
                action = payload.get("action") or {}
                tc = {
                    "call_id": payload.get("id"),
                    "name": "web_search",
                    "args": {
                        "query": action.get("query"),
                        "queries": action.get("queries"),
                        "action": action,
                    },
                }
                cur_step["tool_calls"].append(tc)
                if tc["call_id"]:
                    tools_by_id[tc["call_id"]] = tc
                    attach_pending(tc)
            elif pt in ("function_call_output", "custom_tool_call_output"):
                tc = tools_by_id.get(payload.get("call_id"))
                if tc is not None:
                    tc["output"] = payload.get("output")
        elif typ == "event_msg":
            pt = payload.get("type")
            if pt == "task_started":
                if cur is not None:
                    finish_turn(completed=False, aborted=False)
                turn_index += 1
                cur = {"turn_id": payload.get("turn_id"), "turn_index": turn_index, "steps": []}
                cur_step, tools_by_id, pending_tool_outputs = None, {}, {}
            elif pt == "user_message" and cur is not None:
                cur["user_input"] = payload.get("message")
            elif pt == "agent_message" and cur is not None:
                cur["final_output"] = payload.get("message")
            elif pt == "token_count" and cur is not None:
                info = payload.get("info") or {}
                cur["total_usage"] = _usage(info.get("total_token_usage"))
                if cur_step is not None:
                    cur_step["usage"] = _usage(info.get("last_token_usage"))
                finish_step()  # token_count delimits a model step
            elif pt == "task_complete":
                finish_turn(completed=True, aborted=False)
            elif pt == "turn_aborted":
                finish_turn(completed=True, aborted=True)
            elif pt.endswith("_end") and payload.get("call_id"):
                tc = tools_by_id.get(payload.get("call_id"))
                output = tool_output(payload)
                error = _tool_error(payload) if payload.get("status") in ("failed", "declined") else None
                if tc is not None:
                    if error:
                        tc["error"] = error
                    if not tc.get("output"):
                        tc["output"] = output
                else:
                    pending_tool_outputs[payload.get("call_id")] = {"output": output, "error": error}

    if cur is not None:
        finish_turn(completed=False, aborted=False)  # flush trailing in-progress turn
    return turns, session_meta


# ---------- collection-time reconstruction ----------

def find_rollouts(sessions_dir, since_mtime=0.0, before_mtime=None):
    paths = []
    for p in glob.glob(os.path.join(sessions_dir, "**", "rollout-*.jsonl"), recursive=True):
        try:
            mtime = os.path.getmtime(p)
            if mtime >= since_mtime and (before_mtime is None or mtime < before_mtime):
                paths.append(p)
        except OSError:
            continue
    return sorted(paths, key=lambda p: os.path.getmtime(p))


def reconstruct(
    sessions_dir,
    out_path,
    since_mtime=0.0,
    before_mtime=None,
    braintrust=False,
    run_id=None,
    source="codex",
    session_name=None,
):
    rollouts = find_rollouts(sessions_dir, since_mtime, before_mtime)
    sessions = []
    for rp in rollouts:
        try:
            turns, meta = parse_rollout(rp)
        except Exception as e:
            print(f"[codex_rollout] skip {rp}: {e}")
            continue
        if not turns:
            continue
        sessions.append({"rollout": rp, "session_meta": meta, "turns": turns})
        if braintrust:
            try:
                sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
                import bt_emit
                bt_emit.log_session(
                    turns,
                    meta,
                    run_id=run_id,
                    source=source,
                    name=session_name,
                )
            except Exception as e:
                print(f"[codex_rollout] braintrust push failed: {e}")
    payload = {
        "agent": "codex",
        "run_id": run_id,
        "source": source,
        "session_name": session_name,
        "n_sessions": len(sessions),
        "sessions_dir": sessions_dir,
        "since_mtime": since_mtime,
        "before_mtime": before_mtime,
        "sessions": sessions,
    }
    pathlib.Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    print(f"[codex_rollout] {len(sessions)} session(s) -> {out_path}")
    return payload


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--parse-only":
        turns, meta = parse_rollout(sys.argv[2])
        print(json.dumps({"session_meta": meta, "turns": turns}, indent=2, default=str))
        return
    ap = argparse.ArgumentParser(description="Reconstruct Codex agent traces from rollouts.")
    ap.add_argument("--sessions-dir",
                    default=os.path.join(os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex")), "sessions"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--since-mtime", type=float, default=0.0,
                    help="epoch seconds; only rollouts modified at/after are included")
    ap.add_argument("--before-mtime", type=float, default=None,
                    help="epoch seconds; only rollouts modified before this time are included")
    ap.add_argument("--braintrust", action="store_true")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--source", default=os.environ.get("TRACE_SOURCE", "codex"))
    ap.add_argument("--session-name", default=os.environ.get("TRACE_SESSION_NAME"))
    args = ap.parse_args()
    reconstruct(
        args.sessions_dir,
        args.out,
        args.since_mtime,
        args.before_mtime,
        args.braintrust,
        args.run_id,
        args.source,
        args.session_name,
    )


if __name__ == "__main__":
    main()
