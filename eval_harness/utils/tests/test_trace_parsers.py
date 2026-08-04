from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from hypothesis import example, given, strategies as st

from eval_harness.utils.telemetry.tracing import cc_transcript, codex_rollout


REPO_ROOT = Path(__file__).resolve().parents[3]
CC_SCRIPT = REPO_ROOT / "eval_harness/utils/telemetry/tracing/cc_transcript.py"
CODEX_SCRIPT = REPO_ROOT / "eval_harness/utils/telemetry/tracing/codex_rollout.py"
CC_TS_SCRIPT = REPO_ROOT / "eval_harness/utils/telemetry/tracing/cc_transcript.ts"
CODEX_TS_SCRIPT = REPO_ROOT / "eval_harness/utils/telemetry/tracing/codex_rollout.ts"


def _write_jsonl(path: Path, records: list[dict | str]) -> None:
    lines = [record if isinstance(record, str) else json.dumps(record) for record in records]
    path.write_text("\n".join(lines) + "\n")


def _claude_prompt(text: str, *, uuid: str = "user-1") -> dict:
    return {
        "type": "user",
        "sessionId": "session-1",
        "cwd": "/workspace/app",
        "version": "1.2.3",
        "gitBranch": "main",
        "uuid": uuid,
        "message": {"role": "user", "content": text},
    }


def _codex_task_started(turn_id: str = "turn-1") -> dict:
    return {"type": "event_msg", "payload": {"type": "task_started", "turn_id": turn_id}}


_CLEAN_TEXT = st.text(
    alphabet=st.characters(blacklist_categories=("Cs", "Cc")),
    max_size=24,
)
_JSON_VALUES = st.recursive(
    st.one_of(st.none(), st.booleans(), st.integers(min_value=-10_000, max_value=10_000), _CLEAN_TEXT),
    lambda children: st.one_of(
        st.lists(children, max_size=4),
        st.dictionaries(_CLEAN_TEXT, children, max_size=4),
    ),
    max_leaves=12,
)


@st.composite
def _claude_tool_result_cases(draw):
    call_ids = draw(
        st.lists(
            st.from_regex(r"call-[a-z0-9]{1,6}", fullmatch=True),
            min_size=1,
            max_size=6,
            unique=True,
        )
    )
    selected_ids = draw(st.lists(st.sampled_from(call_ids), unique=True))
    results = []
    expected = {}
    for call_id in selected_ids:
        content = draw(_JSON_VALUES)
        is_error = draw(st.booleans())
        results.append(
            {
                "type": "tool_result",
                "tool_use_id": call_id,
                "content": content,
                "is_error": is_error,
            }
        )
        expected[call_id] = {"content": content, "is_error": is_error}

    unknown_count = draw(st.integers(min_value=0, max_value=3))
    for index in range(unknown_count):
        results.append(
            {
                "type": "tool_result",
                "tool_use_id": f"unknown-{index}",
                "content": draw(_JSON_VALUES),
                "is_error": draw(st.booleans()),
            }
        )

    if results:
        results = list(draw(st.permutations(results)))
    return call_ids, results, expected


class ClaudeTranscriptCharacterizationTests(unittest.TestCase):
    def test_characterization_normalizes_turns_tools_usage_and_metadata(self) -> None:
        """Characterization: preserve the observed normalized Claude trace.

        Oracle: literal output captured from the Python parser.
        Catches: schema drift, positional tool-result attachment, lost errors,
        incorrect usage aggregation, and wrong final-output selection.
        """
        records = [
            _claude_prompt("Build the app"),
            {
                "type": "assistant",
                "uuid": "assistant-1",
                "message": {
                    "role": "assistant",
                    "model": "claude-test",
                    "content": [
                        {"type": "thinking", "thinking": "Plan first."},
                        {"type": "text", "text": "I will inspect files."},
                        {"type": "tool_use", "id": "call-a", "name": "Read", "input": {"path": "a.txt"}},
                        {"type": "tool_use", "id": "call-b", "name": "Read", "input": {"path": "b.txt"}},
                    ],
                    "usage": {"input_tokens": 10, "output_tokens": 4, "cache_read_input_tokens": 2},
                },
            },
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "call-b", "content": {"value": 2}},
                        {"type": "tool_result", "tool_use_id": "call-a", "content": "failed", "is_error": True},
                        {"type": "tool_result", "tool_use_id": "unknown", "content": "ignored"},
                    ],
                },
            },
            {
                "type": "assistant",
                "message": {
                    "model": "claude-test",
                    "content": [{"type": "text", "text": "Finished."}],
                    "usage": {"input_tokens": 3, "output_tokens": 1, "cache_creation_input_tokens": 5},
                },
            },
        ]

        with tempfile.TemporaryDirectory() as td:
            transcript = Path(td) / "session.jsonl"
            _write_jsonl(transcript, records)
            turns, meta = cc_transcript.parse_transcript(transcript)

        self.assertEqual(
            meta,
            {"id": "session-1", "cwd": "/workspace/app", "cli_version": "1.2.3", "git_branch": "main"},
        )
        self.assertEqual(
            turns,
            [
                {
                    "turn_id": "user-1",
                    "turn_index": 1,
                    "user_input": "Build the app",
                    "steps": [
                        {
                            "text": "I will inspect files.",
                            "reasoning": "Plan first.",
                            "tool_calls": [
                                {
                                    "call_id": "call-a",
                                    "name": "Read",
                                    "args": {"path": "a.txt"},
                                    "output": "failed",
                                    "error": "failed",
                                },
                                {
                                    "call_id": "call-b",
                                    "name": "Read",
                                    "args": {"path": "b.txt"},
                                    "output": '{"value": 2}',
                                },
                            ],
                            "usage": {
                                "prompt_tokens": 10,
                                "completion_tokens": 4,
                                "tokens": 14,
                                "cache_read_input_tokens": 2,
                            },
                        },
                        {
                            "text": "Finished.",
                            "reasoning": "",
                            "tool_calls": [],
                            "usage": {
                                "prompt_tokens": 3,
                                "completion_tokens": 1,
                                "tokens": 4,
                                "cache_creation_input_tokens": 5,
                            },
                        },
                    ],
                    "model": "claude-test",
                    "total_usage": {
                        "prompt_tokens": 13,
                        "completion_tokens": 5,
                        "tokens": 18,
                        "cache_read_input_tokens": 2,
                        "cache_creation_input_tokens": 5,
                    },
                    "final_output": "Finished.",
                }
            ],
        )

    def test_characterization_skips_malformed_lines_and_opens_assistant_first_turn(self) -> None:
        """Characterization: preserve malformed-line and assistant-first behavior.

        Oracle: literal output captured from the Python parser.
        Catches: aborting on malformed JSONL and dropping assistant preambles.
        """
        with tempfile.TemporaryDirectory() as td:
            transcript = Path(td) / "session.jsonl"
            _write_jsonl(
                transcript,
                [
                    "",
                    "not-json",
                    {
                        "type": "assistant",
                        "sessionId": "session-a",
                        "uuid": "assistant-a",
                        "message": {"model": "claude-test", "content": "hello"},
                    },
                ],
            )
            turns, meta = cc_transcript.parse_transcript(transcript)

        self.assertEqual(meta, {"id": "session-a", "cwd": None, "cli_version": None, "git_branch": None})
        self.assertEqual(turns[0]["turn_id"], "assistant-a")
        self.assertEqual(turns[0]["user_input"], None)
        self.assertEqual(turns[0]["final_output"], "hello")
        self.assertEqual(turns[0]["turn_index"], 1)

    @given(case=_claude_tool_result_cases())
    @example(
        case=(
            ["call-a", "call-b"],
            [
                {"type": "tool_result", "tool_use_id": "unknown-0", "content": "ignored", "is_error": True},
                {"type": "tool_result", "tool_use_id": "call-b", "content": {"value": 2}, "is_error": False},
                {"type": "tool_result", "tool_use_id": "call-a", "content": "failed", "is_error": True},
            ],
            {
                "call-a": {"content": "failed", "is_error": True},
                "call-b": {"content": {"value": 2}, "is_error": False},
            },
        )
    )
    def test_spec_trace_001_tool_results_attach_only_to_matching_calls(self, case) -> None:
        """Property: a Claude tool result affects only its matching call ID.

        Oracle: a dictionary built directly from generated results, keyed by
        tool-use ID; structured outputs are parsed back to semantic JSON.
        Catches: positional association, unknown-result leakage, dropped
        matches, and attaching an error to the wrong tool call.
        """
        call_ids, results, expected = case
        records = [
            _claude_prompt("Run tools"),
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "id": call_id, "name": "Generated", "input": {}}
                        for call_id in call_ids
                    ]
                },
            },
            {"type": "user", "message": {"content": results}},
        ]

        with tempfile.TemporaryDirectory() as td:
            transcript = Path(td) / "session.jsonl"
            _write_jsonl(transcript, records)
            turns, _ = cc_transcript.parse_transcript(transcript)

        actual_calls = turns[0]["steps"][0]["tool_calls"]
        self.assertEqual([call["call_id"] for call in actual_calls], call_ids)
        for call in actual_calls:
            expected_result = expected.get(call["call_id"])
            if expected_result is None:
                self.assertNotIn("output", call)
                self.assertNotIn("error", call)
                continue

            expected_content = expected_result["content"]
            actual_output = call["output"]
            if isinstance(expected_content, str):
                self.assertEqual(actual_output, expected_content)
            else:
                self.assertEqual(json.loads(actual_output), expected_content)

            if expected_result["is_error"]:
                self.assertEqual(call["error"], actual_output)
            else:
                self.assertNotIn("error", call)

    def test_characterization_reconstruct_filters_mtime_and_writes_envelope(self) -> None:
        """Characterization: preserve Claude collection filtering and envelope.

        Oracle: literal fields and inclusive/exclusive mtime boundaries observed
        from the Python reconstruction CLI.
        Catches: collecting another run's session, counting empty sessions, and
        writing an envelope that differs from artifact consumers' expectations.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            projects = root / "projects"
            projects.mkdir()
            old = projects / "old.jsonl"
            selected = projects / "selected.jsonl"
            at_upper_bound = projects / "upper.jsonl"
            empty = projects / "empty.jsonl"
            _write_jsonl(old, [_claude_prompt("old")])
            _write_jsonl(selected, [_claude_prompt("selected")])
            _write_jsonl(at_upper_bound, [_claude_prompt("upper")])
            empty.write_text("")
            os.utime(old, (10, 10))
            os.utime(selected, (20, 20))
            os.utime(empty, (25, 25))
            os.utime(at_upper_bound, (30, 30))
            out = root / "out" / "trace.json"

            payload = cc_transcript.reconstruct(
                str(projects),
                str(out),
                since_mtime=20,
                before_mtime=30,
                run_id="run-1",
                source="claude-code-authoring",
                session_name="Authoring",
            )

            self.assertEqual(json.loads(out.read_text()), payload)

        self.assertEqual(payload["agent"], "claude-code")
        self.assertEqual(payload["run_id"], "run-1")
        self.assertEqual(payload["source"], "claude-code-authoring")
        self.assertEqual(payload["session_name"], "Authoring")
        self.assertEqual(payload["n_sessions"], 1)
        self.assertEqual(Path(payload["sessions"][0]["transcript"]).name, "selected.jsonl")


class CodexRolloutCharacterizationTests(unittest.TestCase):
    def test_characterization_normalizes_stateful_rollout(self) -> None:
        """Characterization: preserve representative Codex state-machine output.

        Oracle: literal observations captured from the Python parser.
        Catches: wrong step delimiters, lost pending tool output, wrapper text
        becoming user input, argument coercion, and completion-state drift.
        """
        records = [
            {"type": "session_meta", "payload": {"id": "codex-session", "cli_version": "1.0"}},
            _codex_task_started(),
            {"type": "turn_context", "payload": {"model": "gpt-test", "effort": "high"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": "<environment_context>ignored wrapper</environment_context>",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "developer",
                    "content": [{"type": "input_text", "text": "fallback prompt"}],
                },
            },
            {"type": "event_msg", "payload": {"type": "user_message", "message": "explicit prompt"}},
            {
                "type": "event_msg",
                "payload": {
                    "type": "exec_command_end",
                    "call_id": "call-b",
                    "status": "failed",
                    "aggregated_output": "boom",
                    "exit_code": 7,
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "call_id": "call-a",
                    "name": "read_file",
                    "arguments": '{"path":"a.txt"}',
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "call_id": "call-b",
                    "name": "shell",
                    "input": "raw command",
                },
            },
            {
                "type": "response_item",
                "payload": {"type": "function_call_output", "call_id": "call-a", "output": {"value": 1}},
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "web_search_call",
                    "id": "web-1",
                    "action": {"query": "Expo", "queries": ["Expo", "Bun"]},
                },
            },
            {"type": "response_item", "payload": {"type": "reasoning", "content": "Think."}},
            {
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "total_tokens": 15,
                            "cached_input_tokens": 2,
                        },
                        "last_token_usage": {"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
                    },
                },
            },
            {
                "type": "response_item",
                "payload": {"type": "message", "role": "assistant", "content": "model final"},
            },
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "event final"}},
            {"type": "event_msg", "payload": {"type": "task_complete"}},
        ]

        with tempfile.TemporaryDirectory() as td:
            rollout = Path(td) / "rollout-test.jsonl"
            _write_jsonl(rollout, records)
            turns, meta = codex_rollout.parse_rollout(rollout)

        self.assertEqual(meta, {"id": "codex-session", "cli_version": "1.0"})
        self.assertEqual(len(turns), 1)
        turn = turns[0]
        self.assertEqual(turn["turn_id"], "turn-1")
        self.assertEqual(turn["user_input"], "explicit prompt")
        self.assertEqual(turn["user_input_fallback"], "fallback prompt")
        self.assertEqual(turn["model"], "gpt-test")
        self.assertEqual(turn["invocation_params"], {"model": "gpt-test", "effort": "high"})
        self.assertEqual(turn["final_output"], "event final")
        self.assertEqual(turn["completed"], True)
        self.assertEqual(turn["aborted"], False)
        self.assertEqual(
            turn["total_usage"],
            {"prompt_tokens": 10, "completion_tokens": 5, "tokens": 15, "cache_read_input_tokens": 2},
        )
        self.assertEqual(len(turn["steps"]), 2)
        self.assertEqual(turn["steps"][0]["reasoning"], "Think.")
        self.assertEqual(
            turn["steps"][0]["usage"],
            {"prompt_tokens": 4, "completion_tokens": 2, "tokens": 6},
        )
        self.assertEqual(
            turn["steps"][0]["tool_calls"],
            [
                {
                    "call_id": "call-a",
                    "name": "read_file",
                    "args": {"path": "a.txt"},
                    "output": {"value": 1},
                },
                {"call_id": "call-b", "name": "shell", "args": "raw command", "error": "boom", "output": "boom"},
                {
                    "call_id": "web-1",
                    "name": "web_search",
                    "args": {
                        "query": "Expo",
                        "queries": ["Expo", "Bun"],
                        "action": {"query": "Expo", "queries": ["Expo", "Bun"]},
                    },
                },
            ],
        )
        self.assertEqual(turn["steps"][1], {"text": "model final", "reasoning": "", "tool_calls": []})

    def test_characterization_flushes_trailing_turn_and_skips_malformed_lines(self) -> None:
        """Characterization: preserve malformed-line and incomplete-turn behavior.

        Oracle: literal output captured from the Python parser.
        Catches: dropping interrupted work or incorrectly marking it complete.
        """
        with tempfile.TemporaryDirectory() as td:
            rollout = Path(td) / "rollout-test.jsonl"
            _write_jsonl(
                rollout,
                [
                    "not-json",
                    _codex_task_started("turn-open"),
                    {
                        "type": "response_item",
                        "payload": {"type": "message", "role": "assistant", "content": "unfinished"},
                    },
                ],
            )
            turns, meta = codex_rollout.parse_rollout(rollout)

        self.assertEqual(meta, {})
        self.assertEqual(
            turns,
            [
                {
                    "turn_id": "turn-open",
                    "turn_index": 1,
                    "steps": [{"text": "unfinished", "reasoning": "", "tool_calls": []}],
                    "completed": False,
                    "aborted": False,
                    "final_output": "unfinished",
                    "user_input": None,
                }
            ],
        )

    def test_characterization_reconstruct_filters_mtime_and_writes_envelope(self) -> None:
        """Characterization: preserve Codex collection filtering and envelope.

        Oracle: literal fields and inclusive/exclusive mtime boundaries observed
        from the Python reconstruction CLI.
        Catches: collecting another run's rollout, counting empty sessions, and
        changing artifact-envelope fields.
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            sessions = root / "sessions"
            sessions.mkdir()
            old = sessions / "rollout-old.jsonl"
            selected = sessions / "rollout-selected.jsonl"
            upper = sessions / "rollout-upper.jsonl"
            empty = sessions / "rollout-empty.jsonl"
            for path, turn_id in ((old, "old"), (selected, "selected"), (upper, "upper")):
                _write_jsonl(path, [_codex_task_started(turn_id)])
            empty.write_text("")
            os.utime(old, (10, 10))
            os.utime(selected, (20, 20))
            os.utime(empty, (25, 25))
            os.utime(upper, (30, 30))
            out = root / "out" / "trace.json"

            payload = codex_rollout.reconstruct(
                str(sessions),
                str(out),
                since_mtime=20,
                before_mtime=30,
                run_id="run-2",
                source="codex-authoring",
                session_name="Codex Authoring",
            )

            self.assertEqual(json.loads(out.read_text()), payload)

        self.assertEqual(payload["agent"], "codex")
        self.assertEqual(payload["run_id"], "run-2")
        self.assertEqual(payload["source"], "codex-authoring")
        self.assertEqual(payload["session_name"], "Codex Authoring")
        self.assertEqual(payload["n_sessions"], 1)
        self.assertEqual(Path(payload["sessions"][0]["rollout"]).name, "rollout-selected.jsonl")


class TraceParserCliCharacterizationTests(unittest.TestCase):
    def test_characterization_parse_only_clis_emit_session_envelope(self) -> None:
        """Characterization: preserve both parse-only CLI envelopes.

        Oracle: literal JSON wrapper and successful exit observed from Python.
        Catches: CLI argument drift, extra stdout, and a missing session wrapper.
        """
        cases = [
            (CC_SCRIPT, [_claude_prompt("hello")], "session-1"),
            (
                CODEX_SCRIPT,
                [
                    {"type": "session_meta", "payload": {"id": "codex-1"}},
                    _codex_task_started(),
                ],
                "codex-1",
            ),
        ]

        for script, records, expected_session_id in cases:
            with self.subTest(script=script.name), tempfile.TemporaryDirectory() as td:
                trace = Path(td) / "trace.jsonl"
                _write_jsonl(trace, records)
                result = subprocess.run(
                    [sys.executable, str(script), "--parse-only", str(trace)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "")
                payload = json.loads(result.stdout)
                self.assertEqual(set(payload), {"session_meta", "turns"})
                self.assertEqual(payload["session_meta"]["id"], expected_session_id)
                self.assertEqual(len(payload["turns"]), 1)


class TraceParserDifferentialTests(unittest.TestCase):
    def test_differential_help_and_accepted_argument_forms_match_python(self) -> None:
        """Differential: Bun preserves argparse help and accepted option forms.

        Oracle: exact help output plus semantic reconstruction equality against
        the Python CLI for abbreviations, --flag=value, and Python float text.
        Catches: migration-only CLI rejection and JavaScript numeric parsing.
        """
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Bun must be on PATH for migration parity tests")
        cases = [
            (CC_SCRIPT, CC_TS_SCRIPT, "--projects", "session.jsonl", [_claude_prompt("same")]),
            (
                CODEX_SCRIPT,
                CODEX_TS_SCRIPT,
                "--sessions",
                "rollout-session.jsonl",
                [{"type": "session_meta", "payload": {"id": "codex-1"}}, _codex_task_started()],
            ),
        ]

        for python_script, typescript_script, directory_flag, filename, records in cases:
            with self.subTest(script=python_script.name), tempfile.TemporaryDirectory() as td:
                python_help = subprocess.run(
                    [sys.executable, str(python_script), "--help"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                typescript_help = subprocess.run(
                    [bun, str(typescript_script), "--help"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(typescript_help.returncode, python_help.returncode)
                self.assertEqual(typescript_help.stdout, python_help.stdout)
                self.assertEqual(typescript_help.stderr, python_help.stderr)

                root = Path(td)
                source = root / "source"
                source.mkdir()
                _write_jsonl(source / filename, records)
                python_out = root / "python.json"
                typescript_out = root / "typescript.json"
                common_args = [
                    f"{directory_flag}={source}",
                    "--since=0_0",
                    "--before=inf",
                    "--run=run-cli",
                    "--source=cli-diff",
                    "--session-n=CLI Differential",
                ]
                python_result = subprocess.run(
                    [sys.executable, str(python_script), *common_args, f"--out={python_out}"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                typescript_result = subprocess.run(
                    [bun, str(typescript_script), *common_args, f"--out={typescript_out}"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(typescript_result.returncode, python_result.returncode)
                self.assertEqual(json.loads(typescript_out.read_text()), json.loads(python_out.read_text()))

                invalid_python = subprocess.run(
                    [sys.executable, str(python_script), "--since=0x1", f"--out={python_out}"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                invalid_typescript = subprocess.run(
                    [bun, str(typescript_script), "--since=0x1", f"--out={typescript_out}"],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(invalid_typescript.returncode, invalid_python.returncode)

    def test_differential_truthy_malformed_records_fail_the_same_session(self) -> None:
        """Differential: malformed truthy message/payload shapes are not fabricated.

        Oracle: both parse-only CLIs fail and both reconstruction CLIs skip the
        malformed session while retaining a valid sibling session.
        Catches: silently replacing truthy non-object fields with empty objects.
        """
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Bun must be on PATH for migration parity tests")
        cases = [
            (
                CC_SCRIPT,
                CC_TS_SCRIPT,
                "--projects-dir",
                "bad.jsonl",
                {"type": "user", "message": "not-an-object"},
                "good.jsonl",
                _claude_prompt("valid"),
            ),
            (
                CODEX_SCRIPT,
                CODEX_TS_SCRIPT,
                "--sessions-dir",
                "rollout-bad.jsonl",
                {"type": "event_msg", "payload": "not-an-object"},
                "rollout-good.jsonl",
                _codex_task_started("valid"),
            ),
        ]

        for python_script, typescript_script, directory_flag, bad_name, bad_record, good_name, good_record in cases:
            with self.subTest(script=python_script.name), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                source = root / "source"
                source.mkdir()
                bad = source / bad_name
                good = source / good_name
                _write_jsonl(bad, [bad_record])
                _write_jsonl(good, [good_record])
                os.utime(bad, (10, 10))
                os.utime(good, (20, 20))

                python_parse = subprocess.run(
                    [sys.executable, str(python_script), "--parse-only", str(bad)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                typescript_parse = subprocess.run(
                    [bun, str(typescript_script), "--parse-only", str(bad)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(python_parse.returncode, 0)
                self.assertNotEqual(typescript_parse.returncode, 0)

                python_out = root / "python.json"
                typescript_out = root / "typescript.json"
                python_result = subprocess.run(
                    [sys.executable, str(python_script), directory_flag, str(source), "--out", str(python_out)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                typescript_result = subprocess.run(
                    [bun, str(typescript_script), directory_flag, str(source), "--out", str(typescript_out)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(typescript_result.returncode, python_result.returncode)
                self.assertEqual(json.loads(typescript_out.read_text()), json.loads(python_out.read_text()))

    def test_differential_parse_only_outputs_match_python(self) -> None:
        """Differential: Python and Bun normalize the same records identically.

        Oracle: semantic equality between both independently executed CLIs.
        Catches: state-machine, Unicode, structured-output, and schema drift.
        """
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Bun must be on PATH for migration parity tests")
        cases = [
            (
                CC_SCRIPT,
                CC_TS_SCRIPT,
                [
                    _claude_prompt("héllo"),
                    {
                        "type": "assistant",
                        "message": {
                            "model": "claude-test",
                            "content": [
                                {"type": "text", "text": "working"},
                                {
                                    "type": "tool_use",
                                    "id": "call-1",
                                    "name": "Generated",
                                    "input": {"path": "café.txt"},
                                },
                            ],
                            "usage": {"input_tokens": 2, "output_tokens": 1},
                        },
                    },
                    {
                        "type": "user",
                        "message": {
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "call-1",
                                    "content": {
                                        "greeting": "héllo",
                                        "items": [1, True, None],
                                        "whole_float": 1.0,
                                        "small_float": 1e-7,
                                        "plain_decimal": 0.0001,
                                        "large_float": 1e16,
                                        "negative_zero": -0.0,
                                        "huge_integer": 2**80,
                                    },
                                }
                            ]
                        },
                    },
                ],
            ),
            (
                CODEX_SCRIPT,
                CODEX_TS_SCRIPT,
                [
                    {"type": "session_meta", "payload": {"id": "codex-diff"}},
                    _codex_task_started("turn-diff"),
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "exec_command_end",
                            "call_id": "call-1",
                            "status": "failed",
                            "stderr": "nope",
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call",
                            "call_id": "call-1",
                            "name": "shell",
                            "arguments": '{"command":"echo héllo","huge":1208925819614629174706176}',
                        },
                    },
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "custom_tool_call",
                            "call_id": "call-2",
                            "name": "missing-input",
                        },
                    },
                    {"type": "event_msg", "payload": {"type": "task_complete"}},
                ],
            ),
        ]

        for python_script, typescript_script, records in cases:
            with self.subTest(script=python_script.name), tempfile.TemporaryDirectory() as td:
                trace = Path(td) / "trace.jsonl"
                _write_jsonl(trace, records)
                python_result = subprocess.run(
                    [sys.executable, str(python_script), "--parse-only", str(trace)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                typescript_result = subprocess.run(
                    [bun, str(typescript_script), "--parse-only", str(trace)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )

                self.assertEqual(typescript_result.returncode, python_result.returncode)
                self.assertEqual(typescript_result.stderr, python_result.stderr)
                self.assertEqual(json.loads(typescript_result.stdout), json.loads(python_result.stdout))

    def test_differential_reconstruction_envelopes_match_python(self) -> None:
        """Differential: Python and Bun collect the same files and envelope.

        Oracle: exact semantic equality after parsing each output JSON file.
        Catches: file discovery, mtime filtering, ordering, and CLI-default drift.
        """
        bun = shutil.which("bun")
        self.assertIsNotNone(bun, "Bun must be on PATH for migration parity tests")
        cases = [
            (
                CC_SCRIPT,
                CC_TS_SCRIPT,
                "--projects-dir",
                "session.jsonl",
                [_claude_prompt("same input")],
            ),
            (
                CODEX_SCRIPT,
                CODEX_TS_SCRIPT,
                "--sessions-dir",
                "rollout-session.jsonl",
                [{"type": "session_meta", "payload": {"id": "codex-1"}}, _codex_task_started()],
            ),
        ]

        for python_script, typescript_script, directory_flag, filename, records in cases:
            with self.subTest(script=python_script.name), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                source = root / "source"
                source.mkdir()
                _write_jsonl(source / filename, records)
                python_out = root / "python.json"
                typescript_out = root / "typescript.json"
                common_args = [
                    directory_flag,
                    str(source),
                    "--since-mtime",
                    "0",
                    "--run-id",
                    "run-diff",
                    "--source",
                    "differential",
                    "--session-name",
                    "Differential Session",
                    "--braintrust",
                ]
                environment = {key: value for key, value in os.environ.items() if key != "BRAINTRUST_API_KEY"}
                python_result = subprocess.run(
                    [sys.executable, str(python_script), *common_args, "--out", str(python_out)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                    env=environment,
                )
                typescript_result = subprocess.run(
                    [bun, str(typescript_script), *common_args, "--out", str(typescript_out)],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                    env=environment,
                )

                self.assertEqual(typescript_result.returncode, python_result.returncode)
                self.assertEqual(json.loads(typescript_out.read_text()), json.loads(python_out.read_text()))


if __name__ == "__main__":
    unittest.main()
