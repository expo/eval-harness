# Adding a PRD

Each dataset entry pairs an app PRD with reusable, app-agnostic test plans and
ground-truth mappings that tell the evaluators what to run.

## 1. Add the PRD

Create:

```text
prds/<app_name>/prd/mvp.txt
```

Use an existing PRD such as [`notes/prd/mvp.txt`](prds/notes/prd/mvp.txt) as a
template. A typical PRD describes:

```text
App name and scope
Overview, platforms, persistence, and constraints
Technical requirements for the evaluation condition
Primary navigation and screens
User-visible data, actions, states, and error behavior
Out-of-scope behavior
```

Write requirements in terms of observable product behavior. Be especially
precise wherever a test plan will make an assertion: define relevant starting
state, labels or values, ordering, defaults, validation and error outcomes,
navigation results, and what persists across restarts. Keep untested
implementation choices open.

Prefer behavior that can be evaluated deterministically on a simulator. Avoid
core flows that depend on unavailable external services, long waits, or other
state the evaluator cannot reproduce.

## 2. Select or add test plans

Reuse plans from [`test_plans/primitives/`](test_plans/primitives/) whenever
possible. Plans describe a primitive interaction and use the supplied PRD to
adapt it to each app; they should not encode one app's layout or implementation.

If a new primitive is needed, follow this outline:

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

## 3. Add the mappings

Use `<app_name>` (the directory name under `prds/`) as the key in both files:

- [`prd_test_plans.json`](prd_test_plans.json): test-plan filenames relevant to
  the app.
- [`prd_skills.json`](prd_skills.json): Expo skills the PRD is expected to
  trigger during authoring.

The normal E2E workflow resolves both lists automatically from the PRD path.

## 4. Review and verify

Before submitting, read the PRD and selected test plans together:

- Each tested behavior is unambiguous in the PRD.
- Each assertion is user-visible, implementation-agnostic, and reproducible.
- Seeds and throwaway values satisfy the PRD's constraints.
- Step points add up to `<full_points>`.

Run the resolver tests from the repository root:

```bash
PYTHONPATH=. uv run python -m unittest eval_harness.evaluator.ios_agentic.tests.test_test_plan_resolution
```

Then prove the new entry through `.eas/workflows/eval-e2e.yml`; Notes is the
small reference example for comparison.
