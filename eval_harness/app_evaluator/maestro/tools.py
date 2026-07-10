"""
SDK tools for the **Maestro** driver path of the adaptive evaluator.

Each tool either wraps a call into `MaestroBridge` (which produces Maestro YAML
under the hood) or mutates per-step scoring state in `StepState`. Tools are
registered as a single in-process MCP server (named "adaptive") and exposed to
the model as `mcp__adaptive__<tool_name>`.

The parallel agent-device path lives in `agent_device_tools.py` with the same
tool names and shape but a different bridge underneath.
"""

from typing import Any

from claude_agent_sdk import tool, create_sdk_mcp_server

from ..core.scoring import AssertionResult, SoftAssertionResult
from . import hierarchy_parser
from .bridge import MaestroBridge
from ..core.tool_state import StepState, ToolContext  # re-exported for back-compat


def _ok(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _err(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


def build_tools(ctx: ToolContext):
    """
    Build the set of tools that close over `ctx` (bridge + current step state).
    Returns (mcp_server_config, tool_names) where tool_names matches what the
    SDK exposes to the model (without the mcp__ prefix the SDK adds).
    """

    # ----- Look -----

    @tool(
        "capture_screen",
        "Capture the current accessibility tree of the app on screen. Returns a "
        "compressed text view of targetable elements (one element per line: "
        "[id] \"text\" [bounds] flags). Call this whenever the screen may have "
        "changed (after tapping a button, navigating, restarting the app) and "
        "before deciding what to do next. The element IDs you see here are the "
        "ones you should use in tap_element, assert_visible, etc.",
        {},
    )
    async def capture_screen(args: dict) -> dict:
        try:
            raw = ctx.bridge.capture_hierarchy()
            return _ok(hierarchy_parser.parse(raw))
        except Exception as e:
            return _err(f"capture failed: {e}")

    # ----- Act: taps -----

    @tool(
        "tap_element",
        "Tap an element by its testID/resource-id. This is the preferred way to "
        "interact with the app — element IDs are stable across runs. After tapping "
        "something that navigates or changes the screen, call capture_screen again "
        "before the next action.",
        {"id": str},
    )
    async def tap_element(args: dict) -> dict:
        yaml = f"- tapOn:\n    id: \"{args['id']}\"\n"
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"tapped id={args['id']!r}")
        return _err(f"tap failed: {result.error or result.output[:200]}")

    @tool(
        "tap_by_text",
        "Tap an element by its visible text label. Use only when no element id is "
        "available — text is fragile (casing, hidden whitespace). If multiple "
        "elements share the same text, the first match is tapped, which may be "
        "wrong; prefer tap_element with id, or tap_at_point with coordinates.",
        {"text": str},
    )
    async def tap_by_text(args: dict) -> dict:
        yaml = f"- tapOn: \"{args['text']}\"\n"
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"tapped text={args['text']!r}")
        return _err(f"tap_by_text failed: {result.error or result.output[:200]}")

    @tool(
        "tap_at_point",
        "Tap at exact screen coordinates. Last-resort fallback when an element has "
        "no id and its text is ambiguous (e.g. multiple identical 'Delete' buttons). "
        "Compute the center from the element's bounds in the accessibility tree.",
        {"x": int, "y": int},
    )
    async def tap_at_point(args: dict) -> dict:
        yaml = f"- tapOn:\n    point: \"{args['x']},{args['y']}\"\n"
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"tapped at ({args['x']}, {args['y']})")
        return _err(f"tap_at_point failed: {result.error or result.output[:200]}")

    # ----- Act: text input -----

    @tool(
        "fill_field",
        "Type text into the currently focused field, replacing any existing content. "
        "You must call tap_element on the input field FIRST to give it focus. "
        "Empty strings are not supported by Maestro — to clear a field, fill it with "
        "a single space character or use erase_text.",
        {"text": str},
    )
    async def fill_field(args: dict) -> dict:
        text = args["text"].replace("\"", "\\\"")
        yaml = f"- inputText: \"{text}\"\n"
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"typed {len(args['text'])} chars")
        return _err(f"fill_field failed: {result.error or result.output[:200]}")

    @tool(
        "erase_text",
        "Erase N characters from the currently focused field. Use this to clear a "
        "field before typing fresh content.",
        {"count": int},
    )
    async def erase_text(args: dict) -> dict:
        yaml = f"- eraseText: {args['count']}\n"
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"erased {args['count']} chars")
        return _err(f"erase_text failed: {result.error or result.output[:200]}")

    # ----- Act: scrolling / gestures -----

    @tool(
        "scroll",
        "Scroll the current view downward (default) to reveal off-screen content.",
        {},
    )
    async def scroll(args: dict) -> dict:
        result = ctx.bridge.execute_yaml("- scroll\n")
        return _ok("scrolled") if result.success else _err(f"scroll failed: {result.error}")

    @tool(
        "scroll_until_visible",
        "Scroll the screen until an element with the given id appears. Useful for "
        "long lists.",
        {"id": str},
    )
    async def scroll_until_visible(args: dict) -> dict:
        yaml = (
            "- scrollUntilVisible:\n"
            "    element:\n"
            f"      id: \"{args['id']}\"\n"
        )
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"scrolled to id={args['id']!r}")
        return _err(f"scroll_until_visible failed: {result.error or result.output[:200]}")

    @tool(
        "swipe",
        "Swipe in a direction across the screen.",
        {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["LEFT", "RIGHT", "UP", "DOWN"]}
            },
            "required": ["direction"],
        },
    )
    async def swipe(args: dict) -> dict:
        yaml = f"- swipe:\n    direction: {args['direction']}\n"
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"swiped {args['direction']}")
        return _err(f"swipe failed: {result.error or result.output[:200]}")

    @tool(
        "long_press",
        "Long-press on an element by id. Used to trigger context menus or "
        "long-press-only actions.",
        {"id": str},
    )
    async def long_press(args: dict) -> dict:
        yaml = f"- longPress:\n    id: \"{args['id']}\"\n"
        result = ctx.bridge.execute_yaml(yaml)
        if result.success:
            return _ok(f"long-pressed id={args['id']!r}")
        return _err(f"long_press failed: {result.error or result.output[:200]}")

    # ----- Act: lifecycle / platform -----

    @tool(
        "wait_for_animation",
        "Wait for any in-progress animations to settle. Use after navigation-y "
        "actions if the next screen seems to be loading.",
        {},
    )
    async def wait_for_animation(args: dict) -> dict:
        result = ctx.bridge.execute_yaml("- waitForAnimationToEnd\n")
        return _ok("waited") if result.success else _err(f"wait failed: {result.error}")

    @tool(
        "press_back",
        "Press the Android hardware/navigation back button. ONLY meaningful on "
        "Android. On iOS, tap the visible back button via tap_element instead.",
        {},
    )
    async def press_back(args: dict) -> dict:
        result = ctx.bridge.execute_yaml("- back\n")
        return _ok("pressed back") if result.success else _err(f"back failed: {result.error}")

    @tool(
        "hide_keyboard",
        "Dismiss the on-screen keyboard. UNRELIABLE on iOS — prefer tap_at_point "
        "on a non-interactive area (e.g. coordinates near the top of the screen). "
        "On Android, this is usually fine but `press_back` is a fallback.",
        {},
    )
    async def hide_keyboard(args: dict) -> dict:
        result = ctx.bridge.execute_yaml("- hideKeyboard\n")
        return _ok("hid keyboard") if result.success else _err(f"hide_keyboard failed: {result.error}")

    @tool(
        "restart_app",
        "Restart the app on the device. Use this when the app is in an unrecoverable "
        "state, or when you see no targetable elements on screen. Does NOT clear app "
        "data — only restarts the process. Returns once the app is back on screen.",
        {},
    )
    async def restart_app(args: dict) -> dict:
        result = ctx.bridge.restart_app()
        if result.success:
            return _ok("app restarted")
        return _err(f"restart_app failed: {result.error or result.output[:200]}")

    # ----- Verify: hard assertions (Maestro executes) -----

    @tool(
        "assert_visible",
        "Hard assertion: verify an element with the given id IS on screen. The "
        "Maestro engine checks this — if the element is missing, the assertion "
        "fails. Use `fatal=true` for assertions the test step MUST pass (e.g. "
        "'verify the notes-list screen appears after unlocking'); use `fatal=false` "
        "for partial-credit checks.",
        {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "fatal": {"type": "boolean"},
            },
            "required": ["id"],
        },
    )
    async def assert_visible(args: dict) -> dict:
        fatal = bool(args.get("fatal", False))
        yaml_cmd = f"- assertVisible:\n    id: \"{args['id']}\"\n"
        result = ctx.bridge.execute_yaml(yaml_cmd)
        passed = result.success
        ctx.state.assertions.append(AssertionResult(yaml_cmd=yaml_cmd.strip(), fatal=fatal, passed=passed))
        if fatal and not passed:
            ctx.state.fatal_failed = True
        status = "PASS" if passed else "FAIL"
        fatal_tag = " [FATAL]" if fatal else ""
        return _ok(f"assert_visible id={args['id']!r} → {status}{fatal_tag}")

    @tool(
        "assert_not_visible",
        "Hard assertion: verify an element with the given id is NOT on screen. "
        "Use for 'after deletion, the note should be gone' style checks.",
        {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "fatal": {"type": "boolean"},
            },
            "required": ["id"],
        },
    )
    async def assert_not_visible(args: dict) -> dict:
        fatal = bool(args.get("fatal", False))
        yaml_cmd = f"- assertNotVisible:\n    id: \"{args['id']}\"\n"
        result = ctx.bridge.execute_yaml(yaml_cmd)
        passed = result.success
        ctx.state.assertions.append(AssertionResult(yaml_cmd=yaml_cmd.strip(), fatal=fatal, passed=passed))
        if fatal and not passed:
            ctx.state.fatal_failed = True
        status = "PASS" if passed else "FAIL"
        fatal_tag = " [FATAL]" if fatal else ""
        return _ok(f"assert_not_visible id={args['id']!r} → {status}{fatal_tag}")

    # ----- Verify: soft assertions (you read the AT and judge) -----

    @tool(
        "record_soft_assertion",
        "Record a content-based verification you made by reading the accessibility "
        "tree. Use for things Maestro can't structurally check: 'the note title is "
        "exactly \"Daily Tasks\"', 'the error message says \"Incorrect password\"', "
        "'the search field's value is empty'. Always include `evidence` citing the "
        "specific element/text you observed in the most recent capture_screen output.",
        {
            "type": "object",
            "properties": {
                "check": {"type": "string", "description": "What you verified, in plain English."},
                "passed": {"type": "boolean", "description": "Did the check pass?"},
                "fatal": {"type": "boolean", "description": "If true, a failure of this check zero-points the step."},
                "evidence": {"type": "string", "description": "Cite the AT element/text supporting your judgment."},
            },
            "required": ["check", "passed", "fatal", "evidence"],
        },
    )
    async def record_soft_assertion(args: dict) -> dict:
        sa = SoftAssertionResult(
            check=args["check"],
            passed=bool(args["passed"]),
            fatal=bool(args["fatal"]),
            evidence=args.get("evidence", ""),
        )
        ctx.state.soft_assertions.append(sa)
        if sa.fatal and not sa.passed:
            ctx.state.fatal_failed = True
        status = "PASS" if sa.passed else "FAIL"
        fatal_tag = " [FATAL]" if sa.fatal else ""
        return _ok(f"soft assertion recorded → {status}{fatal_tag}")

    # ----- Step lifecycle -----

    @tool(
        "complete_step",
        "Signal that you've finished this test step. Call this ONLY after you have "
        "recorded every verification listed in the step's description — both hard "
        "(assert_visible / assert_not_visible) and soft (record_soft_assertion). "
        "Do NOT call this if any required verification is still missing. After this, "
        "the orchestrator will give you the next step's description.",
        {"summary": str},
    )
    async def complete_step(args: dict) -> dict:
        new_summary = args.get("summary", "")
        if not (ctx.state.complete_summary or "").strip().upper().startswith("N/A"):
            ctx.state.complete_summary = new_summary
        ctx.state.completed = True
        return _ok(f"step marked complete: {new_summary}")

    tool_funcs = [
        capture_screen,
        tap_element, tap_by_text, tap_at_point,
        fill_field, erase_text,
        scroll, scroll_until_visible, swipe, long_press,
        wait_for_animation, press_back, hide_keyboard, restart_app,
        assert_visible, assert_not_visible, record_soft_assertion,
        complete_step,
    ]
    server = create_sdk_mcp_server(name="adaptive", version="1.0.0", tools=tool_funcs)
    tool_names = [f.name for f in tool_funcs]
    return server, tool_names
