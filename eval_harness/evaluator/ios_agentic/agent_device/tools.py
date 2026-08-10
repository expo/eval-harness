"""
SDK tools for the **agent-device** driver path of the adaptive evaluator.

Mirrors `maestro_tools.py`'s shape — same `build_tools(ctx)` factory, same MCP
server name ("adaptive"), same tool names, same per-step scoring side-channel
via `StepState`. The bodies dispatch to `AgentDeviceBridge` instead of
`MaestroBridge`. The bridge calls `xcrun simctl` for app lifecycle and
`agent-device` CLI for UI interactions.

One LLM-visible schema divergence vs the Maestro path: `fill_field` here takes
`{id, text}` together (agent-device's `fill` does focus+type in one call).
The Maestro path requires the LLM to `tap_element` first then `fill_field` with
just `{text}`. Everything else looks identical to the model.
"""

import os
from typing import Any

from claude_agent_sdk import tool, create_sdk_mcp_server

from ..core.scoring import AssertionResult, SoftAssertionResult
from .bridge import AgentDeviceBridge
from ..core.tool_state import StepState, ToolContext


def _ok(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _err(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


def _driver_error(prefix: str, error: str | None, output: str, limit: int = 1200) -> dict[str, Any]:
    detail = (error or output or "").strip()
    if len(detail) > limit:
        detail = detail[:limit] + "... [truncated]"
    return _err(f"{prefix}: {detail or 'unknown error'}")


def build_tools(ctx: ToolContext):
    """
    Build the set of tools that close over `ctx` (AgentDeviceBridge + StepState).
    Returns (mcp_server_config, tool_names). Tool names match maestro_tools so
    the shared system prompt works for either driver.
    """

    # ----- Look -----

    @tool(
        "capture_screen",
        "Capture the current accessibility tree of the app on screen. Returns a "
        "compressed text view of targetable elements (one element per line: "
        "`@eN [type] \"label\"` with element IDs as `id=\"...\"` when available). "
        "Call this whenever the screen may have changed (after tapping a button, "
        "navigating, restarting the app) and before deciding what to do next. "
        "Use the element IDs you see here as the `id` argument for tap_element, "
        "assert_visible, etc.",
        {},
    )
    async def capture_screen(args: dict) -> dict:
        try:
            return _ok(ctx.bridge.capture_hierarchy())
        except Exception as e:
            return _err(f"capture failed: {e}")

    @tool(
        "capture_screenshot",
        "Capture a PNG screenshot of the current simulator screen and return the "
        "path on disk. Use this for visual evidence after navigating to a "
        "feature-relevant screen. The harness saves screenshots under the "
        "current evaluator trace directory when available.",
        {},
    )
    async def capture_screenshot(args: dict) -> dict:
        try:
            r = ctx.bridge.capture_screenshot()
            if r.success:
                return _ok(f"screenshot: {r.output}")
            return _err(f"capture_screenshot failed: {r.error or r.output[:200]}")
        except Exception as e:
            return _err(f"capture_screenshot failed: {e}")

    # ----- Act: taps -----

    @tool(
        "tap_element",
        "Tap an element by its testID/resource-id (preferred — stable across runs) "
        "OR by its transient snapshot ref (e.g. `e78` or `@e78`). Use a ref when "
        "the element has NO `id=\"...\"` annotation in the latest snapshot — common "
        "for iOS native system UI like UIAlertController buttons in confirmation "
        "dialogs, where you'd see `@e79 [button] \"Delete\"` with no id. Refs are "
        "only valid against the most recent snapshot; re-capture before reusing. "
        "After tapping something that navigates or changes the screen, call "
        "capture_screen again before the next action.",
        {"id": str},
    )
    async def tap_element(args: dict) -> dict:
        r = ctx.bridge.tap_id(args["id"])
        if r.success:
            return _ok(f"tapped id={args['id']!r}")
        return _err(f"tap_element failed: {r.error or r.output[:200]}")

    @tool(
        "tap_by_text",
        "Tap an element by its visible text label. Use only when no element id is "
        "available — text is fragile (casing, hidden whitespace). If multiple "
        "elements share the same text, the first match is tapped, which may be "
        "wrong; prefer tap_element with id, or tap_at_point with coordinates.",
        {"text": str},
    )
    async def tap_by_text(args: dict) -> dict:
        r = ctx.bridge.tap_label(args["text"])
        if r.success:
            return _ok(f"tapped text={args['text']!r}")
        return _err(f"tap_by_text failed: {r.error or r.output[:200]}")

    @tool(
        "tap_at_point",
        "Tap at exact screen coordinates. Last-resort fallback when an element has "
        "no id and its text is ambiguous (e.g. multiple identical 'Delete' buttons). "
        "Compute the center from the element's bounds in the accessibility tree.",
        {"x": int, "y": int},
    )
    async def tap_at_point(args: dict) -> dict:
        r = ctx.bridge.tap_point(args["x"], args["y"])
        if r.success:
            return _ok(f"tapped at ({args['x']}, {args['y']})")
        return _err(f"tap_at_point failed: {r.error or r.output[:200]}")

    # ----- Act: text input -----

    @tool(
        "fill_field",
        "Type text into the field identified by `id`. This focuses the field and "
        "types in a single call — no need to tap_element on the field first. "
        "Replaces any existing content. Empty strings are NOT supported here; to "
        "clear a field to empty, use the `erase_text` tool with the same `id`.",
        {"id": str, "text": str},
    )
    async def fill_field(args: dict) -> dict:
        r = ctx.bridge.fill(args["id"], args["text"])
        if r.success:
            return _ok(f"typed {len(args['text'])} chars into id={args['id']!r}")
        return _driver_error(
            "TERMINAL_TEXT_ENTRY_FAILURE: fill_field failed after trying id, "
            "snapshot-ref, coordinate, and type fallbacks. Do not retry this "
            "field/search route; if setup depends on this text entry and no "
            "non-text route works, call complete_step with SETUP BLOCKED",
            r.error,
            r.output,
        )

    @tool(
        "erase_text",
        "Clear all text in the field identified by `id`. Use this when you need "
        "the field to become EMPTY (e.g. clear a search input to show all "
        "items). To merely replace existing text with new text, prefer "
        "`fill_field` — it clears-then-types in one call. Implementation: "
        "focuses the field, long-presses to open the iOS Edit menu, taps "
        "Select All then Cut. "
        "LIMITATION: iOS may block the Cut action on `securetextfield` "
        "elements (password / secure-entry fields) for clipboard-safety "
        "reasons, causing erase_text to fail. If erase_text fails on a "
        "secure field and your next step is to type new content into it, "
        "skip the clear and call `fill_field` directly — it replaces "
        "existing content in one call, so the clear-then-type pattern "
        "collapses into a single fill. If you genuinely need the secure "
        "field to be empty (not replaced), there is no clean workaround "
        "today; record the limitation in your soft-assertion evidence.",
        {"id": str},
    )
    async def erase_text(args: dict) -> dict:
        r = ctx.bridge.erase_text(args["id"])
        if r.success:
            return _ok(f"cleared id={args['id']!r}")
        return _err(f"erase_text failed: {r.error or r.output[:200]}")

    # ----- Act: scrolling / gestures -----

    @tool(
        "scroll",
        "Scroll the current view downward (default) to reveal off-screen content.",
        {},
    )
    async def scroll(args: dict) -> dict:
        r = ctx.bridge.scroll("down")
        return _ok("scrolled") if r.success else _err(f"scroll failed: {r.error}")

    @tool(
        "scroll_until_visible",
        "Scroll the screen repeatedly until an element with the given id appears, "
        "up to a small fixed number of attempts. Useful for long lists.",
        {"id": str},
    )
    async def scroll_until_visible(args: dict) -> dict:
        # Bridge-side emulation: try assert_visible, scroll if missing, repeat.
        for _ in range(10):
            r = ctx.bridge.assert_visible(args["id"])
            if r.success:
                return _ok(f"reached id={args['id']!r}")
            s = ctx.bridge.scroll("down")
            if not s.success:
                return _err(f"scroll_until_visible: scroll failed: {s.error}")
        return _err(f"scroll_until_visible: id={args['id']!r} not found after 10 scrolls")

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
        r = ctx.bridge.swipe(args["direction"])
        if r.success:
            return _ok(f"swiped {args['direction']}")
        return _err(f"swipe failed: {r.error or r.output[:200]}")

    @tool(
        "long_press",
        "Long-press on an element by id. Used to trigger context menus or "
        "long-press-only actions.",
        {"id": str},
    )
    async def long_press(args: dict) -> dict:
        r = ctx.bridge.long_press_id(args["id"])
        if r.success:
            return _ok(f"long-pressed id={args['id']!r}")
        return _err(f"long_press failed: {r.error or r.output[:200]}")

    # ----- Act: lifecycle / platform -----

    @tool(
        "wait_for_animation",
        "Wait for any in-progress animations to settle. Use after navigation-y "
        "actions if the next screen seems to be loading.",
        {},
    )
    async def wait_for_animation(args: dict) -> dict:
        r = ctx.bridge.wait_ms(1500)
        return _ok("waited") if r.success else _err(f"wait failed: {r.error}")

    @tool(
        "press_back",
        "Press the Android hardware/navigation back button. ONLY meaningful on "
        "Android. On iOS, tap the visible back button via tap_element instead.",
        {},
    )
    async def press_back(args: dict) -> dict:
        r = ctx.bridge.press_back(system=False)
        return _ok("pressed back") if r.success else _err(f"back failed: {r.error}")

    @tool(
        "hide_keyboard",
        "Dismiss the on-screen keyboard. Reliable on iOS — first tries the "
        "native dismiss, then falls back to a status-bar tap if that fails. "
        "Use this whenever a focused text field has caused the keyboard to "
        "open and you need to interact with elements that are obscured by it.",
        {},
    )
    async def hide_keyboard(args: dict) -> dict:
        r = ctx.bridge.hide_keyboard()
        return _ok("hid keyboard") if r.success else _err(f"hide_keyboard failed: {r.error}")

    @tool(
        "restart_app",
        "Restart the app on the device. Use this when the app is in an unrecoverable "
        "state, or when you see no targetable elements on screen. The harness chooses "
        "the safe lifecycle for the current build mode. App data is normally preserved; "
        "a dev-client run clears it only when the workflow explicitly enables that "
        "behavior. Returns once the app is back on screen. Always capture the screen "
        "afterward and determine the actual state before navigating or seeding.",
        {},
    )
    async def restart_app(args: dict) -> dict:
        deep_link = ctx.bridge.config.get("deep_link", "")
        is_dev_client = "expo-development-client" in deep_link
        request_clear_state = is_dev_client
        actually_clears_state = (
            is_dev_client and os.environ.get("EVAL_DEV_CLIENT_CLEAR_STATE") == "1"
        )
        r = ctx.bridge.restart_app(clear_state=request_clear_state)
        if r.success:
            state_effect = "cleared" if actually_clears_state else "preserved"
            return _ok(
                f"app restarted; app data was {state_effect}; "
                "capture_screen to determine the current state"
            )
        return _err(f"restart_app failed: {r.error or r.output[:200]}")

    # ----- Verify: hard assertions (engine executes) -----

    @tool(
        "assert_visible",
        "Hard assertion: verify an element with the given id IS on screen. The "
        "engine checks this — if the element is missing, the assertion fails. "
        "Use `fatal=true` for assertions the test step MUST pass (e.g. 'verify "
        "the notes-list screen appears after unlocking'); use `fatal=false` for "
        "partial-credit checks.",
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
        r = ctx.bridge.assert_visible(args["id"])
        passed = r.success
        ctx.state.assertions.append(AssertionResult(
            yaml_cmd=f'is visible id="{args["id"]}"',
            fatal=fatal,
            passed=passed,
        ))
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
        r = ctx.bridge.assert_not_visible(args["id"])
        passed = r.success
        ctx.state.assertions.append(AssertionResult(
            yaml_cmd=f'is not-visible id="{args["id"]}"',
            fatal=fatal,
            passed=passed,
        ))
        if fatal and not passed:
            ctx.state.fatal_failed = True
        status = "PASS" if passed else "FAIL"
        fatal_tag = " [FATAL]" if fatal else ""
        return _ok(f"assert_not_visible id={args['id']!r} → {status}{fatal_tag}")

    # ----- Verify: soft assertions (you read the AT and judge) -----

    @tool(
        "record_soft_assertion",
        "Record a content-based verification you made by reading the accessibility "
        "tree. Use for things the engine can't structurally check: 'the note title "
        "is exactly \"Daily Tasks\"', 'the error message says \"Incorrect password\"', "
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
        # Once an N/A summary has been recorded, freeze it. Otherwise a
        # subsequent complete_step call (e.g. the agent re-acknowledging
        # readiness with a non-N/A blurb) would overwrite the N/A signal
        # and the orchestrator's N/A short-circuit wouldn't fire.
        if not (ctx.state.complete_summary or "").strip().upper().startswith("N/A"):
            ctx.state.complete_summary = new_summary
        ctx.state.completed = True
        return _ok(f"step marked complete: {new_summary}")

    @tool(
        "abort_step",
        "Stop the current evaluator phase because the evaluator cannot finish it. "
        "Use this for terminal driver/tool errors, an unreachable app, or repeated "
        "recovery attempts with no observable progress. Do NOT use it merely because "
        "the app failed a verification; record the failed assertion and complete the "
        "step normally in that case. This produces an evaluator error rather than an "
        "app score.",
        {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": ["driver_error", "setup_blocked", "app_unreachable", "other"],
                },
                "reason": {"type": "string"},
            },
            "required": ["category", "reason"],
        },
    )
    async def abort_step(args: dict) -> dict:
        ctx.state.aborted = True
        ctx.state.abort_category = args["category"]
        ctx.state.abort_reason = args["reason"]
        return _ok(
            f"evaluator phase aborted ({ctx.state.abort_category}): "
            f"{ctx.state.abort_reason}"
        )

    @tool(
        "confirm_dialog",
        "Tap the destructive / primary action button of the currently-visible "
        "iOS system alert (e.g. the 'Delete' button in a delete-confirmation, "
        "'Sign out' in a sign-out confirm). Use this — NOT tap_element or "
        "tap_by_text — for buttons inside a native iOS dialog. Those buttons "
        "live in a special XCTest alert layer that ordinary taps cannot "
        "reliably target (they hit the overlay and dismiss the dialog without "
        "firing the action). Returns an error if no dialog is currently shown.",
        {},
    )
    async def confirm_dialog(args: dict) -> dict:
        r = ctx.bridge.confirm_alert()
        if r.success:
            return _ok("dialog confirmed (destructive button tapped)")
        return _err(f"confirm_dialog failed: {r.error or r.output[:200]}")

    @tool(
        "cancel_dialog",
        "Tap the Cancel / non-destructive button of the currently-visible iOS "
        "system alert. Use this — NOT tap_element or tap_by_text — for "
        "buttons inside a native iOS dialog. Returns an error if no dialog "
        "is currently shown.",
        {},
    )
    async def cancel_dialog(args: dict) -> dict:
        r = ctx.bridge.cancel_alert()
        if r.success:
            return _ok("dialog cancelled (cancel button tapped)")
        return _err(f"cancel_dialog failed: {r.error or r.output[:200]}")

    tool_funcs = [
        capture_screen, capture_screenshot,
        tap_element, tap_by_text, tap_at_point,
        fill_field, erase_text,
        scroll, scroll_until_visible, swipe, long_press,
        wait_for_animation, press_back, hide_keyboard, restart_app,
        assert_visible, assert_not_visible, record_soft_assertion,
        confirm_dialog, cancel_dialog,
        complete_step, abort_step,
    ]
    server = create_sdk_mcp_server(name="adaptive", version="1.0.0", tools=tool_funcs)
    tool_names = [f.name for f in tool_funcs]
    return server, tool_names
