"""
Parse a primitive test plan from its XML-flavored `.txt` format.

Extracted verbatim (stdlib-only) from the original
`scripts/generate_maestro_flows.py` in the vibench monorepo — the rest of that
module was Maestro YAML generation the agentic evaluator no longer uses. This
parser is the only piece both evaluators depend on.

Test plan format:

    <test_plan>
      <purpose>...</purpose>
      <seeding_and_precondition>...</seeding_and_precondition>
      <steps>
        <step>
          <name>step_name</name>
          ... description with Verify: bullets ...
          <points>3</points>
          <skippable>false</skippable>   (optional)
        </step>
      </steps>
      <full_points>N</full_points>       (optional; defaults to sum of step points)
    </test_plan>
"""

import re
from pathlib import Path
from typing import Dict


def parse_test_plan(test_plan_path: Path) -> Dict:
    """
    Parse a test plan XML file.

    Returns:
        Dict with test plan metadata and steps
    """
    content = test_plan_path.read_text()

    # Extract sections using regex (more robust than XML parsing for our format)
    purpose_match = re.search(r'<purpose>(.*?)</purpose>', content, re.DOTALL)
    seeding_match = re.search(r'<seeding_and_precondition>(.*?)</seeding_and_precondition>', content, re.DOTALL)
    full_points_match = re.search(r'<full_points>(\d+)</full_points>', content)

    # Extract steps
    steps_section = re.search(r'<steps>(.*?)</steps>', content, re.DOTALL)
    steps = []

    if steps_section:
        step_blocks = re.findall(r'<step>(.*?)</step>', steps_section.group(1), re.DOTALL)

        for step_block in step_blocks:
            # Extract step components
            name_match = re.search(r'<name>(.*?)</name>', step_block)
            points_match = re.search(r'<points>(\d+)</points>', step_block)
            skippable_match = re.search(r'<skippable>(true|false)</skippable>', step_block)

            # Get step description (everything except XML tags)
            description = re.sub(r'<name>.*?</name>', '', step_block)
            description = re.sub(r'<points>.*?</points>', '', description)
            description = re.sub(r'<skippable>.*?</skippable>', '', description)
            description = description.strip()

            steps.append({
                "name": name_match.group(1) if name_match else f"step_{len(steps)}",
                "description": description,
                "points": int(points_match.group(1)) if points_match else 0,
                "skippable": skippable_match.group(1) == "true" if skippable_match else False
            })

    return {
        "purpose": purpose_match.group(1).strip() if purpose_match else "",
        "seeding": seeding_match.group(1).strip() if seeding_match else "",
        "full_points": int(full_points_match.group(1)) if full_points_match else sum(s["points"] for s in steps),
        "steps": steps
    }
