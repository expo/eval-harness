# @expo/skill-analyzer

Skill-use analysis for authored app artifacts: observed skill triggers, static
uptake checks, optional evaluator outcomes, and standalone HTML/JSON reports.
Scoring and report schemas are preserved from the existing harness. No models
or cloud services are invoked by analysis.

## Runtime and installation

Requires **Bun >=1.3.14** at runtime. Bun bundles the analyzer's JavaScript;
TypeScript and rollup-plugin-dts produce self-contained declarations. The
package's `exports`, `types`, and executable point into `build/`, with check JSON
included alongside the bundles. Compilation does not make this a Node runtime.

`@babel/parser` and `tar` are external runtime dependencies. The private
source-scan workspace is a dev dependency whose code and types are bundled;
consumers do not install it. Public declarations do not require `@types/bun` or
`allowImportingTsExtensions`. No source-copy or consumer build step is needed.

After publication:

```sh
bun add @expo/skill-analyzer
bunx skill-analyzer analyze-artifacts \
  --authored-artifact ./authored-app.tar.gz \
  --scenario skills_available_unmentioned \
  --prd-skills ./prd-skills.json \
  --out-dir ./skill-eval-report
```

`--prd-skills` is required: the package does not ship a repository dataset. Its
JSON maps app names (from the artifact PRD) to expected skill IDs, for example
`{"notes": ["expo-router"]}`. The default checks and skill map are bundled;
`--checks-dir` overrides both. `--eval-artifact` optionally supplies evaluator
outcomes. Directories, archives, and supported legacy artifact layouts work.

## Library API

```ts
import { analyzeArtifacts, defaultChecksDirectory } from '@expo/skill-analyzer';
import { unpackArtifact } from '@expo/skill-analyzer/artifacts';

const authored = unpackArtifact('./authored-app.tar.gz', './scratch/authored');
const result = await analyzeArtifacts({
  authoredArtifact: authored,
  authoredArtifactDisplayRoot: './authored-app.tar.gz',
  evalArtifact: null,
  scenario: 'skills_available_unmentioned',
  outDir: './skill-eval-report',
  prdSkillsPath: './prd-skills.json',
  checksDir: defaultChecksDirectory,
});
console.log(result.skills);
```

The caller owns library scratch cleanup; the CLI handles its own temporary
extractions. The root exports analysis/scoring functions and types, the check
registry, syntax checks, and bundle helpers. `./cli` exports `runCli`;
`./artifacts` exports safe extraction/materialization helpers and
`runMaterializeCli`. The explicit `analysis`, `utils`, `build_health/*`, and
`uptake_checks/*` subpaths support harness compatibility imports. Bundle helpers
can invoke the authored app's local Expo CLI; plain analysis reads its recorded
bundle result. The source parser runs in-process via the included helpers and `@babel/parser`;
there is no repository-relative child parser executable.

## Repository compatibility and verification

The existing `bun eval_harness/evaluator/skill_invocation/main.ts` CLI supplies
`dataset/prd_skills.json` as its default. Its shell wrapper, output-directory
validation, report schemas, and console summary remain compatible. Old module
paths re-export the package. Old check JSON paths are symlinks to the package's
single canonical copy. The materializer's old path remains a CLI and import shim.

From the repository root:

```sh
bun install
bun test eval_harness/evaluator/skill_invocation/tests
bun run --cwd packages/skill-analyzer test
bun run --cwd packages/skill-analyzer test:pack
```

The existing tests continue exercising the shims, shell validation, scoring,
artifact security, and dynamic CLI paths. The packed smoke installs real npm
tarballs outside the checkout, runs the installed Bun bin and API, checks every
export and TypeScript resolution, and compares metrics/manifests against both
the legacy CLI and fixtures captured before extraction. It needs npm registry
access. No live EAS/model validation is part of these commands.

See [check authoring](src/uptake_checks/README.md) for rules and coverage limits.

The build uses shared chunks so all public entrypoints see one check registry.
A dedicated `build/bin.js` entrypoint invokes the CLI; library imports have no
CLI side effects. `bun pm pack` runs the build and resolves catalog/workspace versions (Bun is
required on the build machine). Use Bun for packing or publishing releases;
direct `npm pack` does not resolve Bun catalogs.
The isolated smoke checks install the tarball with both npm and Bun, blocking
registry access for the private workspace. They check the executable, every
export, shared registry/class identity, packaged data, artifact parity, and
strict NodeNext/Bundler declarations without `skipLibCheck` or Bun ambient types.
