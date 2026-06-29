"""
Agent-device bridge: subprocess wrapper around the `agent-device` CLI for UI
interactions, with `xcrun simctl` for app lifecycle on iOS.

Architecture (iOS):
  - `xcrun simctl` is the source of truth for app lifecycle:
      terminate <bundle>           — kill app
      get_app_container <id> data  — locate Expo Go's per-app data dir
      openurl <deep-link>          — launch the app via URL scheme
  - `agent-device` (via subprocess) is the source of truth for UI:
      snapshot -i / press / fill / is / get / wait / scroll / swipe / longpress
      / back / keyboard dismiss

All `agent-device` commands pass `--session adaptive --platform ios` so the
daemon's XCTest runner stays warm across calls (one-time install cost per
simulator boot).

`restart_app(clear_state=True)` is the only place lifecycle happens. It:
  1. simctl terminate Expo Go
  2. simctl terminate Maestro's WDA xctrunner (defensive — frees port 8100
     if a previous Maestro run left it running on the same simulator)
  3. (clear_state) rm -rf Expo Go's Documents/Library/tmp
  4. simctl openurl exp://localhost:8081
  5. Option B app-readiness polling: every ~1.5s, snapshot; if "Bottom Sheet"
     visible, blind-tap top-of-screen to dismiss; otherwise check that the
     snapshot has > 2 nodes (Expo Go's bare shell is 2 nodes — anything more
     means the JS bundle has rendered). Timeout 30s.

iOS-only. Android raises NotImplementedError for now.
"""

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Any


# Mapping from agent-device's PascalCase `type` field to the lower-case
# token agent-device uses in its compressed -i output. We mirror it so the
# reformatted snapshot looks visually similar to what the model is used to.
_TYPE_TOKEN = {
    "Application": "application",
    "Window": "window",
    "Other": "other",
    "StaticText": "text",
    "Button": "button",
    "Image": "image",
    "SecureTextField": "securetextfield",
    "TextField": "text-field",
    "ScrollView": "scroll-area",
    "Cell": "cell",
    "Switch": "switch",
    "Slider": "slider",
    "Key": "key",
    "Keyboard": "keyboard",
    "NavigationBar": "nav-bar",
    "TabBar": "tab-bar",
    "Toolbar": "toolbar",
}


def _type_token(t: str | None) -> str:
    if not t:
        return "other"
    return _TYPE_TOKEN.get(t, t.lower())


PLATFORM_CONFIGS = {
    "ios": {
        "app_id": "host.exp.Exponent",
        "deep_link": "exp://localhost:8081",
        "wda_bundle": "com.facebook.WebDriverAgentRunner.xctrunner",
    },
    "android": {
        "app_id": "host.exp.exponent",
        "deep_link": "exp://10.0.2.2:8081",
    },
}


@dataclass
class AgentDeviceResult:
    success: bool
    output: str
    error: str = ""


class AgentDeviceBridge:
    """
    iOS bridge backed by `xcrun simctl` (lifecycle) and the `agent-device` CLI
    (UI interactions). Same external shape as MaestroBridge where the methods
    overlap, but with agent-device-native semantics underneath.
    """

    def __init__(
        self,
        platform: str = "ios",
        session: str = "adaptive",
        timeout: int = 60,
        verbose: bool = False,
    ):
        if platform != "ios":
            raise NotImplementedError(
                "AgentDeviceBridge currently supports iOS only. "
                "Android path is intentionally absent in this PR."
            )
        self.platform = platform
        self.session = session
        self.timeout = timeout
        self.verbose = verbose
        self.config = PLATFORM_CONFIGS[platform]
        # Common flags appended to every agent-device call.
        self._common_args = ["--session", session, "--platform", platform]

    # ----- subprocess helpers -----

    def _run_cmd(self, args: list[str], timeout: int | None = None) -> AgentDeviceResult:
        """Run `agent-device <args> --session adaptive --platform ios` and capture."""
        cmd = ["agent-device"] + args + self._common_args
        t = timeout if timeout is not None else self.timeout
        if self.verbose:
            print(f"  [agent-device] {' '.join(args)}")
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=t)
            ok = r.returncode == 0
            out = (r.stdout or "").strip()
            err = (r.stderr or "").strip()
            return AgentDeviceResult(success=ok, output=out, error=err)
        except subprocess.TimeoutExpired:
            return AgentDeviceResult(success=False, output="", error=f"timed out after {t}s")
        except FileNotFoundError as e:
            return AgentDeviceResult(success=False, output="", error=f"agent-device not found: {e}")

    def _simctl(self, args: list[str], timeout: int = 15) -> AgentDeviceResult:
        cmd = ["xcrun", "simctl"] + args
        if self.verbose:
            print(f"  [simctl] {' '.join(args)}")
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            ok = r.returncode == 0
            return AgentDeviceResult(
                success=ok,
                output=(r.stdout or "").strip(),
                error=(r.stderr or "").strip(),
            )
        except subprocess.TimeoutExpired:
            return AgentDeviceResult(success=False, output="", error=f"simctl timed out")

    # ----- UI: capture / inspect -----

    def capture_screenshot(self, path: str | None = None) -> AgentDeviceResult:
        """
        Capture a PNG screenshot of the current simulator screen.

        If `path` is provided, the screenshot is written there. Otherwise a
        temporary file path is generated. Returns an AgentDeviceResult whose
        `output` is the path to the captured PNG on disk.

        Intentionally NOT yet exposed as an LLM-visible tool — building the
        bridge primitive only so we can wire it into a `capture_screenshot`
        tool later without changing the bridge surface. Callers (the eval
        harness, a future MCP tool, or diagnostic scripts) can use it
        directly via this method.
        """
        import tempfile
        if path is None:
            path = tempfile.NamedTemporaryFile(suffix=".png", delete=False).name
        return self._run_cmd(["screenshot", path])

    def capture_hierarchy(self) -> str:
        """
        Snapshot the current screen. Returns a compressed text format like:
            @e3 [other] id="screen-password-gate" "Notes Enter password..."
            @e11 [securetextfield] id="input-password" "Password"
            @e6 [text] "Notes"
        Identifiers (RN testIDs) are wrapped in `id="..."` to disambiguate them
        from labels. Lines without an identifier match agent-device's native
        compressed output. Keyboard / autofill noise is stripped.

        Includes detect-and-recover: if the snapshot is of AgentDeviceRunner
        (the agent-device XCTest helper) instead of the target app, terminate
        the runner via simctl and re-trigger openurl to bring the target app
        back to the foreground, then re-snapshot.
        """
        nodes = self._snapshot_raw()
        if nodes is None:
            return "(snapshot failed)"

        # Recovery: if the snapshot shows AgentDeviceRunner as the frontmost
        # app, agent-device's session is bound to its own helper, not the
        # target app. Re-bind via `agent-device open <bundle>` (does NOT
        # relaunch; just switches the session target) and re-snapshot.
        if self._is_runner_foregrounded(nodes):
            if self.verbose:
                print("  [bridge] AgentDeviceRunner is foregrounded; re-binding session to target app...")
            self._rebind_session()
            time.sleep(1)
            nodes = self._snapshot_raw()
            if nodes is None:
                return "(snapshot failed after runner recovery)"

        return self._render_nodes(nodes)

    def _rebind_session(self) -> AgentDeviceResult:
        """
        Tell agent-device's daemon to point its session at the target app
        rather than its own runner. `open <bundle-id>` (no URL, no --relaunch)
        re-binds without disrupting the app — confirmed empirically.
        """
        return self._run_cmd(["open", self.config["app_id"]])

    def _snapshot_raw(self) -> list[dict] | None:
        """Run `agent-device snapshot -i --raw` and parse each line as JSON."""
        r = self._run_cmd(["snapshot", "-i", "--raw"], timeout=30)
        if not r.success:
            return None
        nodes: list[dict] = []
        for line in r.output.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                nodes.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return nodes

    @staticmethod
    def _is_runner_foregrounded(nodes: list[dict]) -> bool:
        """True if the first Application node is the agent-device helper, not the target app."""
        for n in nodes:
            if n.get("type") == "Application":
                return n.get("label") == "AgentDeviceRunner"
        return False

    @staticmethod
    def _render_nodes(nodes: list[dict]) -> str:
        """
        Render JSON nodes into the compressed text format with explicit testIDs.

        Format:
          @eN [type] id="<identifier>" "<label>"
        where each field appears only if present. Lines without an identifier
        match agent-device's native compressed output exactly.

        Strips iOS keyboard / autofill / dictation noise, and appends a
        [KEYBOARD VISIBLE] marker if any keyboard nodes were stripped.
        """
        keyboard_visible = False
        lines: list[str] = []
        for n in nodes:
            t = _type_token(n.get("type"))
            ident = n.get("identifier") or ""
            label = (n.get("label") or "").strip()

            # Drop keyboard / autofill / dictation noise.
            if t in ("key", "keyboard"):
                keyboard_visible = True
                continue
            if t == "button" and label in ("shift", "return", "Emoji", "Dictate", "go"):
                continue
            if label.startswith("Padding-") or label in (
                "inputView", "Typing Predictions", "kb-autofill-key",
                "Passwords", "Emoji", "Dictate",
            ):
                continue
            if t == "window" and label in ("Emoji", "Dictate"):
                continue

            ref = n.get("ref", "")
            parts = [f"@{ref}", f"[{t}]"] if ref else [f"[{t}]"]
            if ident:
                # Escape quotes defensively.
                safe_id = ident.replace('"', '\\"')
                parts.append(f'id="{safe_id}"')
            if label and label != ident:
                safe_lbl = label.replace('"', '\\"')
                parts.append(f'"{safe_lbl}"')
            # Append element bounds so the model can compute coordinates for
            # tap_at_point fallbacks (e.g. iOS native alert buttons that have
            # no React Native testID). Format matches Maestro's hierarchy.
            rect = n.get("rect")
            if isinstance(rect, dict):
                try:
                    x = int(round(rect["x"]))
                    y = int(round(rect["y"]))
                    w = int(round(rect["width"]))
                    h = int(round(rect["height"]))
                    parts.append(f"[{x},{y}][{x + w},{y + h}]")
                except (KeyError, TypeError, ValueError):
                    pass
            lines.append(" ".join(parts))

        if keyboard_visible:
            lines.append("[KEYBOARD VISIBLE]")
        return "\n".join(lines)

    def get_text(self, id_: str) -> AgentDeviceResult:
        return self._run_cmd(["get", "text", f'id="{id_}"'])

    def get_attrs(self, id_: str) -> AgentDeviceResult:
        return self._run_cmd(["get", "attrs", f'id="{id_}"'])

    # ----- UI: taps -----

    @staticmethod
    def _is_ref(s: str) -> bool:
        # agent-device snapshot refs look like @e12 or e12 (the @ may or may
        # not be supplied by the caller). They denote a transient handle into
        # the most recent snapshot, NOT an accessibilityIdentifier. iOS native
        # dialog buttons (UIAlertController) and other system UI usually only
        # have refs since they're not React Native nodes.
        if not s:
            return False
        body = s[1:] if s.startswith("@") else s
        return len(body) >= 2 and body[0] == "e" and body[1:].isdigit()

    def tap_id(self, id_: str) -> AgentDeviceResult:
        if self._is_ref(id_):
            ref = id_ if id_.startswith("@") else f"@{id_}"
            return self._run_cmd(["press", ref])
        return self._run_cmd(["press", f'id="{id_}"'])

    def tap_label(self, text: str) -> AgentDeviceResult:
        # Escape any embedded double-quotes in the label.
        safe = text.replace('"', '\\"')
        return self._run_cmd(["press", f'label="{safe}"'])

    def tap_point(self, x: int, y: int) -> AgentDeviceResult:
        return self._run_cmd(["press", str(x), str(y)])

    # ----- UI: text input -----

    def fill(self, id_: str, text: str) -> AgentDeviceResult:
        """
        Focus the field with the given id and type text.

        agent-device's bare `fill` is documented as "tap + type" but in
        practice (especially right after another tool has touched the
        simulator — e.g. Maestro's restart_app) the implicit tap inside
        `fill` doesn't actually focus the field. The fill then returns
        success but typed nothing, leading to "Password is required" style
        failures later. The fix: do an explicit `press 'id="<id>"'` first,
        wait briefly, THEN issue the fill.

        Also: a follow-up snapshot serializes against the simulator's
        keystroke queue. Without it, a chained tap takes 15-20s to register;
        with it, ~1s. A plain sleep does not suffice.
        """
        if text == "":
            return AgentDeviceResult(
                success=False,
                output="",
                error="agent-device does not support fill with an empty string; "
                      "use a non-empty replacement or report the gap.",
            )
        # Explicit focus first.
        focus = self._run_cmd(["press", f'id="{id_}"'])
        if not focus.success:
            return AgentDeviceResult(
                success=False, output="",
                error=f"fill: failed to focus id={id_!r}: {focus.error or focus.output[:200]}",
            )
        time.sleep(0.3)
        r = self._run_cmd(["fill", f'id="{id_}"', text])
        if r.success:
            # Drain the keystroke queue before returning so chained taps don't
            # get queued behind pending keystrokes.
            self._run_cmd(["snapshot", "-i", "--raw"], timeout=15)
        return r

    # ----- UI: assertions -----

    # Retry budget for assert_visible against a freshly-appeared element.
    # iOS publishes RN testIDs to the accessibility tree asynchronously after
    # visual mount, so a query within a few hundred ms of the element appearing
    # can miss the testID even though the element is rendered. We retry a few
    # times with a short delay before declaring the assertion failed, which
    # eliminates the visual-vs-AT race for modals / dialogs / toasts without
    # changing the tool surface or requiring per-app prompt rules.
    # Tuned to defend against the ~500ms publish-lag race for freshly-mounted
    # RN testIDs (modals, dialogs, toasts) without making genuinely-absent
    # element checks unreasonably slow. Total retry budget: ~500ms wall.
    _ASSERT_VISIBLE_RETRIES = 2
    _ASSERT_VISIBLE_RETRY_DELAY_SEC = 0.25

    def assert_visible(self, id_: str) -> AgentDeviceResult:
        if self._is_ref(id_):
            ref = id_ if id_.startswith("@") else f"@{id_}"
            cmd = ["is", "visible", ref]
        else:
            cmd = ["is", "visible", f'id="{id_}"']

        # First attempt — no wait. Most assertions succeed on the first try
        # (the element has been on-screen for a while). Retries are only paid
        # for assertions against a transient element whose testID hasn't been
        # published yet.
        r = self._run_cmd(cmd)
        if r.success:
            return r

        # Retry with a short delay between attempts. We DO NOT retry every
        # failed assertion forever — bounded by _ASSERT_VISIBLE_RETRIES so
        # genuinely-absent elements still fail in a reasonable time.
        import time as _time
        for _ in range(self._ASSERT_VISIBLE_RETRIES):
            _time.sleep(self._ASSERT_VISIBLE_RETRY_DELAY_SEC)
            r = self._run_cmd(cmd)
            if r.success:
                return r
        return r

    def assert_not_visible(self, id_: str) -> AgentDeviceResult:
        if self._is_ref(id_):
            ref = id_ if id_.startswith("@") else f"@{id_}"
            r = self._run_cmd(["is", "hidden", ref])
            if r.success:
                return r
            err_blob = (r.error or "") + (r.output or "")
            if "Selector did not match" in err_blob or "did not match" in err_blob.lower():
                return AgentDeviceResult(success=True, output=f"absent ({ref})")
            return r
        # Maestro's `assertNotVisible` passes if the element is absent OR
        # hidden. agent-device's `is hidden` only passes when the element is
        # *present-but-hidden* — a missing element returns COMMAND_FAILED with
        # "Selector did not match". So we treat that specific failure as a
        # successful "not visible" instead of bubbling the error to the LLM.
        r = self._run_cmd(["is", "hidden", f'id="{id_}"'])
        if r.success:
            return r
        err_blob = (r.error or "") + (r.output or "")
        if "Selector did not match" in err_blob or "did not match" in err_blob.lower():
            return AgentDeviceResult(
                success=True,
                output=f"not visible: id={id_!r} is absent from the snapshot",
            )
        return r

    def wait_for(self, id_: str, timeout_ms: int = 10000) -> AgentDeviceResult:
        return self._run_cmd(["wait", f'id="{id_}"', str(timeout_ms)])

    def wait_ms(self, ms: int) -> AgentDeviceResult:
        return self._run_cmd(["wait", str(ms)])

    # ----- UI: gestures -----

    def scroll(self, direction: str = "down") -> AgentDeviceResult:
        return self._run_cmd(["scroll", direction.lower()])

    def swipe(self, direction: str) -> AgentDeviceResult:
        """
        Translate a direction enum into screen-relative swipe coordinates.
        Tuned for iPhone 17 Pro (~402×874 in the simulator's logical points).
        """
        w, h = 402, 874
        dx, dy = w // 2, h // 2
        if direction == "UP":
            x1, y1, x2, y2 = dx, int(h * 0.7), dx, int(h * 0.3)
        elif direction == "DOWN":
            x1, y1, x2, y2 = dx, int(h * 0.3), dx, int(h * 0.7)
        elif direction == "LEFT":
            x1, y1, x2, y2 = int(w * 0.7), dy, int(w * 0.3), dy
        elif direction == "RIGHT":
            x1, y1, x2, y2 = int(w * 0.3), dy, int(w * 0.7), dy
        else:
            return AgentDeviceResult(success=False, output="", error=f"bad swipe direction: {direction}")
        return self._run_cmd(["swipe", str(x1), str(y1), str(x2), str(y2)])

    def erase_text(self, id_: str) -> AgentDeviceResult:
        """
        Clear all text in `id_` via the iOS Edit menu (long-press → Select All
        → Cut). agent-device's `fill` always clears-then-types but rejects
        empty input, and there's no native "clear field" command. This is the
        iOS-standard pattern for emptying a text input.
        """
        focus = self._run_cmd(["press", f'id="{id_}"'])
        if not focus.success:
            return AgentDeviceResult(
                success=False, output="",
                error=f"erase_text: failed to focus id={id_!r}: {focus.error or focus.output[:200]}",
            )
        time.sleep(0.3)
        lp = self.long_press_id(id_, duration_ms=800)
        if not lp.success:
            return AgentDeviceResult(
                success=False, output="",
                error=f"erase_text: long_press failed: {lp.error}",
            )
        time.sleep(0.5)
        # Click "Select All" in the Edit menu. iOS exposes the same label across
        # three nodes (menu-item + text + other wrapper); --first picks one.
        sa = self._run_cmd(["find", "Select All", "click", "--first"])
        if not sa.success:
            # No Edit menu likely means the field was already empty.
            return AgentDeviceResult(success=True, output="erase_text: no Edit menu — field already empty?")
        time.sleep(0.4)
        # "Cut" deletes the selection (we discard the clipboard side-effect).
        cut = self._run_cmd(["find", "Cut", "click", "--first"])
        if not cut.success:
            return AgentDeviceResult(
                success=False, output="",
                error=f"erase_text: Cut failed: {cut.error or cut.output[:200]}",
            )
        # Settle the keystroke queue.
        self._run_cmd(["snapshot", "-i", "--raw"], timeout=15)
        return AgentDeviceResult(success=True, output="erase_text: field cleared via Select All → Cut")

    def long_press_id(self, id_: str, duration_ms: int = 800) -> AgentDeviceResult:
        """Read the element's bounds via `get attrs`, then longpress at its center."""
        attrs = self.get_attrs(id_)
        if not attrs.success:
            return AgentDeviceResult(success=False, output="", error=f"long_press: get_attrs failed: {attrs.error}")
        try:
            data = json.loads(attrs.output)
            rect = data.get("rect") or {}
            x, y, w, h = rect["x"], rect["y"], rect["width"], rect["height"]
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            return AgentDeviceResult(success=False, output="", error=f"long_press: could not parse element bounds: {e}")
        cx = int(x + w / 2)
        cy = int(y + h / 2)
        return self._run_cmd(["longpress", str(cx), str(cy), str(duration_ms)])

    def long_press_point(self, x: int, y: int, duration_ms: int = 800) -> AgentDeviceResult:
        return self._run_cmd(["longpress", str(x), str(y), str(duration_ms)])

    # ----- UI: navigation / keyboard -----

    def press_back(self, system: bool = False) -> AgentDeviceResult:
        return self._run_cmd(["back", "--system"] if system else ["back"])

    def hide_keyboard(self) -> AgentDeviceResult:
        """
        Dismiss the soft keyboard via a coordinate tap on the top-left of the
        status bar (10, 20). agent-device's native `keyboard dismiss` returns
        UNSUPPORTED_OPERATION on iOS, so we don't bother trying it.

        Why (10, 20):
        - It's inside the iOS status bar area (system UI), not the app's content.
        - It avoids the notch / dynamic island in the center of the status bar,
          which IS tappable and triggers system overlays.
        - In 99%+ of iOS apps this coordinate has no interactive element,
          so the focused text field loses focus → the soft keyboard dismisses.

        For Android we'd use a different approach (back --system).
        """
        if self.platform == "ios":
            return self._run_cmd(["press", "10", "20"])
        return self._run_cmd(["keyboard", "dismiss"])

    # ----- UI: system alerts (UIAlertController) -----

    def get_alert(self) -> AgentDeviceResult:
        """
        Return the current iOS system alert's title text (and message, when
        present) via `agent-device alert get`. Exit 0 + title in stdout means
        an alert is showing; exit non-zero means none.
        """
        return self._run_cmd(["alert", "get"])

    def confirm_alert(self) -> AgentDeviceResult:
        """
        Tap the destructive / non-cancel button of the currently-shown iOS
        system alert (UIAlertController). Empirically, agent-device's
        `alert dismiss` is the action that fires the destructive button on a
        React Native `Alert.alert(..., [{style: "cancel"}, {style: "destructive"}])`
        dialog — counter-intuitive but reproducible across runs.

        Use this for "Delete" in a delete-confirm, "Sign out" in a sign-out
        confirm, etc. For 3-button alerts the result is undefined; in that
        case fall back to `agent-device alert get` and a coordinate tap.
        """
        return self._run_cmd(["alert", "dismiss"])

    def cancel_alert(self) -> AgentDeviceResult:
        """
        Tap the Cancel / non-destructive button of the currently-shown iOS
        system alert. Mirror of `confirm_alert` — uses agent-device's
        `alert accept`, which empirically fires the cancel button on a
        React Native destructive Alert.
        """
        return self._run_cmd(["alert", "accept"])

    # ----- App lifecycle -----

    def restart_app_hybrid(self, clear_state: bool = False) -> AgentDeviceResult:
        """
        Diagnostic / fallback restart_app that uses a MAESTRO HYBRID approach:

          - **Maestro** handles the lifecycle (terminate, openurl, clearState)
            AND dismisses Expo Go's Bottom Sheet backdrop overlay. Maestro's
            `runFlow when visible` + `waitForAnimationToEnd` reliably tears
            down the overlay.
          - **agent-device** handles all subsequent interactions (taps,
            fills, snapshots, assertions).

        Historically the default. Retained for fallback in case the native
        restart_app (which is now the default) hits flakiness. To use,
        replace `bridge.restart_app(...)` with `bridge.restart_app_hybrid(...)`
        in the evaluator (or in agent_device_tools.py for the LLM-facing
        restart tool).
        """
        # Lazily instantiate MaestroBridge so the import cost is paid only
        # if/when restart_app is actually called.
        if not hasattr(self, "_maestro"):
            from ..maestro.bridge import MaestroBridge
            self._maestro = MaestroBridge(
                platform=self.platform, timeout=self.timeout, verbose=self.verbose,
            )

        m = self._maestro.restart_app(clear_state=clear_state)
        if not m.success:
            return AgentDeviceResult(
                success=False, output="",
                error=f"maestro restart_app failed: {m.error or m.output[:200]}",
            )

        # No explicit re-bind: Maestro's restart left the simulator in a
        # known good state with the app foregrounded. An explicit
        # `agent-device open <bundle>` here triggers an XCTest session
        # rebuild that wipes focused-field state mid-flight, breaking the
        # first fill→tap sequence after restart. The `capture_hierarchy`
        # path already detects and recovers from runner-takeover if it
        # actually happens later.

        return AgentDeviceResult(success=True, output="ready (maestro lifecycle + agent-device interactions)")

    def restart_app(self, clear_state: bool = False) -> AgentDeviceResult:
        """Default restart_app: pure agent-device + simctl, no Maestro.

        Delegates to the simctl + polling-loop implementation below. The polling
        loop handles BOTH the Expo dev-tools Bottom Sheet AND the Expo Go
        "Continue" dialog — matching the surface area the legacy Maestro hybrid
        path covered.

        If this method ever proves unreliable in practice, callers can swap to
        `restart_app_hybrid()` for the Maestro-fallback path. The CLI flag
        `--native-restart` is retained as a vestigial no-op for the same reason.
        """
        return self._restart_app_simctl_only(clear_state=clear_state)

    # ----- Legacy: original simctl-only restart_app, kept for diagnostic / fallback use -----
    def _restart_app_simctl_only(self, clear_state: bool = False) -> AgentDeviceResult:
        """Original simctl-based restart_app. Handles Expo Go's Continue dialog
        and Bottom Sheet backdrop in the polling loop; used directly by
        `restart_app_native` and reachable for diagnostic / fallback runs."""
        app_id = self.config["app_id"]
        deep_link = self.config["deep_link"]

        # 1: terminate Expo Go via Apple's API.
        # NOTE: do NOT also terminate `com.facebook.WebDriverAgentRunner.xctrunner`
        # here — even though we never use Maestro in this path, killing a
        # XCTest helper app appears to invalidate agent-device's own session
        # state, causing a 15-20s session-rebuild that breaks the first 1-2
        # interactions with the target app. Leave it alone.

        self._simctl(["terminate", "booted", app_id])

        # 2: clearState equivalent — wipe Expo Go's data subdirs.
        if clear_state:
            info = self._simctl(["get_app_container", "booted", app_id, "data"], timeout=10)
            if info.success and info.output:
                data_path = info.output
                for sub in ("Documents", "Library", "tmp"):
                    try:
                        shutil.rmtree(os.path.join(data_path, sub), ignore_errors=True)
                    except Exception:
                        pass

        # 3: launch via deep link.
        self._simctl(["openurl", "booted", deep_link])
        # Brief settle: let Expo Go's process come up before any agent-device
        # interaction. Without this, our first snapshot can race the JS
        # bundle load and trigger an unnecessary session rebuild.
        time.sleep(3)

        # NOTE: do NOT call `agent-device open host.exp.Exponent` here to
        # "re-bind" the session. That call appears to trigger an agent-device
        # session rebuild that clears focused-field state (so a password
        # filled into the gate gets wiped before tap_element button-unlock
        # delivers). The detect-and-recover path inside `capture_hierarchy`
        # handles runner takeover if it occurs.

        # 4: Option B app-readiness polling. Uses _snapshot_raw + node-level
        # checks (not the rendered text) so we can distinguish "target app
        # rendered content" from "agent-device's helper runner has text on
        # screen" — the runner has its own [StaticText] nodes that would
        # falsely trigger a text-based readiness heuristic.
        deadline = time.time() + 30.0
        dismiss_attempts = 0
        while time.time() < deadline:
            nodes = self._snapshot_raw()
            if nodes is None:
                time.sleep(1.5)
                continue

            # If agent-device's session is showing its own runner, re-bind to
            # the target app and try again on the next iteration.
            if self._is_runner_foregrounded(nodes):
                self._rebind_session()
                time.sleep(1.0)
                continue

            # If the Expo Go "Continue" prompt is visible, dismiss it by
            # pressing the Continue affordance. This dialog can appear before
            # or alongside the Bottom Sheet; check it first so the Bottom
            # Sheet branch isn't masked by a Continue overlay above it.
            labels = " ".join((n.get("label") or "") for n in nodes)
            if "Continue" in labels:
                self._run_cmd(["press", 'label="Continue"'])
                dismiss_attempts += 1
                time.sleep(1.0)
                if dismiss_attempts > 9:
                    return AgentDeviceResult(
                        success=False, output="",
                        error="restart_app: failed to dismiss Continue dialog after 10 attempts",
                    )
                continue

            # If the Expo dev tools bottom sheet is visible, blind-tap top of
            # screen to dismiss it.
            if "Bottom Sheet" in labels:
                self._run_cmd(["press", "200", "80"])
                dismiss_attempts += 1
                time.sleep(1.0)
                if dismiss_attempts > 9:
                    return AgentDeviceResult(
                        success=False, output="",
                        error="restart_app: failed to dismiss Bottom Sheet after 10 attempts",
                    )
                continue

            # Ready when the target app has rendered a node that BOTH has a
            # content type AND a React Native testID (accessibilityIdentifier).
            # The stricter "has identifier" requirement filters out Expo Go's
            # chrome (welcome dialog, dev menu, splash) which has text nodes
            # but no testIDs. Only the actual app's components have testIDs.
            content_types = {"StaticText", "Button", "Image", "SecureTextField", "TextField", "Other"}
            if any(
                n.get("type") in content_types and n.get("identifier")
                for n in nodes
            ):
                return AgentDeviceResult(success=True, output="ready")

            time.sleep(1.5)

        return AgentDeviceResult(
            success=False, output="",
            error="restart_app: app did not become ready within 30s",
        )

    def cleanup(self) -> None:
        """Clean up the lazily-instantiated MaestroBridge if present; otherwise no-op.
        agent-device's daemon stays warm — no temp files of our own to clean up."""
        if hasattr(self, "_maestro"):
            try:
                self._maestro.cleanup()
            except Exception:
                pass
