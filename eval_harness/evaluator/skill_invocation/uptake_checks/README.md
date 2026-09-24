# Uptake Checks

Answers "did the authored app actually follow this skill's guidance," as a cascade of increasingly strong (and increasingly expensive) signals.

## Check cascade

| Tier | Answers | Implementation |
|---|---|---|
| Trigger detection | Was the skill invoked at all, per the agent's own trace? | `trigger.ts` |
| Lexical | Regex, comment-stripped source scan (`text`, `text_any`, `text_absent`, `import`) | `checks_data.json` |
| Structural | Filesystem shape (`path_exists`, `path_absent`, `package_dependency`) | `checks_data.json` |
| Syntax-tree | Real AST parsing, for rules a regex genuinely can't verify | `code_checks.ts`, `../build_health/node_parser.ts` |
| Route-graph | Real route graph | not built yet |

Trigger detection isn't skill-content-specific — it's still "was this skill's guidance exercised," just answered from the trace instead of the source.

Syntax-tree checks exist only where a properly tag-anchored lexical regex can't verify the rule, e.g. `expo-dom`'s exactly-one-default-export-and-no-native-JSX rule (`dom_single_default_export_and_no_native_jsx`). They use the same Babel parser as build_health's syntax check, no `@babel/traverse` dependency — a plain recursive AST walk is enough for export-counting and import-bound JSX element names. Known gaps, not yet implemented: `expo-data-fetching`'s "`response.ok` must actually gate the parse" and `expo-tailwind-setup`'s "`className` usage must go through the wrapped component".

Route-graph checks would need the authored app's real `node_modules` (Expo's typed-routes generator), so unlike a syntax-tree check it can't run at analysis time — it would have to run at authoring time (a new `author-app.sh` stage, right after `npm install`), with the result persisted into the artifact for analysis to read later. Blocked on the generator having no simple standalone entrypoint outside a full Metro/Expo CLI run.

Not covered: native build + simulator + test-plan e2e (that's the existing `eval_ios` pipeline, not duplicated here). Build-health (syntax parse + bundle export, `../build_health/`) is a separate, skill-agnostic axis from the checks above — it answers "does the whole app work at all," not "did it follow this skill."

## Check result status

| Status | Meaning | Counts toward `uptake_rate`? |
|---|---|---|
| `passed` | check ran, no violation found | yes |
| `failed` | check ran, found a violation | yes |
| `not_applicable` | the check's precondition doesn't hold for this app (e.g. a rule about API routes when the app has none) | no |
| `unavailable` | evidence genuinely couldn't be collected (e.g. the AST parser couldn't run) | no |

Only code-driven checks (`code_checks.ts`) can return `not_applicable`/`unavailable` — the generic declarative dispatch (`checks_data.json`'s `import`/`text`/`text_any`/`text_absent`/`path_exists`/`path_absent`/`package_dependency`/`tsconfig_path_alias` kinds) always answers a global "does any file match" question with no conditional precondition, so it only ever produces `passed`/`failed`. `hosting_api_routes_use_typescript` and `data_fetching_expo_public_env_prefix` are code-driven specifically to get a `not_applicable` path (no `+api` routes / no client-side env var reads, respectively).

This status model matters because a check that vacuously passes when its precondition doesn't hold inflates uptake for a rule the app never had reason to engage with, and a syntax-tree check that reports `passed` when the parser couldn't run at all lets an infra failure read as compliance — `not_applicable`/`unavailable` exist as distinct, non-scored statuses specifically to rule out both.

`computeSkillResults` treats `unavailable` as outranking a mix of scored results: a skill with one passed check and one unavailable check reads `uptake_status="unavailable"`, not an unqualified "measured, 100%" — partial evidence shouldn't read as full confidence. `not_applicable` doesn't trigger this (it was successfully classified as irrelevant, not missing evidence).

Every result (all four statuses) stays in the per-skill `checks` list the HTML report reads — nothing is silently dropped, even though only `passed`/`failed` count toward `passed`/`total`/`uptake_rate`/`categoryBreakdown()` (see `UptakeResults`, `analysis.computeSkillResults`).

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
| `registry.ts` | Loads both, runs checks, defines `CheckResult`'s status model, and exposes registration for code-driven checks |
| `code_checks.ts` | Code-driven checks: per-file-subset filtering, real AST parsing, or conditional (`not_applicable`-capable) rules the generic declarative dispatch can't express |
| `trigger.ts` | Trigger detection, trace-based + recall/precision scoring against `dataset/prd_skills.json` |

## Contributor guide: add coverage for another skill

Most additions require two configuration changes:

### 1. Add checks

Add each observable rule from the skill to the `"checks"` array in
`checks_data.json`:

```json
{
  "id": "example_api_used",
  "category": "lexical",
  "kind": "text_any",
  "target": ["useExample\\(", "<Example[\\s/>]"],
  "description": "Uses one of the supported Example APIs"
}
```

Available kinds:

| Category | Kinds |
| --- | --- |
| `lexical` | `import`, `text`, `text_any`, `text_absent` |
| `structural` | `path_exists`, `path_absent`, `package_dependency`, `tsconfig_path_alias` |

`text` targets are JavaScript regular expressions passed to `new RegExp()`.
`text_any` accepts a list of alternative expressions. Path targets are
app-root-relative globs and may also be lists. `package_dependency` checks
`dependencies` and `devDependencies` in the root `package.json`.

If a rule needs conditional applicability, file-subset filtering, or syntax-tree
facts, register it in `code_checks.ts` instead. Code-driven checks can return
`not_applicable` or `unavailable`; declarative checks cannot.

### 2. Map checks to the skill

Add the canonical skill id and its check ids to `skill_map.json`:

```json
{
  "expo-example-skill": [
    "example_api_used"
  ]
}
```

Existing checks may be reused by multiple skills. Do not include an `expo:`
plugin namespace in the skill id.

A skill absent from `skill_map.json`, or a mapped id missing from the registry,
produces a warning in `metrics.json` rather than crashing.

### Example: `expo-router`

A shortened version of the existing `expo-router` configuration looks like
this in `checks_data.json`:

```json
{
  "id": "router_import",
  "category": "lexical",
  "kind": "import",
  "target": "expo-router",
  "description": "Imports from expo-router"
},
{
  "id": "router_app_dir_exists",
  "category": "structural",
  "kind": "path_exists",
  "target": ["app", "src/app"],
  "description": "app/ (or src/app/) directory exists"
}
```

The checks are then assigned to the skill in `skill_map.json`:

```json
{
  "expo-router": [
    "router_import",
    "router_app_dir_exists"
  ]
}
```

An authored app with an `app/` directory and a source file containing
`import { Link } from "expo-router"` passes both checks. The real
`expo-router` mapping contains additional checks; this example only shows the
mechanics.

### 3. Validate

Run from the repository root:

```bash
bun -e 'JSON.parse(await Bun.file("eval_harness/evaluator/skill_invocation/uptake_checks/checks_data.json").text()); JSON.parse(await Bun.file("eval_harness/evaluator/skill_invocation/uptake_checks/skill_map.json").text())'
bun test eval_harness/evaluator/skill_invocation/tests/skill_eval_core.test.ts
```

Then run the analyzer against at least one known-good authored app artifact:

```bash
bun eval_harness/evaluator/skill_invocation/main.ts analyze-artifacts \
  --authored-artifact /path/to/authored-app.tar.gz \
  --scenario skills_available_unmentioned \
  --out-dir /tmp/skill-eval-report
```

Inspect the new skill under `.skills` in `/tmp/skill-eval-report/metrics.json`.
It should have `uptake_status: "measured"`, the expected check count, and no
missing-mapping or unknown-check warnings.

For EAS validation, replay `.eas/workflows/eval-skill-use.yml` against a prior
`authored-app` artifact and inspect the resulting `skill-eval-report`.

### Optional: add regression tests

For checks with tricky matching behavior, add focused cases to
`../tests/skill_eval_core.test.ts`. Useful tests include:

- one implementation that should pass;
- one similar implementation that should fail; and
- alternative valid APIs or project layouts supported by the skill.

The existing `writeChecksDir`, `resolveChecksForSkills`, and `runChecks`
helpers can run checks against small temporary app trees.

### Best practices

- Keep each check atomic and grounded in a specific instruction from the
  skill.
- Reuse existing checks where possible; every mapped check has equal weight.
- Accept all valid APIs and layouts allowed by the skill.
- Anchor regexes to real syntax: for example, `"<List[\\s/>]"` avoids matching
  `<FlatList>`.
- Document known proxy limitations in the check description.
- Use `dataset/prd_skills.json` only to change which skills a PRD is expected
  to trigger; it is separate from uptake-check configuration.

### Routing expectations and evidence

`dataset/prd_skills.json` now accepts objects with `required`, `optional`, `forbidden`,
and `unlisted` (`observe` by default). Legacy arrays retain closed-set scoring.
The shared Expo router is required for implicit Expo tasks; complementary loads must
not lower precision merely because they are absent from an exhaustive answer key.
Code checks are resolved from required task skills even in unavailable-skill controls.

The historical trace detector remains a request detector: it does not prove successful
body delivery. Reports label it `requests_only`. Missing traces produce null trigger
scores and `trigger_status=unavailable`, including in aggregation. The focused evaluator
adds stricter delivery and edit-timing evidence using raw Claude streams; see
[`../focused/README.md`](../focused/README.md).
