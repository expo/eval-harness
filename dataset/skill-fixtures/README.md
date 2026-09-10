# Focused skill fixtures

These small, synthetic repositories exercise skill selection and source edits without
requiring customer apps, service accounts or private traces. Case prompts and grading
expectations live in `../skill-cases.json`, outside the copied agent workspace.

- `expo-settings-v1`: an Expo SDK 55 TypeScript app with a settings form, existing tokens,
  a fetch helper with missing HTTP error handling, and a synthetic signing diagnostic.
  Package versions follow the [SDK 55 blank template](https://github.com/expo/expo/blob/sdk-55/templates/expo-template-blank-typescript/package.json).
  It can be installed and launched separately with `npm install` and `npm run ios`.
- `expo-fetch-correct-v1`: a small Expo package context with an already-correct HTTP
  helper. It checks that a review does not introduce unnecessary edits.
- `web-settings-v1`: a browser React form with no Expo dependencies.
- `bare-native-v1`: a React Native source fixture without Expo. It supplies routing
  context, not a complete Xcode/Gradle project.

The focused runner does not install packages or launch simulators. Its default tool set
is Read/Glob/Grep/Skill/Write/Edit, with shell, external MCP, hooks and subagents disabled
on both sides. This makes writes observable and keeps these tests free of cloud mutations.
It is a controlled routing/source-edit experiment, not a replacement for full app evals.

`source-syntax` means parsing succeeded, not that dependencies typecheck or the app builds.
`unchanged` checks protect selected behavior-bearing files byte for byte. The HTTP verifier executes success, HTTP-error and network-error contracts in a separate
process. Advice and native-runtime assertions remain pending for review. Read-only cases
compare all fixture files, including additions and deletions.

Treat versioned fixture directories as immutable once results are used as a baseline.
Create `-v2` for deliberate fixture changes. The runner hashes all fixture contents and
rejects comparisons when task or fixture conditions differ. Splits are by family;
validation and holdout are never selected by the default development run.

These initial cases are maintainer-reviewable seed cases, not a calibrated benchmark.
Review the labels and outcome assertions before relying on them for release decisions.
