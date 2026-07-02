"""HTML/JSON report helpers for skill-eval results."""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any


def write_json_report(payload: dict[str, Any], path: Path | str) -> None:
    Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def write_html_report(payload: dict[str, Any], path: Path | str) -> None:
    path = Path(path)
    rows = []
    for run in payload.get("runs", []):
        rows.append(
            "<tr>"
            f"<td>{_e(run.get('case_id'))}</td>"
            f"<td>{_e(run.get('scenario'))}</td>"
            f"<td>{_e(run.get('skill_id'))}</td>"
            f"<td>{_e(run.get('classification'))}</td>"
            f"<td>{_e(_pct(run.get('trigger_recall')))}</td>"
            f"<td>{_e(_pct(run.get('trigger_precision')))}</td>"
            f"<td>{_e(_pct(run.get('uptake_rate')))}</td>"
            f"<td>{_e(_pct(run.get('evaluator_pct')))}</td>"
            "</tr>"
        )
    screenshots = []
    for shot in payload.get("screenshots", []):
        src = _e(shot.get("path"))
        label = _e(shot.get("label"))
        screenshots.append(f"<figure><img src=\"{src}\" alt=\"{label}\"><figcaption>{label}</figcaption></figure>")
    doc = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Expo Skill Eval</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }}
    img {{ max-width: 220px; border: 1px solid #ddd; }}
    .shots {{ display: flex; flex-wrap: wrap; gap: 16px; }}
  </style>
</head>
<body>
  <h1>Expo Skill Eval</h1>
  <p>{_e(payload.get('summary', ''))}</p>
  <table>
    <thead><tr><th>Case</th><th>Scenario</th><th>Skill</th><th>Class</th><th>Recall</th><th>Precision</th><th>Uptake</th><th>Evaluator</th></tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
  <h2>Screenshots</h2>
  <div class="shots">{''.join(screenshots)}</div>
</body>
</html>
"""
    path.write_text(doc, encoding="utf-8")


def _pct(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        value = float(value)
    except Exception:
        return str(value)
    if value <= 1.0:
        value *= 100
    return f"{value:.1f}%"


def _e(value: Any) -> str:
    return html.escape("" if value is None else str(value))
