"""
Buffers Claude Agent SDK message stream into per-turn JSONL trace records.

The SDK delivers an Anthropic API response as one-or-many `AssistantMessage`
events with a shared `message_id` (streaming partials), followed by a
`UserMessage` carrying `ToolResultBlock`s once the SDK has dispatched any
tool calls in that response.

`TurnAggregator` collects those events into a single "turn" structure
(thinking + text + tool_uses with paired results + per-tool durations) and
flushes one JSONL record to the tracer per actual API response. The result
is a clean per-API-response view of the conversation, with no partial-message
fragmentation.

`UsageAccumulator` sums input/output/cache tokens and cost across responses.

Both evaluators (`maestro_evaluator.py`, `agent_device_evaluator.py`) reuse
these directly — they are driver-agnostic.
"""

from __future__ import annotations

import time

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from claude_agent_sdk.types import ThinkingBlock

from .tool_state import StepState
from .tracer import Tracer


# Both Maestro and agent-device tools register under MCP server name "adaptive",
# so the SDK exposes them as `mcp__adaptive__<tool_name>`. We strip this prefix
# when writing turn records so trace consumers see clean tool names.
_MCP_PREFIX = "mcp__adaptive__"


def short_repr(payload, max_len: int = 80) -> str:
    s = repr(payload) if not isinstance(payload, str) else payload
    return s if len(s) <= max_len else s[:max_len] + "..."


class UsageAccumulator:
    """Sums token / cost usage across the assistant responses we observe."""

    def __init__(self):
        self.input_tokens = 0
        self.output_tokens = 0
        self.cache_creation_input_tokens = 0
        self.cache_read_input_tokens = 0
        self.total_cost_usd = 0.0
        self.n_responses = 0

    def add(self, usage: dict, cost: float | None) -> None:
        if not usage and cost is None:
            return
        self.input_tokens += int(usage.get("input_tokens") or 0)
        self.output_tokens += int(usage.get("output_tokens") or 0)
        self.cache_creation_input_tokens += int(usage.get("cache_creation_input_tokens") or 0)
        self.cache_read_input_tokens += int(usage.get("cache_read_input_tokens") or 0)
        if cost is not None:
            self.total_cost_usd += float(cost)
        self.n_responses += 1

    def snapshot(self) -> dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "total_cost_usd": round(self.total_cost_usd, 6),
            "n_responses": self.n_responses,
        }


class TurnAggregator:
    """
    Buffers Anthropic API response content blocks (which the SDK delivers as
    one-or-many `AssistantMessage` events all sharing a `message_id`) and emits
    exactly one `turn` JSONL record per actual API response.

    Pairs `ToolResultBlock`s (delivered as `UserMessage.content`) into the
    in-flight turn's tool_uses by tool_use_id.
    """

    def __init__(
        self,
        step_number: int,
        tracer: Tracer,
        tool_timing: dict,
        state: StepState,
        verbose: bool,
        plan_start_time: float,
    ):
        self.step_number = step_number
        self.tracer = tracer
        self.tool_timing = tool_timing
        self.state = state
        self.verbose = verbose
        self.plan_start_time = plan_start_time
        # In-flight turn buffer:
        self._current_message_id: str | None = None
        self._current_turn: dict | None = None
        self.step_usage = UsageAccumulator()
        self.sdk_result: dict | None = None

    # ----- SDK message handlers -----

    def on_assistant(self, message: AssistantMessage) -> None:
        msg_id = getattr(message, "message_id", None)
        if msg_id != self._current_message_id and self._current_turn is not None:
            # New API response — flush the previous one.
            self.flush(reason="new_message_id")

        if self._current_turn is None:
            # Start a new turn record.
            self.state.turns_used += 1
            self._current_message_id = msg_id
            self._current_turn = {
                "event": "turn",
                "step": self.step_number,
                "turn": self.state.turns_used,
                "message_id": msg_id,
                "started_elapsed_s": round(time.time() - self.plan_start_time, 3),
                "thinking": "",
                "text": "",
                "tool_uses": [],
                "stop_reason": None,
                "usage": None,
            }
            if self.verbose:
                print(f"\n  ─── Turn {self.state.turns_used} ───")

        # Append blocks from this delivery to the in-flight turn.
        for block in message.content:
            if isinstance(block, ThinkingBlock):
                self._current_turn["thinking"] += block.thinking
            elif isinstance(block, TextBlock):
                self._current_turn["text"] += block.text
            elif isinstance(block, ToolUseBlock):
                self._current_turn["tool_uses"].append({
                    "tool": block.name.replace(_MCP_PREFIX, ""),
                    "tool_use_id": block.id,
                    "input": block.input,
                    "result_text": None,
                    "success": None,
                    "duration_ms": None,
                })

        # Capture per-response stop_reason and usage when present.
        if getattr(message, "stop_reason", None):
            self._current_turn["stop_reason"] = message.stop_reason
        if getattr(message, "usage", None):
            self._current_turn["usage"] = dict(message.usage)
            self.step_usage.add(message.usage, None)

    def on_user(self, message: UserMessage) -> None:
        """UserMessage carries tool_results — pair them into the in-flight turn."""
        if self._current_turn is None:
            return
        content = message.content
        if isinstance(content, list):
            for block in content:
                if isinstance(block, ToolResultBlock):
                    self._attach_tool_result(block)
        # tool_results arrived → this turn's API response is complete. Flush.
        self.flush(reason="tool_results_received")

    def on_result(self, message: ResultMessage) -> None:
        # Flush any in-flight turn first.
        self.flush(reason="result_message")
        self.sdk_result = {
            "subtype": getattr(message, "subtype", None),
            "stop_reason": getattr(message, "stop_reason", None),
            "num_turns": getattr(message, "num_turns", None),
            "duration_ms": getattr(message, "duration_ms", None),
            "duration_api_ms": getattr(message, "duration_api_ms", None),
            "total_cost_usd": message.total_cost_usd,
            "usage": message.usage,
        }

    # ----- Internals -----

    def _attach_tool_result(self, block: ToolResultBlock) -> None:
        for tu in self._current_turn["tool_uses"]:
            if tu["tool_use_id"] == block.tool_use_id:
                content = block.content
                if isinstance(content, list):
                    parts = []
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            parts.append(c.get("text", ""))
                    tu["result_text"] = "\n".join(parts)
                elif isinstance(content, str):
                    tu["result_text"] = content
                tu["success"] = not (block.is_error or False)
                # Per-tool duration from hooks.
                timing = self.tool_timing.pop(block.tool_use_id, None)
                if timing and timing.get("duration_ms") is not None:
                    tu["duration_ms"] = timing["duration_ms"]
                return

    def flush(self, reason: str) -> None:
        if self._current_turn is None:
            return
        turn = self._current_turn
        turn["flush_reason"] = reason
        turn["finished_elapsed_s"] = round(time.time() - self.plan_start_time, 3)
        turn["duration_s"] = round(
            turn["finished_elapsed_s"] - turn["started_elapsed_s"], 3
        )
        self.tracer.log_record(turn)
        if self.verbose:
            self._print_turn(turn)
        self._current_turn = None
        self._current_message_id = None

    def _print_turn(self, turn: dict) -> None:
        if turn["thinking"]:
            print(f"  💭 thinking:")
            for line in turn["thinking"].splitlines()[:8]:
                print(f"     {line}")
        if turn["text"]:
            print(f"  🧠 reasoning:")
            for line in turn["text"].splitlines():
                print(f"     {line}")
        for tu in turn["tool_uses"]:
            status = "✅" if tu["success"] else "❌" if tu["success"] is False else "·"
            dur = f"{tu['duration_ms']/1000:.1f}s" if tu["duration_ms"] else "-"
            print(f"  → {tu['tool']} {short_repr(tu['input'])}  [{status} {dur}]")
