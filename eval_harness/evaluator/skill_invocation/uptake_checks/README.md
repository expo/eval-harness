# Uptake Checks

Answers "did the authored app actually follow this skill's guidance," as a
cascade of increasingly strong (and increasingly expensive) signals:

- **Trigger detection**: was the skill invoked at all, per the agent's own
  trace? See `trigger.py`. Not skill-content-specific -- kept in this package
  because it's still "was this skill's guidance exercised," just answered
  from the trace instead of the source.
- **Lexical checks**: regex, comment-stripped source scan (`text`,
  `text_any`, `text_absent`, `import`).
- **Structural checks**: filesystem shape (`path_exists`, `path_absent`,
  `package_dependency`).
- **Syntax-tree checks**: a first attempt (`router_layout_defines_navigator`,
  see git history) was cut -- it added little over a properly tag-anchored
  lexical regex (`<Stack[\s/>]` etc. already requires literal JSX-tag
  syntax, not just the identifier appearing). Revived later (see
  `code_checks.py`, `../build_health/scripts/extract-ast-facts.js`) once
  three *different* skills turned up guidance regex genuinely can't verify:
  `expo-dom`'s exactly-one-default-export-and-no-native-JSX rule is
  implemented (`dom_single_default_export_and_no_native_jsx`);
  `expo-data-fetching`'s "`response.ok` must actually gate the parse" and
  `expo-tailwind-setup`'s "`className` usage must go through the wrapped
  component" are validated candidates not yet implemented (see
  `SKILL_UPTAKE_COVERAGE_ANALYSIS.md`, repo root, untracked). Uses the same
  Babel subprocess as build_health's syntax check, no `@babel/traverse`
  dependency -- a plain recursive AST walk is enough for export-counting and
  import-bound JSX element names.
- **Route-graph checks**: not built yet. Needs the authored app's real
  `node_modules` (Expo's typed-routes generator), so unlike a syntax-tree
  check it can't run at analysis time -- it has to run at authoring time
  (a new `author-app.sh` stage, right after `npm install`), with the
  result persisted into the artifact for analysis to read later. The
  generator itself turned out to have no simple standalone entrypoint --
  see git history/commit messages for what was actually found.

Deliberately does not attempt the final stage (native build + simulator +
test-plan e2e) -- that's the existing `eval_ios` pipeline, not duplicated
here. The build-health cascade (syntax parse + bundle export, see
`../build_health/`) is a separate, skill-agnostic axis from the checks
above -- it answers "does the whole app work at all," not "did it follow
this skill," so it isn't part of this per-skill list.

## Design: checks are not owned by skills

Every check in `checks_data.json` verifies one durable, skill-agnostic fact
about the code (e.g. "does `app/` exist," "is `<Link>` or `useRouter()`
used") -- it has no notion of which skill(s) care about it. `skill_map.json`
is the *only* file that says "skill X currently claims checks [A, B, C]."

This means a skill can be renamed, merged, or split later by editing
`skill_map.json` alone -- the checks themselves don't move, and a check can
be shared across multiple skills (e.g. `router_app_dir_exists` is claimed by
both `expo-router` and `expo-project-structure`, and
`router_no_direct_react_navigation_import` by both `expo-router` and
`expo-native-ui`, today).

## Which skills have checks

9 of the 21 skills under `skills/plugins/expo/skills/` are mapped in
`skill_map.json`: `expo-router`, `expo-project-structure`, `expo-native-ui`,
`expo-ui`, `expo-data-fetching`, `expo-dom`, `expo-tailwind-setup`,
`eas-hosting`, `expo-app-clip` (config subset only). The other 12 are
deliberately unmapped -- most because their guidance is a CLI/cloud-ops
process or external-dashboard interpretation that leaves no trace in an
authored app's source tree at all (no check category, however clever,
closes that gap; it would need trace-based checking of what the agent ran,
a different axis entirely), a few because they assume a pre-existing app
this harness's "build fresh from a PRD" pattern doesn't produce. See
`SKILL_UPTAKE_COVERAGE_ANALYSIS.md` (repo root, untracked) for the
full-ecosystem breakdown and reasoning per skill.

`dataset/prd_skills.json` is a separate, upstream question: which skills a
given PRD should trigger at all. This package only answers "given an
expected skill, was its guidance followed" -- not "which skills are
expected."

## Files

- `checks_data.json`: lexical + structural checks (declarative), each
  tagged with a `"category"` field.
- `skill_map.json`: skill id -> [check id, ...].
- `registry.py`: loads both, runs checks, and is where any future
  code-driven check category would register via `@register(...)`.
- `trigger.py`: trigger detection, trace-based + recall/precision scoring
  against `dataset/prd_skills.json`.

## Adding a check

1. Add an entry to `checks_data.json` (or a `@register`-decorated function
   for a code-driven category).
2. Add its id to whichever skill(s) in `skill_map.json` should claim it.
3. A skill absent from `skill_map.json`, or a mapped id missing from the
   registry, produces a warning in `metrics.json` rather than crashing --
   same degrade-don't-crash philosophy as the rest of this evaluator.
