# Primitive Test-Plan Taxonomy

This directory contains reusable black-box plans for observable app-development
primitives. A PRD opts into plans through
[`../../prd_test_plans.json`](../../prd_test_plans.json); directory membership
alone does not make a plan applicable to every app.

The catalog is an intake and review aid, not a claim that the current evaluator
perfectly scores every possible mobile behavior. Keep PRD requirements broader
when product realism calls for it, while mapping only behavior the harness can
exercise repeatably.

## App Archetypes

Archetypes describe the broad product shape. They help the dataset maintain a
diverse mix, but they do not automatically determine primitive mappings. An app
can have multiple archetypes or `None`.

| Archetype | Typical shape |
| --- | --- |
| List | A collection is the primary surface and users create, find, select, update, or remove records. |
| Feed | A time- or relevance-ordered stream emphasizes browsing and repeated consumption. |
| Chat | Ordered messages, a composer, and incremental conversational responses form the core loop. |
| Dashboard | Summaries, status, trends, or metrics from underlying data are centralized in one view. |
| Catalog and detail | Users browse or search a collection, then open richer detail views for individual items. |
| Form and wizard | Structured input, validation, and single- or multi-step completion drive the experience. |
| Gamified | Scores, progress, rewards, challenges, or game mechanics are central rather than incidental. |

## Primitive Tiers

- **Canonical:** a small, broadly reusable behavior common across many app
  types. Prefer these when they accurately describe the PRD.
- **Compound:** a reusable scenario that combines closely related primitives or
  needs more setup than one atomic interaction.
- **Specialized extension:** a narrower platform or presentation capability.
  These remain useful without being promoted into the canonical core.

Tier is independent from evaluator quality. A canonical behavior may still be
difficult to assert, and an extension may have a stable structured signal.

## Catalog

### Identity

| Test plan | Tier | Observable behavior |
| --- | --- | --- |
| [`test_credential_collection.txt`](test_credential_collection.txt) | Canonical | Credential fields, masking, and required-input validation. |
| [`test_session_lifecycle.txt`](test_session_lifecycle.txt) | Compound | Authenticated-session persistence and explicit sign-out teardown. |
| [`test_sign_in_outcome.txt`](test_sign_in_outcome.txt) | Compound | Invalid and valid sign-in outcomes. |

### Data And Collection Behavior

| Test plan | Tier | Observable behavior |
| --- | --- | --- |
| [`test_insert.txt`](test_insert.txt) | Canonical | Create one record with the expected values. |
| [`test_delete.txt`](test_delete.txt) | Canonical | Permanently remove the selected record. |
| [`test_update.txt`](test_update.txt) | Canonical | Edit the selected record without changing another. |
| [`test_select_by_id.txt`](test_select_by_id.txt) | Canonical | Open the exact record selected from a collection. |
| [`test_text_search_filter.txt`](test_text_search_filter.txt) | Compound | Filter a collection with case-insensitive text search and restore it when cleared. |
| [`test_multi_filter_composition.txt`](test_multi_filter_composition.txt) | Compound | Combine multiple filters and clear them predictably. |
| [`test_progressive_rendering.txt`](test_progressive_rendering.txt) | Canonical | Append more records while scrolling a collection without losing prior rows. |

### Navigation

| Test plan | Tier | Observable behavior |
| --- | --- | --- |
| [`test_stack_navigation.txt`](test_stack_navigation.txt) | Compound | Push a destination and return through a navigation stack. |
| [`test_header_configuration.txt`](test_header_configuration.txt) | Canonical | Show the PRD-required header title and actions on the right screens. |
| [`test_pop_to_root.txt`](test_pop_to_root.txt) | Canonical | Clear multiple nested destinations and return to a stack root in one action. |
| [`test_modal_present.txt`](test_modal_present.txt) | Canonical | Present the requested modal over its originating context. |
| [`test_modal_dismiss.txt`](test_modal_dismiss.txt) | Canonical | Dismiss a modal and restore the unchanged underlying context. |
| [`test_sheet_detents.txt`](test_sheet_detents.txt) | Canonical | Open a sheet at one snap height and resize it to another configured detent. |
| [`test_tab_navigation.txt`](test_tab_navigation.txt) | Compound | Switch labelled tabs while preserving expected per-tab state. |

### Interaction And Surface State

| Test plan | Tier | Observable behavior |
| --- | --- | --- |
| [`test_empty_state.txt`](test_empty_state.txt) | Canonical | Show explicit guidance when a collection or result set is empty. |
| [`test_button_states.txt`](test_button_states.txt) | Canonical | Expose the correct enabled and disabled action states as input changes. |
| [`test_keyboard_handling.txt`](test_keyboard_handling.txt) | Compound | Keep input usable above the keyboard and dismiss it as required. |
| [`test_bottom_sheet.txt`](test_bottom_sheet.txt) | Compound | Present and dismiss a bottom-anchored sheet or drawer-like surface. |
| [`test_pull_to_refresh.txt`](test_pull_to_refresh.txt) | Compound | Trigger refresh with the native pull gesture and retain usable content. |

### Device And System Integration

| Test plan | Tier | Observable behavior |
| --- | --- | --- |
| [`test_gesture_recognition.txt`](test_gesture_recognition.txt) | Compound | Recognize the PRD-specified gesture without firing the wrong action. |
| [`test_native_sharing.txt`](test_native_sharing.txt) | Compound | Open the system share surface with the expected content. |
| [`test_permission_prompt.txt`](test_permission_prompt.txt) | Compound | Request a device permission at the right time and recover from denial. |

### Specialized Extensions

| Test plan | Tier | Observable behavior |
| --- | --- | --- |
| [`test_native_form_sheet.txt`](test_native_form_sheet.txt) | Specialized extension | Present a form using native sheet treatment and native drag dismissal. |
| [`test_native_search_tab.txt`](test_native_search_tab.txt) | Specialized extension | Use a platform-native search-role tab and search surface. |
| [`test_native_tab_bar.txt`](test_native_tab_bar.txt) | Specialized extension | Render and select the required native tab-bar items. |
| [`test_scrollable_grid.txt`](test_scrollable_grid.txt) | Specialized extension | Scroll a multi-column visual grid with distinct records. |
| [`test_shared_header_scroll_edge_effect.txt`](test_shared_header_scroll_edge_effect.txt) | Specialized extension | Preserve a shared header and native scroll-edge treatment across destinations. |
| [`test_tab_screen_transition.txt`](test_tab_screen_transition.txt) | Specialized extension | Apply the required transition when switching tab content. |
| [`test_theme_selection.txt`](test_theme_selection.txt) | Specialized extension | Select System, Light, or Dark appearance and apply it consistently. |

## Adding Or Mapping A Plan

1. Read the PRD and list its observable interactions and states.
2. Reuse an existing plan only when its purpose, setup, and assertions match an
   explicit requirement. A shared word such as “sheet” or “search” is not enough.
3. If nothing matches, leave the feature unmapped unless it supports a reusable,
   app-agnostic, deterministic black-box plan. Novel or visually judged behavior
   can remain a product requirement without earning a test plan yet.
4. For a new plan, define an N/A path, keep one assertion per `Verify:` line,
   make points add up, classify its tier, and add it exactly once to this catalog.
5. Update the app mapping and the PRD inventory in
   [`../../README.md`](../../README.md), then run the resolver tests documented
   there.

This workflow is taxonomy-gated in a simple sense: classification and mapping
are required review steps. The taxonomy guides the decision and exposes gaps;
it does not block a useful PRD merely because the library has not yet learned
how to score every feature.
