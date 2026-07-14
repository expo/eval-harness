"""
Hook callbacks for the Claude Agent SDK driver.

These hooks exist solely to capture per-tool execution durations. The tracer
records turn-level events from AssistantMessage / UserMessage content directly
(see `_TurnAggregator` in evaluator.py) — hooks contribute only the timing
information that isn't otherwise available from the message stream.

Hooks fire on `mcp__adaptive__*` tools (our MCP server's tools).
"""

from __future__ import annotations

import time
from typing import Any

from claude_agent_sdk import HookMatcher


_TOOL_NAMESPACE_PREFIX = "mcp__adaptive__"


def build_hooks(tool_timing: dict[str, dict]) -> dict[str, list[HookMatcher]]:
    """
    Returns a hooks dict for ClaudeAgentOptions(hooks=...).

    `tool_timing` is a shared dict the runner reads when flushing turn records.
    Each entry is keyed by `tool_use_id` and holds:
        {"started_ts": float, "duration_ms": float|None, "error": str|None}
    """

    async def on_pre_tool(input_data: dict[str, Any], tool_use_id: str | None, context: Any):
        if tool_use_id:
            tool_timing[tool_use_id] = {"started_ts": time.time()}
        return {}

    async def on_post_tool(input_data: dict[str, Any], tool_use_id: str | None, context: Any):
        if tool_use_id and tool_use_id in tool_timing:
            started = tool_timing[tool_use_id].get("started_ts")
            if started is not None:
                tool_timing[tool_use_id]["duration_ms"] = round((time.time() - started) * 1000, 1)
        return {}

    async def on_post_tool_failure(input_data: dict[str, Any], tool_use_id: str | None, context: Any):
        if tool_use_id and tool_use_id in tool_timing:
            started = tool_timing[tool_use_id].get("started_ts")
            if started is not None:
                tool_timing[tool_use_id]["duration_ms"] = round((time.time() - started) * 1000, 1)
            tool_timing[tool_use_id]["error"] = str(input_data.get("error") or "")
        return {}

    matcher = "^mcp__adaptive__"
    return {
        "PreToolUse": [HookMatcher(matcher=matcher, hooks=[on_pre_tool])],
        "PostToolUse": [HookMatcher(matcher=matcher, hooks=[on_post_tool])],
        "PostToolUseFailure": [HookMatcher(matcher=matcher, hooks=[on_post_tool_failure])],
    }
