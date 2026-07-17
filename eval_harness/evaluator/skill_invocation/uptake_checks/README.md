# Uptake Checks

Answers "did the authored app actually follow this skill's guidance," as a
cascade of increasingly strong (and increasingly expensive) signals:

- **Tier 0 (trigger)**: was the skill invoked at all, per the agent's own
  trace? See `trigger.py`. Not skill-content-specific -- kept in this package
  because it's still "was this skill's guidance exercised," just answered
  from the trace instead of the source.
- **Tier 1 (lexical)**: regex, comment-stripped source scan (`text`,
  `text_any`, `text_absent`, `import`).
- **Tier 2 (structural)**: filesystem shape (`path_exists`, `path_absent`,
  `package_dependency`).
- **Tier 3 (AST)**: code-driven (`checks_ast.py`), registered via
  `registry.register(...)` rather than declared in JSON, since it needs real
  JS/JSX parsing. Shells out to a standalone Node/Babel script
  (`scripts/parse-file-facts.js`, its own `package.json`, `npm install`-ed
  lazily on first use -- not part of any authored app's own dependencies).
  Stronger than tier 1's text match on the same tags: it parses the actual
  JSX tree, so an unused import or a broken file can't accidentally satisfy
  it. Currently one check: `router_layout_defines_navigator`.
- **Tier 4 (typegen/routegraph)**: not built yet. Needs the authored app's
  real `node_modules` (Expo's typed-routes generator), so unlike tier 3 it
  can't run at analysis time -- it has to run at authoring time (a new
  `author-app.sh` stage, right after `npm install`), with the result
  persisted into the artifact for analysis to read later.

Deliberately does not attempt the final tier (native build + simulator +
test-plan e2e) -- that's the existing `eval_ios` pipeline, not duplicated
here.

## Design: checks are not owned by skills

Every check in `checks_data.json` verifies one durable, skill-agnostic fact
about the code (e.g. "does `app/` exist," "is `<Link>` or `useRouter()`
used") -- it has no notion of which skill(s) care about it. `skill_map.json`
is the *only* file that says "skill X currently claims checks [A, B, C]."

This means a skill can be renamed, merged, or split later by editing
`skill_map.json` alone -- the checks themselves don't move, and a check can
be shared across multiple skills (e.g. `router_app_dir_exists` is claimed by
both `expo-router` and `expo-project-structure` today).

`dataset/prd_skills.json` is a separate, upstream question: which skills a
given PRD should trigger at all. This package only answers "given an
expected skill, was its guidance followed" -- not "which skills are
expected."

## Files

- `checks_data.json`: tier 1-2 checks (declarative).
- `skill_map.json`: skill id -> [check id, ...].
- `registry.py`: loads both, runs checks, and is where tier 3+ code-driven
  checks register via `@register(...)`.
- `checks_ast.py`: tier 3 checks + the Node/Babel subprocess helpers.
- `scripts/`: the standalone Node/Babel parser tier 3 shells out to.
- `trigger.py`: tier 0, trace-based trigger detection + recall/precision
  scoring against `dataset/prd_skills.json`.

## Adding a check

1. Add an entry to `checks_data.json` (or a `@register`-decorated function in
   a new `checks_*.py` for tier 3+).
2. Add its id to whichever skill(s) in `skill_map.json` should claim it.
3. A skill absent from `skill_map.json`, or a mapped id missing from the
   registry, produces a warning in `metrics.json` rather than crashing --
   same degrade-don't-crash philosophy as the rest of this evaluator.
