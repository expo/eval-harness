# Dataset

Each dataset entry pairs an app PRD with reusable, app-agnostic test plans and
ground-truth mappings that tell the evaluators what to run. The inventory below
makes the dataset's product diversity and primitive coverage visible during
review.

For the base instructions given to the coding agent before the PRD — a separate
run dimension from the PRD itself — see [`prompts/README.md`](prompts/README.md).

## PRD Inventory

Archetypes use the catalog in
[`test_plans/primitives/README.md`](test_plans/primitives/README.md). `None`
means the app's defining experience does not cleanly fit one of those broad
archetypes; it does not mean the PRD has no structure or mapped test plans.
Mapped primitives are the complete lists in
[`prd_test_plans.json`](prd_test_plans.json), not claims that every feature in a
PRD is currently scored.

### [Notes](prds/notes/prd/mvp.txt)

A password-gated, single-user notes app for creating, editing, searching, and
deleting plain-text notes. Notes persist locally while the unlock lasts only
for the current session.

- **Archetypes:** List
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Credential collection](test_plans/primitives/test_credential_collection.txt),
  [Sign-in outcome](test_plans/primitives/test_sign_in_outcome.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Hot Chocolate](prds/hot_chocolate/prd/mvp.txt)

An offline festival guide for discovering hot chocolate flavours, cafes, and
store locations. Users can search and filter the catalog, inspect details,
track favourites and tasted items, view a map, and share entries.

- **Archetypes:** Catalog and detail
- **Mapped primitives:** [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Header configuration](test_plans/primitives/test_header_configuration.txt),
  [Bottom sheet](test_plans/primitives/test_bottom_sheet.txt),
  [Permission prompt](test_plans/primitives/test_permission_prompt.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Wiki Reader](prds/wiki_reader/prd/mvp.txt)

A focused mobile Wikipedia reader with search, random discovery, saved
articles, history, and reading preferences. It loads article content from
Wikipedia while keeping bookmarks and settings on the device.

- **Archetypes:** Catalog and detail
- **Mapped primitives:** [Delete](test_plans/primitives/test_delete.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Header configuration](test_plans/primitives/test_header_configuration.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Bottom sheet](test_plans/primitives/test_bottom_sheet.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Pull to refresh](test_plans/primitives/test_pull_to_refresh.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Pool](prds/pool/prd/mvp.txt)

An iOS-specific, read-only visual gallery for exercising native tabs, search,
form sheets, grids, and glass/scroll-edge treatments. Its purpose is a native
navigation and visual-surface challenge rather than a conventional product
archetype.

- **Archetypes:** None
- **Mapped primitives:** [Native tab bar](test_plans/primitives/test_native_tab_bar.txt),
  [Tab-screen transition](test_plans/primitives/test_tab_screen_transition.txt),
  [Native search tab](test_plans/primitives/test_native_search_tab.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Shared-header scroll-edge effect](test_plans/primitives/test_shared_header_scroll_edge_effect.txt),
  [Scrollable grid](test_plans/primitives/test_scrollable_grid.txt),
  [Native form sheet](test_plans/primitives/test_native_form_sheet.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

### [Nourish](prds/nourish/prd/mvp.txt)

An offline meal-photo nutrition tracker with fixed daily goals and repeatable
sample-photo analysis. Its defining flow is specialized media capture and
analysis, so it is intentionally not forced into a broad app archetype.

- **Archetypes:** None
- **Mapped primitives:** [Empty state](test_plans/primitives/test_empty_state.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt), and
  [Permission prompt](test_plans/primitives/test_permission_prompt.txt)

### [Nova](prds/nova/prd/mvp.txt)

A local chat app with deterministic, incrementally rendered responses. Users
can stop or retry replies and search, rename, select, and delete persistent
conversation history without a live model or API key.

- **Archetypes:** Chat
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Button states](test_plans/primitives/test_button_states.txt),
  [Gesture recognition](test_plans/primitives/test_gesture_recognition.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Twilight](prds/twilight/prd/mvp.txt)

A local-first sleep tracker with onboarding, summary dashboards, range-based
metrics, editable sleep history, and appearance settings. Deterministic sample
history replaces sensors and device-only integrations.

- **Archetypes:** Dashboard, List, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Gesture recognition](test_plans/primitives/test_gesture_recognition.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Native form sheet](test_plans/primitives/test_native_form_sheet.txt),
  [Theme selection](test_plans/primitives/test_theme_selection.txt), and
  [Button states](test_plans/primitives/test_button_states.txt)

## Adding A PRD

### 1. Classify the app before writing mappings

Choose every applicable app archetype from the catalog in
[`test_plans/primitives/README.md`](test_plans/primitives/README.md). Use `None`
when none is a good fit. This classification describes the product shape; it
does not automatically select test plans.

Then list the PRD's observable interactions and states. Map each one to an
existing primitive only when that plan's purpose and preconditions genuinely
match the requirement. Start with canonical primitives, then use compound or
specialized plans where the PRD explicitly calls for them.

If no existing primitive captures a feature, do not force a near match. Keep
the feature in the PRD and leave it unmapped for now, or add a new test plan
only when the behavior is reusable across apps and can be scored reliably. A
single PRD does not need exhaustive test-plan coverage to enter the dataset.

### 2. Add the PRD

Create:

```text
prds/<app_name>/prd/mvp.txt
```

Use an existing PRD such as [`notes/prd/mvp.txt`](prds/notes/prd/mvp.txt) as a
template. A typical PRD describes:

```text
App name and scope
Overview, platforms, persistence, and constraints
Primary navigation and screens
User-visible data, actions, states, and error behavior
Deterministic fixtures or external-service boundaries
Accessibility requirements
Out-of-scope behavior
```

Write requirements in terms of observable product behavior. Be especially
precise wherever a test plan will make an assertion: define relevant starting
state, labels or values, ordering, defaults, validation and error outcomes,
navigation results, and what persists across restarts. Keep untested
implementation choices open.

Prefer behavior that can be evaluated deterministically on a simulator. Adapt
live services, time-sensitive data, device sensors, and provider failures into
repeatable fixtures when they are not the capability being evaluated.

### 3. Select or add test plans

Reuse plans from [`test_plans/primitives/`](test_plans/primitives/) whenever
possible. Plans describe a primitive interaction and use the supplied PRD to
adapt it to each app; they should not encode one app's layout or implementation.

If a new primitive is justified, classify it as canonical, compound, or a
specialized extension and add it to the catalog. Follow this outline:

```text
<test_plan>
  <purpose>Behavior covered and how the PRD specializes it</purpose>
  <seeding_and_precondition>Required state and the N/A condition</seeding_and_precondition>
  <steps>
    <step>
      <name>Stable step name</name>
      Actions to perform
      Verify:
      - One observable assertion per line
      <points>Relative step weight</points>
    </step>
  </steps>
  <full_points>Sum of step points</full_points>
</test_plan>
```

Every hard assertion must follow from the PRD. Phrase assertions so any
reasonable PRD-compliant implementation can pass, and mark a primitive `N/A`
when the PRD does not require it. See
[`test_insert.txt`](test_plans/primitives/test_insert.txt) for a small example.

### 4. Add the ground-truth mappings

Use `<app_name>` (the directory name under `prds/`) as the key in both files:

- [`prd_test_plans.json`](prd_test_plans.json): test-plan filenames relevant to
  the app.
- [`prd_skills.json`](prd_skills.json): Expo skills the PRD is expected to
  trigger during authoring.

The normal E2E workflow resolves both lists automatically from the PRD path.

### 5. Update this inventory

Add the app's plain-English description, all applicable archetypes, and the
complete mapped-primitive list above. Reviewing the inventory is the point at
which maintainers can see overrepresented shapes, uncovered archetypes, and
primitive gaps before accepting another similar PRD.

### 6. Review and verify

Before submitting, read the PRD and selected test plans together:

- Each tested behavior is unambiguous in the PRD.
- Each mapping corresponds to an explicit PRD requirement.
- Each assertion is user-visible, implementation-agnostic, and reproducible.
- Seeds and throwaway values satisfy the PRD's constraints.
- Step points add up to `<full_points>`.
- New primitive plans appear exactly once in the taxonomy catalog.
- This inventory matches both ground-truth JSON files.

Run the resolver tests from the repository root:

```bash
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
```

Then prove the new entry through `.eas/workflows/eval-e2e.yml`; Notes is the
small reference example for comparison.
