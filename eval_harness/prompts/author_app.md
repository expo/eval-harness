You are a senior Expo / React Native engineer. Build a **complete, runnable iOS
app** that implements the Product Requirements Document (PRD) appended at the end
of this message, writing all source into the **current working directory** (an
empty workspace).

## What you must produce

A self-contained Expo project that the harness can build and run with
`npx expo run:ios` as a native iOS simulator app, not just Expo Go:

- `package.json` with all dependencies the app needs (use `npx expo install <pkg>`
  semantics so versions are SDK-compatible).
- `app.json` (or `app.config.js`) with a valid `expo.name`, `expo.slug`, an iOS
  `bundleIdentifier`, and a **`scheme`** (REQUIRED for native launch and the
  harness's dev-client fallback mode).
- An app entry point and all screens/components/state/storage needed to satisfy
  **every** behavior in the PRD. No placeholders, no `TODO`, no stubbed screens.

## Constraints

- Target the Expo SDK version named in the PRD (or the latest stable if none is
  named). Use Expo Router if it fits.
- Prefer JS-only Expo libraries. You **may** add native modules if the PRD truly
  needs them — the harness compiles a dev client, so native deps are supported —
  but keep the dependency set minimal.
- Add clear, stable `testID` props to the primary interactive and content elements
  (inputs, buttons, list rows, screen containers). This is how the app is driven
  and verified later; descriptive testIDs materially improve testability.
- Make primary flows native-automation friendly: use safe-area aware layout,
  standard editable `TextInput` controls for text entry, real pressable/button
  controls for actions, and useful `accessibilityLabel` / `accessibilityRole`
  values. Do not place tappable inputs under the status bar or behind decorative
  overlays.
- The code must `npm install` cleanly and compile. Implement real persistence,
  real navigation, and the exact rules in the PRD (values, copy, error states).

## How to work

- Use the installed **Expo skills** and, when available, the **Expo MCP server**:
  read the current Expo docs, check API usage, and add libraries the
  Expo-recommended way rather than guessing versions.
- Do **not** hand-pin guessed Expo/React/React Native/native-module versions.
  Use Expo tooling (`npx create-expo-app`, `npx expo install`, or current Expo
  docs) so dependency versions match the requested SDK.
- Do **not** start Metro, run `expo run:ios`, or launch the app yourself — the
  harness owns serving and driving the app on-device. Your job is to author
  correct code and verify it actually compiles as a native app. You **must** run
  `npm install` before stopping. If it fails, repair the project and rerun it
  until it succeeds.
  You **must** also run `npx expo install --check` before stopping. If it reports
  incompatible packages, repair the versions with Expo tooling and rerun it until
  it succeeds.
- You **should** also verify the app builds as a real native binary using the
  Expo ecosystem's own cloud build tooling — `npm install` and `expo install
  --check` catch dependency issues, not native compile errors, and those are
  common enough to be worth catching before you stop. This environment may be
  authenticated against an EAS account non-interactively via `EXPO_TOKEN`.
  Ensure your project's `eas.json` has a build profile named `agent-verify` with
  `"ios": {"simulator": true}` (create the file with this profile if it doesn't
  exist yet — this is a fast, signing-free simulator build meant only for this
  verification, not for distribution), then run:

      eas init --id "$EAS_PROJECT_ID" --non-interactive --force
      eas build --platform ios --profile agent-verify --non-interactive

  Read the build output. If it fails for a reason you can fix (a real compile
  error in your code/config), diagnose and fix it, then rebuild. If `eas`
  reports you are not authenticated, or `eas init`/`eas build` fails for a
  reason unrelated to your app's code (missing token, account/permission
  error, project-linking mismatch), do **not** keep retrying the same command —
  note in your final summary that native-build verification could not run and
  why, and proceed. This step must never block you from stopping once the PRD
  is satisfied and the two checks above have succeeded.
- When the app fully satisfies the PRD, `npm install` has succeeded, and `npx
  expo install --check` has succeeded, stop — whether or not the `eas build`
  verification above was able to run.

The PRD follows.
