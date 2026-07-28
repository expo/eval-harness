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
- The code must `npm install` cleanly and compile. Implement real persistence,
  real navigation, and the exact rules in the PRD (values, copy, error states).
- Before stopping, run `npm install` and `npx expo install --check`; if either
  reports a problem, fix it and rerun until both succeed.
- Verify the build is real: ensure `eas.json` has an `agent-verify` profile
  (`"ios": {"simulator": true}`), then run
  `eas init --id "$EAS_PROJECT_ID" --non-interactive --force` and
  `eas build --platform ios --profile agent-verify --non-interactive`. Fix
  real compile failures and rebuild. If `eas` fails for an auth/account
  reason unrelated to your code, don't block on it — note it and stop.

- When the app fully satisfies the PRD, `npm install` has succeeded, and `npx
expo install --check` has succeeded, stop — whether or not the `eas build`
  verification above was able to run.
