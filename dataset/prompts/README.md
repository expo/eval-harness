# Authoring prompts

The base instructions handed to the coding agent before the PRD. A run selects
one by **id**, via the `prompt_variant` workflow input.

| id | file | what it is |
|---|---|---|
| `baseline` | [`baseline.md`](baseline.md) | Default. Required project files, `npm install` + `npx expo install --check` before stopping, and native-build self-verification via the `agent-verify` EAS profile. |
| `minimal` | [`minimal.md`](minimal.md) | Role and task only, none of baseline's verification instructions. Isolates the harness's guardrails from the agent's own defaults. |

## Adding a variant

1. Add the file here, named for what it *is* (`minimal.md`), not its lineage
   (`author_app_2.md`).
2. Register it in [`../prompts.json`](../prompts.json) with a `file` (relative
   to `dataset/`) and a `description` saying what it tests:

   ```json
   "terse": {
     "file": "prompts/terse.md",
     "description": "Baseline minus the eas build self-verification step."
   }
   ```

3. Run it: `eas workflow:run .eas/workflows/eval-e2e.yml --ref main -F prompt_variant=terse ...`

Ids, not paths: a path input silently degrades. An unreadable prompt yields an
*empty* base prompt, and `author-app.sh` runs under `set -uo pipefail` without
`-e`, so nothing aborts — the agent authors from the bare PRD with no
instructions, and that invalid run is still built, evaluated, and scored.
Resolving an id against the registry turns that into an immediate failure
before any expensive stage. See
[`resolve_prompt.sh`](../../eval_harness/utils/shell/resolve_prompt.sh) and its
tests.

## How the final prompt is assembled

Fixed order, in `eval::run_coding_agent`
([`agents.sh`](../../eval_harness/utils/shell/agents.sh)) — the variant file is
only the first part:

```text
<variant file>

## Guidance                     ← only when scenario=skills_available_mentioned
Explicitly use Expo's "<SKILL_MENTION>" skill/guidance for ...

The PRD follows.

## App PRD

<dataset/prds/<app>/prd/mvp.txt>
```

Both the id and the resolved path are recorded in each run's `manifest.json`
(`prompt_variant`, `prompt_file`), so results group by variant.
