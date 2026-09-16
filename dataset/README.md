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

### Coverage Signals

Expected skills are scoring ground truth from [`prd_skills.json`](prd_skills.json).
Module opportunities are lightweight portfolio signals, not implementation
requirements; an authored app may make another reasonable technical choice.

| App | Expected Expo skills beyond project structure | Likely Expo SDK module opportunities |
| --- | --- | --- |
| Notes | Router | SQLite, SecureStore |
| Hot Chocolate | Router, Native UI, Expo UI | Location, Maps, Sharing, Linking, SQLite |
| Wiki Reader | Router, Data Fetching, Native UI, Expo UI | WebBrowser, Sharing, SQLite |
| Pool | Router, Native UI | Expo UI, Router native tabs |
| Nourish | Router, Native UI | Camera, ImagePicker, FileSystem, Haptics |
| Nova | Router, Native UI | SQLite, Haptics |
| Twilight | Router, Native UI, Expo UI | SQLite, Haptics |
| Lichess | Router, Native UI | SQLite, Haptics |
| Bluesky | Router, Native UI | SQLite, ImagePicker, Sharing |
| Immich | Router, Native UI | MediaLibrary, ImagePicker, FileSystem, Sharing, SQLite |
| Cashew | Router, Native UI, Expo UI | SQLite, Haptics |
| Folo | Router, Data Fetching, Native UI | SQLite, Sharing, WebBrowser |
| Karakeep | Router, Data Fetching, Native UI | SQLite, Sharing, Clipboard, WebBrowser |
| Pocket Casts | Router, Data Fetching, Native UI | Audio, FileSystem, SQLite, Sharing |
| Bitwarden | Router, Native UI | SecureStore, Clipboard, SQLite, Haptics |
| Finch | Router, Native UI | SQLite, Haptics |
| Expensify | Router, Native UI, Expo UI | Camera, ImagePicker, FileSystem, SQLite |
| Pizza Hut | Router, Native UI | Location, SQLite, Haptics |
| Shop | Router, Data Fetching, Native UI | SQLite, Sharing, WebBrowser |
| Eventbrite | Router, Native UI | Location, Calendar, Sharing, FileSystem |
| Hello Aurora | Router, Data Fetching, Native UI, Expo UI | Location, Notifications, ImagePicker, Maps, SQLite |
| Duolingo | Router, Native UI | SQLite, Haptics |

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

### [Lichess](prds/lichess/prd/mvp.txt)

An offline chess-tactics trainer with a searchable puzzle catalog, accessible
tap-to-move board, hints, results, persistent rating, and progress summaries.
It exercises a spatial game interaction without depending on live matches.

- **Product reference:** [Lichess mobile](https://github.com/lichess-org/mobile)
- **Archetypes:** Catalog and detail, Gamified
- **Mapped primitives:** [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

### [Bluesky](prds/bluesky/prd/mvp.txt)

A seeded social client for browsing and refreshing a feed, composing and
managing posts, reacting, searching, viewing profiles, and handling
notifications without requiring a live social account.

- **Product reference:** [Bluesky social app](https://github.com/bluesky-social/social-app)
- **Archetypes:** Feed, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Pull to refresh](test_plans/primitives/test_pull_to_refresh.txt),
  [Progressive rendering](test_plans/primitives/test_progressive_rendering.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt),
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt), and
  [Button states](test_plans/primitives/test_button_states.txt)

### [Immich](prds/immich/prd/mvp.txt)

A private photo library with a date-grouped grid, searchable metadata,
favorites, editable albums, photo import, detail views, and native sharing.
Bundled media makes its main flows usable without a backup server.

- **Product reference:** [Immich](https://github.com/immich-app/immich)
- **Archetypes:** Catalog and detail, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Bottom sheet](test_plans/primitives/test_bottom_sheet.txt),
  [Permission prompt](test_plans/primitives/test_permission_prompt.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt),
  [Scrollable grid](test_plans/primitives/test_scrollable_grid.txt), and
  [Button states](test_plans/primitives/test_button_states.txt)

### [Cashew](prds/cashew/prd/mvp.txt)

A local personal-finance app for recording transactions, filtering history,
maintaining monthly category budgets, and inspecting accessible dashboard
summaries across multiple months.

- **Product reference:** [Cashew](https://github.com/jameskokoska/Cashew)
- **Archetypes:** Dashboard, List, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Native form sheet](test_plans/primitives/test_native_form_sheet.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

### [Folo](prds/folo/prd/mvp.txt)

An RSS/Atom reading inbox with starter feeds, paginated articles, search and
read filters, saved items, feed discovery, refresh failure handling, and
reading preferences.

- **Product reference:** [Folo](https://github.com/RSSNext/Folo)
- **Archetypes:** Feed, Catalog and detail
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Pull to refresh](test_plans/primitives/test_pull_to_refresh.txt),
  [Progressive rendering](test_plans/primitives/test_progressive_rendering.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

### [Karakeep](prds/karakeep/prd/mvp.txt)

A bookmark and knowledge inbox for saving links or notes, combining search and
filters, editing metadata, and organizing items into reusable lists and tags.

- **Product reference:** [Karakeep](https://github.com/karakeep-app/karakeep)
- **Archetypes:** List, Catalog and detail, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Bottom sheet](test_plans/primitives/test_bottom_sheet.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

### [Pocket Casts](prds/pocket_casts/prd/mvp.txt)

A podcast library with discovery, subscriptions, episode filters, downloads,
an editable Up Next queue, and accessible player state. Audible playback is
outside the MVP, keeping the queue and player-state flow self-contained.

- **Product reference:** [Pocket Casts](https://github.com/Automattic/pocket-casts-android)
- **Archetypes:** Catalog and detail, List
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Bottom sheet](test_plans/primitives/test_bottom_sheet.txt),
  [Pull to refresh](test_plans/primitives/test_pull_to_refresh.txt),
  [Progressive rendering](test_plans/primitives/test_progressive_rendering.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt), and
  [Button states](test_plans/primitives/test_button_states.txt)

### [Bitwarden](prds/bitwarden/prd/mvp.txt)

A locked local password vault with typed records, search and filters, masked
secret reveal/copy controls, item CRUD, password generation, and an explicit
session lifecycle.

- **Product reference:** [Bitwarden iOS](https://github.com/bitwarden/ios)
- **Archetypes:** List, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Credential collection](test_plans/primitives/test_credential_collection.txt),
  [Sign-in outcome](test_plans/primitives/test_sign_in_outcome.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Button states](test_plans/primitives/test_button_states.txt),
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

### [Finch](prds/finch/prd/mvp.txt)

A self-care goal tracker whose persistent companion, energy, currency, streak,
adventures, quests, and purchases turn small daily actions into a structured
progression loop.

- **Product reference:** [Finch](https://apps.apple.com/us/app/finch-self-care-pet/id1528595748)
- **Archetypes:** Dashboard, Gamified, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

### [Expensify](prds/expensify/prd/mvp.txt)

A demo team-expense workspace for entering receipts, filtering expenses,
building reports, and moving them through submit, reject, approve, and
reimburse states under two distinct roles.

- **Product reference:** [New Expensify](https://github.com/Expensify/App)
- **Archetypes:** List, Dashboard, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Native form sheet](test_plans/primitives/test_native_form_sheet.txt),
  [Permission prompt](test_plans/primitives/test_permission_prompt.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Pizza Hut](prds/pizza_hut/prd/mvp.txt)

A restaurant-ordering journey covering location and service-mode selection,
menu discovery, configurable products, deals, cart arithmetic, validated
checkout, rewards, and simulated fulfillment status.

- **Product reference:** [Pizza Hut iOS](https://apps.apple.com/us/app/pizza-hut-delivery-takeout/id321560858)
- **Archetypes:** Catalog and detail, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Permission prompt](test_plans/primitives/test_permission_prompt.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Shop](prds/shop/prd/mvp.txt)

A multi-store shopping feed with product and store discovery, follows, saved
collections, configurable cart lines, validated checkout, and accessible order
tracking milestones.

- **Product reference:** [Shop iOS](https://apps.apple.com/us/app/shop-track-pay-discover/id1223471316)
- **Archetypes:** Feed, Catalog and detail, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Progressive rendering](test_plans/primitives/test_progressive_rendering.txt),
  [Pull to refresh](test_plans/primitives/test_pull_to_refresh.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Bottom sheet](test_plans/primitives/test_bottom_sheet.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt),
  [Empty state](test_plans/primitives/test_empty_state.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Eventbrite](prds/eventbrite/prd/mvp.txt)

A local-event discovery and registration app with city selection, composable
search filters, organizer follows, simulated ticket orders, and accessible
ticket details including QR purpose and calendar/share actions.

- **Product reference:** [Eventbrite app](https://www.eventbrite.com/consumer/eventbrite-app/)
- **Archetypes:** Feed, Catalog and detail, Form and wizard
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Progressive rendering](test_plans/primitives/test_progressive_rendering.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Permission prompt](test_plans/primitives/test_permission_prompt.txt),
  [Native sharing](test_plans/primitives/test_native_sharing.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Hello Aurora](prds/hello_aurora/prd/mvp.txt)

A location-aware aurora dashboard with accessible space-weather summaries,
forecast refresh, configurable notification rules, a map-equivalent conditions
list, community sightings, and passport progress.

- **Product reference:** [Hello Aurora iOS](https://apps.apple.com/us/app/hello-aurora-aurora-forecast/id1457810302)
- **Archetypes:** Dashboard, Feed, Gamified
- **Mapped primitives:** [Insert](test_plans/primitives/test_insert.txt),
  [Delete](test_plans/primitives/test_delete.txt),
  [Update](test_plans/primitives/test_update.txt),
  [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Text search filter](test_plans/primitives/test_text_search_filter.txt),
  [Multi-filter composition](test_plans/primitives/test_multi_filter_composition.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Bottom sheet](test_plans/primitives/test_bottom_sheet.txt),
  [Pull to refresh](test_plans/primitives/test_pull_to_refresh.txt),
  [Permission prompt](test_plans/primitives/test_permission_prompt.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Button states](test_plans/primitives/test_button_states.txt), and
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt)

### [Duolingo](prds/duolingo/prd/mvp.txt)

A focused Spanish lesson path with accessible answer types, immediate feedback,
hearts, XP, gems, lesson unlocking, review practice, quests, and persistent
progress.

- **Product reference:** [Duolingo iOS](https://apps.apple.com/us/app/duolingo-language-lessons/id570060128)
- **Archetypes:** Form and wizard, Gamified, Dashboard
- **Mapped primitives:** [Select by ID](test_plans/primitives/test_select_by_id.txt),
  [Stack navigation](test_plans/primitives/test_stack_navigation.txt),
  [Tab navigation](test_plans/primitives/test_tab_navigation.txt),
  [Modal present](test_plans/primitives/test_modal_present.txt),
  [Modal dismiss](test_plans/primitives/test_modal_dismiss.txt),
  [Button states](test_plans/primitives/test_button_states.txt),
  [Keyboard handling](test_plans/primitives/test_keyboard_handling.txt), and
  [Theme selection](test_plans/primitives/test_theme_selection.txt)

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

Treat expected skills as a conservative ground truth: include a skill when a
competent agent would be surprisingly remiss not to consult it for the PRD, not
merely because the skill could be helpful. In particular, ordinary controls do
not automatically require `expo-ui`, and bundled data does not require
`expo-data-fetching`.

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
