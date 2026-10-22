# Migrate expo/skills to @expo/skill-analyzer

This is the plan for a separate expo/skills PR after the package is published.
No expo/skills files or submodule pointers are changed by this PR.

## Dependency and runtime

Add `@expo/skill-analyzer` as a development dependency in the checkout that runs
analysis, pin the published version, and commit the Bun lockfile. CI must install
that checkout's dependencies before invoking the package. Use Bun >=1.3.14.
The private `@expo/source-scan` package is bundled; do not add it as a dependency.

## CI entrypoints

On expo/skills main at the time of this change, `scripts/ci.sh` installs the
`eval-harness` submodule's dependencies and calls its `eval-skill-use.sh` wrapper
from both author-and-evaluate paths. Replace those analysis calls with the
installed analyzer executable, preserving each caller's artifact and report paths:

```sh
bun node_modules/.bin/skill-analyzer analyze-artifacts \
  --authored-artifact "$AUTHORED_ARTIFACT" \
  --scenario "$SCENARIO" \
  --prd-skills "$PRD_SKILLS" \
  --out-dir "$REPORT_DIR"
```

Pass `--eval-artifact` only when an evaluator artifact exists. The old shell
wrapper's environment variables are not CLI options automatically: expand them
explicitly as above. The package allows a caller-owned report directory; update
any subsequent copy/archive steps that assumed `eval-harness/skill-eval-report`.

`--prd-skills` is required. Keep using an explicit
`eval-harness/dataset/prd_skills.json` initially, or copy and maintain the expected
skill map in expo/skills. The package does not include that repository dataset.
The analyzer bundles its default checks and skill map. Omit `--checks-dir` unless
expo/skills owns a directory containing both `checks_data.json` and `skill_map.json`.

Keep the eval-harness submodule for authoring and datasets while those callers
still depend on it. Update its revision to the merged extraction when using its
updated authoring scripts. Installing the analyzer alone does not replace
`author-app.sh`, the PRDs, prompts, or report aggregation tools.

Review `.eas/workflows/skill-eval-ci.yml` and
`.eas/workflows/skill-eval-main-baseline.yml` together with `scripts/ci.sh`.
Include the analyzer version/lockfile in the baseline cache fingerprint so
reports computed by different analyzer versions are not mixed.

## Imports and utility commands

Replace source-file imports under
`eval-harness/eval_harness/evaluator/skill_invocation/` with package imports:

| Old source module                | Package import                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `analysis.ts`                    | `@expo/skill-analyzer`                                                                    |
| `utils.ts`                       | `@expo/skill-analyzer/utils`                                                              |
| `uptake_checks/registry.ts`      | `@expo/skill-analyzer/uptake_checks/registry`                                             |
| `uptake_checks/trigger.ts`       | `@expo/skill-analyzer/uptake_checks/trigger`                                              |
| `build_health/syntax_check.ts`   | `@expo/skill-analyzer` (`checkSyntax`)                                                    |
| `build_health/bundle_check.ts`   | `@expo/skill-analyzer` (`computeBundleResult`, `persistBundleResult`, `readBundleResult`) |
| `utils/artifacts/materialize.ts` | `@expo/skill-analyzer/artifacts`                                                          |

Use `defaultChecksDirectory` from the root package instead of repository-relative
check JSON paths. For shell callers:

```sh
bun node_modules/.bin/skill-analyzer materialize \
  --artifact "$ARTIFACT" --dest "$DEST" --root-name authored-app
bun node_modules/.bin/skill-analyzer bundle-check "$WORKSPACE" --platform ios
```

There are no old-path re-exports, check-data symlinks, or implicit ground-truth
fallbacks. Report schemas and scoring remain covered by fixed regression fixtures;
removing import compatibility does not discard archived artifact support.

## Verification in the follow-up PR

1. Install from the committed lockfile in a clean checkout.
2. Run analysis on a saved authored artifact with explicit ground truth; check
   metrics, manifest, report HTML, and downstream report parsing.
3. Exercise both fresh evaluation and cached-baseline paths. Check that changed
   analyzer versions invalidate the baseline cache.
4. Validate both EAS workflows, then request an eval run through the repository's
   normal review process. Publishing this library does not itself run evaluations.
