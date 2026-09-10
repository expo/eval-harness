# Parity fixture provenance

`metrics.json` and `manifest.json` were captured from the original, unmodified
`eval_harness/evaluator/skill_invocation/main.ts` at commit
`0b35f865998fe27dbdf2a95b0dc187489f54de9b` (parent
`2452dc7`, the current main analyzer), **before extraction**. Only temporary fixture root paths are normalized to
`<fixture>`; no scoring, checks, metrics, manifest fields, or evidence are
filtered. The fixture includes an observed router skill invocation, passing
and failing bundled checks, and actual TSX syntax parsing.

The capture created inputs with `scripts/fixture.mjs`'s `fixture(root)` and ran:

```sh
bun eval_harness/evaluator/skill_invocation/main.ts analyze-artifacts \
  --authored-artifact "$fixture_root/authored" \
  --scenario skills_available_unmentioned \
  --out-dir "$fixture_root/report" \
  --prd-skills "$fixture_root/prd-skills.json"
```

Both output JSON files were parsed and passed through
`normalize(payload, fixture_root)` before writing these files. The packed
consumer smoke compares both files against these fixed goldens. Do not regenerate
them from the extracted package to validate this extraction; reproducing the baseline requires checking out the commit above.

The original analyzer tests remain under
`eval_harness/evaluator/skill_invocation/tests/`, importing the package directly
and invoking its installed CLI. Package
boundary tests here cover the newly required CLI ground-truth argument and
public imports; packed smoke covers an npm installation outside the checkout.
