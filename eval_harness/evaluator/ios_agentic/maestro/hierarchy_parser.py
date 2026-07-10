"""
Accessibility tree compression and diffing for Maestro hierarchy output.

Takes raw `maestro hierarchy` JSON (~750 lines, 32KB) and compresses to
~6-15 lines by extracting only elements targetable by Maestro commands.
"""

import json
import difflib
from dataclasses import dataclass


@dataclass
class _Element:
    resource_id: str
    accessibility_text: str
    hint_text: str
    value: str
    bounds: str
    enabled: bool
    focused: bool
    depth: int


# Status bar lives in the top ~60px of the screen
_STATUS_BAR_Y_THRESHOLD = 60

# Known system UI accessibility texts to always drop
_SYSTEM_UI_TEXTS = frozenset({
    "Cellular", "Wi-Fi", "battery power",
})

# All keyboard-related container resource-ids — filtered only when the
# actual keyboard layout (UIKeyboardLayoutStar Preview) is present.
_KEYBOARD_CONTAINERS = frozenset({
    "inputView", "SystemInputAssistantView", "UIKeyboardLayoutStar Preview",
})

_KEYBOARD_LAYOUT_ID = "UIKeyboardLayoutStar Preview"


def _parse_bounds(bounds_str: str) -> tuple[int, int, int, int]:
    """Parse '[x1,y1][x2,y2]' into (x1, y1, x2, y2)."""
    try:
        parts = bounds_str.replace("][", ",").strip("[]").split(",")
        return tuple(int(p) for p in parts)
    except (ValueError, AttributeError):
        return (0, 0, 0, 0)


def _is_system_ui(attrs: dict, bounds: tuple[int, int, int, int]) -> bool:
    _, y1, _, y2 = bounds
    if y2 <= _STATUS_BAR_Y_THRESHOLD:
        return True
    acc_text = attrs.get("accessibilityText", "")
    for marker in _SYSTEM_UI_TEXTS:
        if marker in acc_text:
            return True
    return False


def _has_content(attrs: dict) -> bool:
    return bool(
        attrs.get("resource-id")
        or attrs.get("accessibilityText")
        or attrs.get("hintText")
        or attrs.get("value")
    )


def _has_keyboard(node: dict) -> bool:
    """Check if the actual keyboard layout exists anywhere in the tree."""
    attrs = node.get("attributes", {})
    if attrs.get("resource-id", "").strip() == _KEYBOARD_LAYOUT_ID:
        return True
    return any(_has_keyboard(child) for child in node.get("children", []))


def _walk(node: dict, depth: int, results: list[_Element], state: dict):
    """Recursively walk the hierarchy tree, collecting targetable elements."""
    attrs = node.get("attributes", {})
    bounds_str = attrs.get("bounds", "[0,0][0,0]")
    bounds = _parse_bounds(bounds_str)

    resource_id = attrs.get("resource-id", "").strip()

    if state["keyboard_present"] and resource_id in _KEYBOARD_CONTAINERS:
        state["keyboard_visible"] = True
        return

    acc_text = attrs.get("accessibilityText", "").strip()
    hint_text = attrs.get("hintText", "").strip()
    value = attrs.get("value", "").strip()
    enabled = attrs.get("enabled", "true") == "true"
    focused = attrs.get("focused", "false") == "true"

    children = node.get("children", [])
    is_leaf = len(children) == 0

    # Only filter system UI for elements that have actual content
    if _has_content(attrs) and _is_system_ui(attrs, bounds):
        return

    keep = False
    if resource_id:
        keep = True
    elif is_leaf and (acc_text or hint_text or value):
        keep = True

    if keep:
        results.append(_Element(
            resource_id=resource_id,
            accessibility_text=acc_text,
            hint_text=hint_text,
            value=value,
            bounds=bounds_str,
            enabled=enabled,
            focused=focused,
            depth=depth,
        ))

    for child in children:
        _walk(child, depth + 1, results, state)


def _format_element(el: _Element, min_depth: int) -> str:
    indent = "  " * max(0, el.depth - min_depth)
    parts = []

    if el.resource_id:
        parts.append(f"[{el.resource_id}]")
    if el.accessibility_text:
        parts.append(f'"{el.accessibility_text}"')
    if el.value and el.value != el.accessibility_text:
        parts.append(f'value="{el.value}"')
    if el.hint_text:
        parts.append(f'hint="{el.hint_text}"')
    parts.append(el.bounds)

    flags = []
    if not el.enabled:
        flags.append("DISABLED")
    if el.focused:
        flags.append("FOCUSED")
    if flags:
        parts.append(" ".join(flags))

    return indent + " ".join(parts)


def parse(raw_json: str) -> str:
    """Compress raw `maestro hierarchy` JSON into compact text format.

    Returns a multi-line string with one line per targetable element.
    """
    try:
        tree = json.loads(raw_json)
    except json.JSONDecodeError:
        return "(failed to parse hierarchy JSON)"

    elements: list[_Element] = []
    state = {"keyboard_present": _has_keyboard(tree), "keyboard_visible": False}
    _walk(tree, 0, elements, state)

    if not elements:
        return "(no targetable elements found)"

    min_depth = min(el.depth for el in elements)
    lines = [_format_element(el, min_depth) for el in elements]
    if state["keyboard_visible"]:
        lines.append("[KEYBOARD VISIBLE]")
    return "\n".join(lines)


def diff(previous: str, current: str) -> tuple[str, bool]:
    """Compute a compact diff between two compressed hierarchies.

    Returns (text, is_diff). If more than 40% of lines changed,
    returns the full current hierarchy instead of a diff.
    """
    if not previous:
        return current, False

    prev_lines = previous.splitlines()
    curr_lines = current.splitlines()

    matcher = difflib.SequenceMatcher(None, prev_lines, curr_lines)
    ratio = matcher.ratio()

    if ratio < 0.6:
        return current, False

    diff_lines = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for line in curr_lines[j1:j2]:
                diff_lines.append(f"  {line}")
        elif tag == "replace":
            for line in prev_lines[i1:i2]:
                diff_lines.append(f"- {line}")
            for line in curr_lines[j1:j2]:
                diff_lines.append(f"+ {line}")
        elif tag == "delete":
            for line in prev_lines[i1:i2]:
                diff_lines.append(f"- {line}")
        elif tag == "insert":
            for line in curr_lines[j1:j2]:
                diff_lines.append(f"+ {line}")

    return "\n".join(diff_lines), True
