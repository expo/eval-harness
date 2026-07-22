# Uptake Checks

Answers "did the authored app actually follow this skill's guidance," as a cascade of increasingly strong (and increasingly expensive) signals.

## Check cascade

| Tier | Answers | Implementation |
|---|---|---|
| Trigger detection | Was the skill invoked at all, per the agent's own trace? | `trigger.py` |
| Lexical | Regex, comment-stripped source scan (`text`, `text_any`, `text_absent`, `import`) | `checks_data.json` |
| Structural | Filesystem shape (`path_exists`, `path_absent`, `package_dependency`) | `checks_data.json` |
| Syntax-tree | Real AST parsing, for rules a regex genuinely can't verify | `code_checks.py`, `../build_health/scripts/extract-ast-facts.js` |
| Route-graph | Real route graph | not built yet |

Trigger detection isn't skill-content-specific — it's still "was this skill's guidance exercised," just answered from the trace instead of the source.

Syntax-tree checks exist only where a properly tag-anchored lexical regex can't verify the rule, e.g. `expo-dom`'s exactly-one-default-export-and-no-native-JSX rule (`dom_single_default_export_and_no_native_jsx`). Uses the same Babel subprocess as build_health's syntax check, no `@babel/traverse` dependency — a plain recursive AST walk is enough for export-counting and import-bound JSX element names. Known gaps, not yet implemented: `expo-data-fetching`'s "`response.ok` must actually gate the parse" and `expo-tailwind-setup`'s "`className` usage must go through the wrapped component".

Route-graph checks would need the authored app's real `node_modules` (Expo's typed-routes generator), so unlike a syntax-tree check it can't run at analysis time — it would have to run at authoring time (a new `author-app.sh` stage, right after `npm install`), with the result persisted into the artifact for analysis to read later. Blocked on the generator having no simple standalone entrypoint outside a full Metro/Expo CLI run.

Not covered: native build + simulator + test-plan e2e (that's the existing `eval_ios` pipeline, not duplicated here). Build-health (syntax parse + bundle export, `../build_health/`) is a separate, skill-agnostic axis from the checks above — it answers "does the whole app work at all," not "did it follow this skill."

## Check result status

| Status | Meaning | Counts toward `uptake_rate`? |
|---|---|---|
| `passed` | check ran, no violation found | yes |
| `failed` | check ran, found a violation | yes |
| `not_applicable` | the check's precondition doesn't hold for this app (e.g. a rule about API routes when the app has none) | no |
| `unavailable` | evidence genuinely couldn't be collected (e.g. the AST parser couldn't run) | no |

Only code-driven checks (`code_checks.py`) can return `not_applicable`/`unavailable` — the generic declarative dispatch (`checks_data.json`'s `import`/`text`/`text_any`/`text_absent`/`path_exists`/`path_absent`/`package_dependency`/`tsconfig_path_alias` kinds) always answers a global "does any file match" question with no conditional precondition, so it only ever produces `passed`/`failed`. `hosting_api_routes_use_typescript` and `data_fetching_expo_public_env_prefix` are code-driven specifically to get a `not_applicable` path (no `+api` routes / no client-side env var reads, respectively).

This status model matters because a check that vacuously passes when its precondition doesn't hold inflates uptake for a rule the app never had reason to engage with, and a syntax-tree check that reports `passed` when the parser couldn't run at all lets an infra failure read as compliance — `not_applicable`/`unavailable` exist as distinct, non-scored statuses specifically to rule out both.

`compute_skill_results` treats `unavailable` as outranking a mix of scored results: a skill with one passed check and one unavailable check reads `uptake_status="unavailable"`, not an unqualified "measured, 100%" — partial evidence shouldn't read as full confidence. `not_applicable` doesn't trigger this (it was successfully classified as irrelevant, not missing evidence).

Every result (all four statuses) stays in the per-skill `checks` list the HTML report reads — nothing is silently dropped, even though only `passed`/`failed` count toward `passed`/`total`/`uptake_rate`/`category_breakdown()` (see `UptakeResults`, `analysis.compute_skill_results`).

### Engagement gating for negative checks

A `text_absent`/`path_absent` check (or its code-driven equivalent) always reads `passed` when its forbidden pattern is absent — including when the app never engaged with that skill at all, which is absence of usage, not evidence of correct usage. A *failing* negative check never needs gating: finding the forbidden pattern is itself proof the app touched that area. The following require their own positive engagement signal before a clean pass counts as real uptake, otherwise `not_applicable`:

| Check | Requires (else `not_applicable`) |
|---|---|
| `expo_ui_no_host_from_subpackage` | an `@expo/ui` import |
| `expo_ui_platform_specific_trees_not_in_app_dir` | an `@expo/ui` import |
| `data_fetching_no_axios` | observable fetch/query-lib usage |
| `dom_layout_excludes_use_dom` | a confirmed real `'use dom'` directive |
| `native_ui_no_expo_av` | expo-audio/expo-video usage |
| `native_ui_no_dimensions_get` | `useWindowDimensions()` usage |
| `native_ui_no_safe_area_view_from_react_native` | `react-native-safe-area-context` usage |
| `router_no_direct_react_navigation_import` | an `expo-router` import |

Each expo-native-ui anti-pattern check gates on its OWN feature-specific replacement rather than a shared skill-wide signal — using `react-native-safe-area-context` isn't evidence the app made a correct media or dimensions choice, so a shared signal would activate unrelated checks. expo-native-ui also has no single skill-wide positive check: the skill is far broader than these three anti-patterns (semantic colors, scroll-view insets, SF Symbols, haptics, animations, and more), and an app can follow it well while never touching any of these specific features — there's no honest single "did this app use expo-native-ui" signal today, only per-feature ones.

`router_no_direct_react_navigation_import` is mapped only to `expo-router`, not `expo-native-ui`: as a shared check with no engagement precondition of its own, it would vacuously pass for an app with zero native-ui-relevant content.

## Design: checks are not owned by skills

Every check in `checks_data.json` verifies one durable, skill-agnostic fact about the code (e.g. "does `app/` exist," "is `<Link>` or `useRouter()` used") — it has no notion of which skill(s) care about it. `skill_map.json` is the *only* file that says "skill X currently claims checks [A, B, C]."

A skill can be renamed, merged, or split later by editing `skill_map.json` alone — the checks themselves don't move, and a check can be shared across multiple skills (e.g. `router_app_dir_exists` is claimed by both `expo-router` and `expo-project-structure`). Sharing isn't automatic: a shared check should only be claimed by a skill if it can't otherwise read as a false positive for that skill's own engagement (see `router_no_direct_react_navigation_import` above).

## Which skills have checks

| | Count |
|---|---|
| Skills under `plugins/expo/skills/` | 21 |
| Mapped in `skill_map.json` | 9 |

Mapped: `expo-router`, `expo-project-structure`, `expo-native-ui`, `expo-ui`, `expo-data-fetching`, `expo-dom`, `expo-tailwind-setup`, `eas-hosting`, `expo-app-clip` (config subset only).

The other 12 are deliberately unmapped: most because their guidance is a CLI/cloud-ops process or external-dashboard interpretation that leaves no trace in an authored app's source tree at all (no check category, however clever, closes that gap — it would need trace-based checking of what the agent ran, a different axis entirely); a few because they assume a pre-existing app, which this harness's "build fresh from a PRD" pattern doesn't produce.

`dataset/prd_skills.json` is a separate, upstream question: which skills a given PRD should trigger at all. This package only answers "given an expected skill, was its guidance followed" — not "which skills are expected."

## Files

| File | Purpose |
|---|---|
| `checks_data.json` | Lexical + structural checks (declarative), each tagged with a `category`. Only ever produces `passed`/`failed`. |
| `skill_map.json` | skill id → `[check id, ...]` |
| `registry.py` | Loads both, runs checks, defines `CheckResult`'s status model, and is where a code-driven check registers via `@register(...)` |
| `code_checks.py` | Code-driven checks: per-file-subset filtering, real AST parsing, or conditional (`not_applicable`-capable) rules the generic declarative dispatch can't express |
| `trigger.py` | Trigger detection, trace-based + recall/precision scoring against `dataset/prd_skills.json` |

## Adding a check

1. Add an entry to `checks_data.json` (or a `@register`-decorated function for a code-driven category).
2. Add its id to whichever skill(s) in `skill_map.json` should claim it.
3. A skill absent from `skill_map.json`, or a mapped id missing from the registry, produces a warning in `metrics.json` rather than crashing — same degrade-don't-crash philosophy as the rest of this evaluator.
