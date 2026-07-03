#!/usr/bin/env python3
"""
Claude Code transcript -> normalized agent trace (offline, no OTel, no live hook).

Claude Code writes a per-session JSONL transcript under
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl. Each line is a record:

  {"type":"user","message":{"role":"user","content":"..." | [blocks]}, ...}
  {"type":"assistant","message":{"role":"assistant","model":"claude-...",
      "content":[{"type":"text","text":...},
                 {"type":"thinking","thinking":...},
                 {"type":"tool_use","id":...,"name":...,"input":{...}}],
      "usage":{"input_tokens":...,"output_tokens":...,"cache_read_input_tokens":...}}}
  {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":...,
                                        "content":...,"is_error":...}]}}

We reconstruct it into the SAME shape codex_rollout.py emits (turns -> steps ->
tool_calls), so eval_harness/utils/telemetry/tracing/bt_emit.py and downstream analysis treat both
agents identically. This is the trace-claude-code approach, but run at COLLECTION
TIME (no live plugin/daemon -> nothing left running to slow the machine).

A "turn" begins at a real user prompt (a user message whose content is human
text, not a tool_result) and runs through the assistant model steps until the
next real user prompt. tool_result blocks are matched back to their tool_use by
id to fill in tool outputs.

Test the parser standalone:  python cc_transcript.py --parse-only <transcript.jsonl>
"""

import argparse
import glob
import json
import os
import pathlib
import sys


def _blocks(content):
    """Normalize a message `content` field to a list of blocks."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return content
    return []


def _is_real_user(message) -> bool:
    """True if this user message is a human prompt (not a tool_result feedback)."""
    for b in _blocks(message.get("content")):
        if isinstance(b, dict) and b.get("type") == "tool_result":
            return False
    return True


def _user_text(message) -> str:
    parts = []
    for b in _blocks(message.get("content")):
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text") or "")
        elif isinstance(b, str):
            parts.append(b)
    return "".join(parts)


def _usage(u):
    if not isinstance(u, dict):
        return {}
    out = {}
    it, ot = u.get("input_tokens"), u.get("output_tokens")
    if it is not None:
        out["prompt_tokens"] = it
    if ot is not None:
        out["completion_tokens"] = ot
    if it is not None and ot is not None:
        out["tokens"] = it + ot
    if u.get("cache_read_input_tokens") is not None:
        out["cache_read_input_tokens"] = u["cache_read_input_tokens"]
    if u.get("cache_creation_input_tokens") is not None:
        out["cache_creation_input_tokens"] = u["cache_creation_input_tokens"]
    return out


def parse_transcript(path):
    records = []
    with open(path) as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                records.append(json.loads(ln))
            except Exception:
                continue

    session_meta = {}
    turns = []
    cur = None
    tools_by_id = {}
    turn_index = 0

    def finish_turn():
        nonlocal cur, tools_by_id
        if cur is None:
            return
        if not cur.get("final_output"):
            for st in reversed(cur["steps"]):
                if st.get("text"):
                    cur["final_output"] = st["text"]
                    break
        turns.append(cur)
        cur, tools_by_id = None, {}

    for rec in records:
        typ = rec.get("type")
        if typ in ("user", "assistant") and not session_meta:
            session_meta = {"id": rec.get("sessionId"), "cwd": rec.get("cwd"),
                            "cli_version": rec.get("version"),
                            "git_branch": rec.get("gitBranch")}
        msg = rec.get("message") or {}

        if typ == "user":
            if _is_real_user(msg):
                # Start of a new turn.
                finish_turn()
                turn_index += 1
                cur = {"turn_id": rec.get("uuid"), "turn_index": turn_index,
                       "user_input": _user_text(msg), "steps": []}
                tools_by_id = {}
            else:
                # tool_result(s) feeding back to the prior assistant step.
                if cur is None:
                    continue
                for b in _blocks(msg.get("content")):
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        tc = tools_by_id.get(b.get("tool_use_id"))
                        if tc is not None:
                            content = b.get("content")
                            tc["output"] = content if isinstance(content, str) else json.dumps(content, default=str)
                            if b.get("is_error"):
                                tc["error"] = tc["output"]

        elif typ == "assistant":
            if cur is None:
                # Assistant text with no preceding human prompt (rare) — open a turn.
                turn_index += 1
                cur = {"turn_id": rec.get("uuid"), "turn_index": turn_index,
                       "user_input": None, "steps": []}
                tools_by_id = {}
            step = {"text": "", "reasoning": "", "tool_calls": [], "usage": _usage(msg.get("usage"))}
            if msg.get("model"):
                cur["model"] = msg["model"]
            for b in _blocks(msg.get("content")):
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "text":
                    step["text"] += b.get("text") or ""
                elif bt == "thinking":
                    step["reasoning"] += b.get("thinking") or ""
                elif bt == "tool_use":
                    tc = {"call_id": b.get("id"), "name": b.get("name"), "args": b.get("input")}
                    step["tool_calls"].append(tc)
                    if tc["call_id"]:
                        tools_by_id[tc["call_id"]] = tc
            cur["steps"].append(step)
            # Accumulate turn usage.
            tu = cur.setdefault("total_usage", {})
            for k, v in step["usage"].items():
                if isinstance(v, (int, float)):
                    tu[k] = tu.get(k, 0) + v

    finish_turn()
    return turns, session_meta


# ---------- collection-time reconstruction ----------

def find_transcripts(projects_dir, since_mtime=0.0, before_mtime=None):
    paths = []
    for p in glob.glob(os.path.join(projects_dir, "**", "*.jsonl"), recursive=True):
        try:
            mtime = os.path.getmtime(p)
            if mtime >= since_mtime and (before_mtime is None or mtime < before_mtime):
                paths.append(p)
        except OSError:
            continue
    return sorted(paths, key=lambda p: os.path.getmtime(p))


def reconstruct(
    projects_dir,
    out_path,
    since_mtime=0.0,
    before_mtime=None,
    braintrust=False,
    run_id=None,
    source="claude-code",
    session_name=None,
):
    transcripts = find_transcripts(projects_dir, since_mtime, before_mtime)
    sessions = []
    for tp in transcripts:
        try:
            turns, meta = parse_transcript(tp)
        except Exception as e:
            print(f"[cc_transcript] skip {tp}: {e}")
            continue
        if not turns:
            continue
        sessions.append({"transcript": tp, "session_meta": meta, "turns": turns})
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
                print(f"[cc_transcript] braintrust push failed: {e}")
    payload = {
        "agent": "claude-code",
        "run_id": run_id,
        "source": source,
        "session_name": session_name,
        "n_sessions": len(sessions),
        "projects_dir": projects_dir,
        "since_mtime": since_mtime,
        "before_mtime": before_mtime,
        "sessions": sessions,
    }
    pathlib.Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    print(f"[cc_transcript] {len(sessions)} session(s) -> {out_path}")
    return payload


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--parse-only":
        turns, meta = parse_transcript(sys.argv[2])
        print(json.dumps({"session_meta": meta, "turns": turns}, indent=2, default=str))
        return
    ap = argparse.ArgumentParser(description="Reconstruct Claude Code agent traces from transcripts.")
    ap.add_argument("--projects-dir", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--since-mtime", type=float, default=0.0,
                    help="epoch seconds; only transcripts modified at/after are included")
    ap.add_argument("--before-mtime", type=float, default=None,
                    help="epoch seconds; only transcripts modified before this time are included")
    ap.add_argument("--braintrust", action="store_true")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--source", default=os.environ.get("TRACE_SOURCE", "claude-code"))
    ap.add_argument("--session-name", default=os.environ.get("TRACE_SESSION_NAME"))
    args = ap.parse_args()
    reconstruct(
        args.projects_dir,
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
