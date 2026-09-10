"""HTML report generation for the agentic evaluator's result.json output.

Mirrors skill_invocation/analysis.ts's writeHtmlReport -- same plain-table,
no-JS style, so both eval-e2e.yml artifacts (skill-eval-report and, with this
module, the eval_ios output) are consistent to skim. Consumes exactly the
`output` dict main.py already assembles and writes to result.json -- see
main.py's `output = {...}` construction for the authoritative shape.
"""

from __future__ import annotations

import html
from pathlib import Path
from typing import Any


def _e(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def _pct(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        value = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{value:.1f}%"


def _assertion_count(step: dict[str, Any], field: str, count_field: str) -> int:
    """Read migrated explicit counts, then fall back to legacy scalar fields."""
    count = step.get(count_field)
    if isinstance(count, int) and not isinstance(count, bool):
        return count
    assertions = step.get(field)
    if isinstance(assertions, int) and not isinstance(assertions, bool):
        return assertions
    if isinstance(assertions, list):
        return len(assertions)
    return 0


def _assertion_cell(
    step: dict[str, Any],
    field: str,
    count_field: str,
    text_field: str,
) -> str:
    count = _assertion_count(step, field, count_field)
    assertions = step.get(field)
    if not isinstance(assertions, list):
        return f'<span class="assertion-count">{count}</span>'

    items = []
    for assertion in assertions:
        if not isinstance(assertion, dict):
            continue
        passed = assertion.get("passed") is True
        fatality = "fatal" if assertion.get("fatal") is True else "non-fatal"
        status = "passed" if passed else "failed"
        evidence = assertion.get("evidence")
        evidence_html = (
            f'<div class="assertion-evidence">Evidence: {_e(evidence)}</div>'
            if evidence
            else ""
        )
        items.append(
            "<li>"
            f'<span class="{"pass" if passed else "fail"}">{fatality} · {status}</span> '
            f"<code>{_e(assertion.get(text_field))}</code>"
            f"{evidence_html}"
            "</li>"
        )

    if not items:
        return f'<span class="assertion-count">{count}</span>'
    return (
        f'<span class="assertion-count">{count}</span>'
        '<details class="assertion-details"><summary>View evidence</summary><ul>'
        f"{''.join(items)}"
        "</ul></details>"
    )


def _screenshot_evidence(step: dict[str, Any]) -> str:
    evidence = []
    if step.get("screenshot"):
        evidence.append(
            "<div><strong>Final-state screenshot:</strong> "
            f"<code>{_e(step.get('screenshot'))}</code></div>"
        )
    if step.get("screenshot_error"):
        evidence.append(
            '<div class="warning"><strong>Screenshot warning:</strong> '
            f"{_e(step.get('screenshot_error'))}</div>"
        )
    return "".join(evidence) or "n/a"


def write_html_report(output: dict[str, Any], path: Path | str) -> None:
    plan_rows = []
    step_rows = []
    for plan in output.get("test_plans") or []:
        if plan.get("status") == "evaluator_error":
            plan_rows.append(
                "<tr>"
                f"<td>{_e(plan.get('test_plan'))}</td>"
                f"<td>{_e(plan.get('run_index'))}</td>"
                "<td>evaluator_error</td>"
                "<td>n/a</td>"
                f"<td>{_e(plan.get('error_stage'))}: {_e(plan.get('error_reason'))}</td>"
                "</tr>"
            )
        elif plan.get("status") == "not_applicable":
            plan_rows.append(
                "<tr>"
                f"<td>{_e(plan.get('test_plan'))}</td>"
                f"<td>{_e(plan.get('run_index'))}</td>"
                "<td>not_applicable</td>"
                "<td>n/a</td>"
                f"<td>{_e(plan.get('na_reason'))}</td>"
                "</tr>"
            )
            continue
        else:
            plan_rows.append(
                "<tr>"
                f"<td>{_e(plan.get('test_plan'))}</td>"
                f"<td>{_e(plan.get('run_index'))}</td>"
                f"<td>{_e(plan.get('score'))}/{_e(plan.get('full_points'))}</td>"
                f"<td>{_pct(plan.get('macro_pct'))}</td>"
                f"<td>{len(plan.get('steps') or [])} step(s)</td>"
                "</tr>"
            )
        for step in plan.get("steps") or []:
            passed = str(step.get("description", "")).startswith("PASSED")
            step_rows.append(
                "<tr>"
                f"<td>{_e(plan.get('test_plan'))}</td>"
                f"<td class=\"{'pass' if passed else 'fail'}\">{_e(step.get('description'))}</td>"
                f"<td>{_e(step.get('points'))}/{_e(step.get('max_points'))}</td>"
                f"<td>{_e(step.get('iterations'))}</td>"
                f"<td>{_assertion_cell(step, 'hard_assertions', 'hard_assertion_count', 'command')}</td>"
                f"<td>{_assertion_cell(step, 'soft_assertions', 'soft_assertion_count', 'check')}</td>"
                f"<td>{_screenshot_evidence(step)}</td>"
                "</tr>"
            )
    doc = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Expo Agentic iOS Eval</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; }}
    table {{ border-collapse: collapse; width: 100%; margin-bottom: 32px; }}
    th, td {{ border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }}
    .note {{ color: #555; max-width: 760px; }}
    .pass {{ color: #1a7a1a; }}
    .fail {{ color: #b3261e; }}
    .warning {{ color: #8a5a00; }}
    .assertion-count {{ font-weight: 600; }}
    .assertion-details summary {{ cursor: pointer; white-space: nowrap; }}
    .assertion-details ul {{ margin: 8px 0 0; padding-left: 20px; }}
    .assertion-evidence {{ color: #555; margin-top: 4px; }}
    code {{ white-space: pre-wrap; overflow-wrap: anywhere; }}
  </style>
</head>
<body>
  <h1>Expo Agentic iOS Eval</h1>
  <p>{_e(output.get('test_overview', ''))}</p>
  <p class="note">Native build + on-device/simulator agentic evaluator: an LLM
  agent drives the authored app via Maestro/agent-device and scores each
  PRD-derived test-plan step against its Verify lines (hard assertions by
  testID, soft assertions by LLM judgment).</p>
  <h2>Per-test-plan results</h2>
  <table>
    <thead><tr><th>Test plan</th><th>Run</th><th>Score</th><th>Macro %</th><th>Steps / reason</th></tr></thead>
    <tbody>{''.join(plan_rows)}</tbody>
  </table>
  <h2>Per-step detail</h2>
  <p class="note">not_applicable test plans have no per-step rows here -- the
  seed phase determined the primitive doesn't apply to this app; see the
  reason in the table above instead.</p>
  <table>
    <thead><tr><th>Test plan</th><th>Step</th><th>Points</th><th>Iterations</th><th>Hard assertions</th><th>Soft assertions</th><th>Screenshot evidence</th></tr></thead>
    <tbody>{''.join(step_rows)}</tbody>
  </table>
</body>
</html>
"""
    Path(path).write_text(doc, encoding="utf-8")
