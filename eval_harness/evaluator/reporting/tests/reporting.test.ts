import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  copyScreenshotEvidence,
  normalizeRun,
} from "../normalize.ts";
import { parseArgs } from "../main.ts";
import type { ConsolidatedSummary, ReportInputs } from "../types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "eval-report-test-"));
  tempRoots.push(root);
  return root;
}

function copyFixture(name: "author" | "skill" | "ios", root: string): string {
  const target = join(root, name);
  cpSync(join(FIXTURES, name), target, { recursive: true });
  return target;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function inputs(root: string, options: {
  skill?: boolean;
  ios?: boolean;
} = {}): ReportInputs {
  return {
    authoredArtifact: copyFixture("author", root),
    skillArtifact: options.skill === false ? null : copyFixture("skill", root),
    iosArtifact: options.ios === false ? null : copyFixture("ios", root),
    outDir: join(root, "eval-report"),
  };
}

describe("normalizeRun", () => {
  test("normalizes a full v2 run and copies only authoritative JSON", async () => {
    // Catches adapters reading arbitrary legacy files or converting valid zeros/nulls.
    const root = tempRoot();
    const args = inputs(root);

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("complete");
    expect(summary.run).toEqual({
      run_id: "run-fixture-1",
      git_sha: "abc1234",
      prd: "dataset/prds/notes/prd/mvp.txt",
      prompt_variant: "realistic",
      skill_scenario: "skills_available_unmentioned",
      author: { agent: "muse-code", model: "muse-spark-1.2", effort: "high" },
      evaluator: { model: "claude-opus-4-8", effort: "high" },
    });
    expect(summary.scores).toEqual({
      ios_macro_pct: 82.5,
      skill_trigger_recall: 0.5,
      skill_uptake_rate: 0.75,
    });
    expect(summary.skills).toEqual([
      expect.objectContaining({ skill_id: "expo-router", uptake_rate: 0.75 }),
    ]);
    expect(summary.ios.test_plans).toHaveLength(1);
    expect(summary.build_health.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "app_authored", status: "passed" },
      { id: "dependency_install", status: "passed" },
      { id: "syntax", status: "passed" },
      { id: "expo_export", status: "warning" },
      { id: "native_build", status: "passed" },
      { id: "app_launch", status: "passed" },
      { id: "evaluation", status: "passed" },
    ]);
    expect(summary.warnings).toContain("fixture skill warning");

    expect(readJson(join(args.outDir, "summary.json"))).toEqual(summary);
    expect(JSON.parse(readFileSync(join(args.outDir, "data/build-health.json"), "utf8")))
      .toEqual(summary.build_health);
    expect(readFileSync(join(args.outDir, "data/author-manifest.json"), "utf8"))
      .toBe(readFileSync(join(args.authoredArtifact, "manifest.json"), "utf8"));
    expect(readFileSync(join(args.outDir, "data/skill-metrics.json"), "utf8"))
      .toBe(readFileSync(join(args.skillArtifact!, "metrics.json"), "utf8"));
    expect(readFileSync(join(args.outDir, "data/ios-result.json"), "utf8"))
      .toBe(readFileSync(join(args.iosArtifact!, "result.json"), "utf8"));
  });

  test("keeps an author-only run complete and marks optional stages unavailable", async () => {
    // Catches intentionally disabled optional jobs being mislabeled partial/failed.
    const root = tempRoot();
    const args = inputs(root, { skill: false, ios: false });

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("complete");
    expect(summary.scores).toEqual({
      ios_macro_pct: null,
      skill_trigger_recall: null,
      skill_uptake_rate: null,
    });
    expect(summary.build_health.map((stage) => stage.status)).toEqual([
      "passed", "not_run", "not_run", "warning", "not_run", "not_run", "not_run",
    ]);
    expect(summary.warnings).toEqual([
      "skill evaluation was not supplied (disabled or unavailable)",
      "iOS evaluation was not supplied (disabled or unavailable)",
    ]);
    expect(existsSync(join(args.outDir, "data/skill-metrics.json"))).toBe(false);
    expect(existsSync(join(args.outDir, "data/ios-result.json"))).toBe(false);
  });

  test("keeps skill-disabled and iOS-disabled runs complete independently", async () => {
    // Catches either optional evaluator becoming implicitly required.
    const skillDisabledRoot = tempRoot();
    const skillDisabled = await normalizeRun(
      inputs(skillDisabledRoot, { skill: false }),
    );
    expect(skillDisabled.status).toBe("complete");
    expect(skillDisabled.scores.skill_trigger_recall).toBeNull();
    expect(skillDisabled.scores.ios_macro_pct).toBe(82.5);

    const iosDisabledRoot = tempRoot();
    const iosDisabled = await normalizeRun(
      inputs(iosDisabledRoot, { ios: false }),
    );
    expect(iosDisabled.status).toBe("complete");
    expect(iosDisabled.scores.ios_macro_pct).toBeNull();
    expect(iosDisabled.scores.skill_trigger_recall).toBe(0.5);
  });

  test("marks explicit evaluator errors failed without fabricating a score", async () => {
    // Catches infrastructure errors being flattened into a zero-quality score.
    const root = tempRoot();
    const args = inputs(root);
    writeJson(join(args.iosArtifact!, "result.json"), {
      status: "incomplete",
      macro_avg_pct: 91,
      evaluator_errors: [{ stage: "restart", reason: "app never launched" }],
      test_plans: [{
        test_plan: "test_insert.txt",
        run_index: 1,
        status: "evaluator_error",
        score: null,
        full_points: null,
        macro_pct: null,
        steps: [],
      }],
    });

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("failed");
    expect(summary.scores.ios_macro_pct).toBeNull();
    expect(summary.build_health.at(-1)?.status).toBe("failed");
    expect(summary.warnings.join(" ")).toContain("app never launched");
  });

  test("does not let a completed result mask an explicit failed iOS gate", async () => {
    // Catches result-file existence overriding the producer's terminal gate failure.
    const root = tempRoot();
    const args = inputs(root);
    const manifest = readJson(join(args.iosArtifact!, "manifest.json"));
    const health = manifest.build_health as Record<string, Record<string, unknown>>;
    health.evaluation = {
      status: "failed",
      detail: "result validation rejected the evaluator output",
      log: "logs/s7-eval.log",
    };
    writeJson(join(args.iosArtifact!, "manifest.json"), manifest);

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("failed");
    expect(summary.scores.ios_macro_pct).toBeNull();
    expect(summary.build_health[6]).toEqual({
      id: "evaluation",
      label: "iOS evaluation completion",
      status: "failed",
      detail: "result validation rejected the evaluator output",
      log: "logs/s7-eval.log",
    });
  });

  test("marks a supplied optional artifact with a missing result partial", async () => {
    // Catches an incomplete uploaded evaluator artifact looking disabled or complete.
    const root = tempRoot();
    const args = inputs(root);
    rmSync(join(args.iosArtifact!, "result.json"));

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("partial");
    expect(summary.scores.ios_macro_pct).toBeNull();
    expect(summary.warnings).toContain("iOS artifact is missing result.json");
  });

  test("marks malformed optional data and non-terminal evaluator output partial", async () => {
    // Catches supplied-but-incomplete artifacts being treated like intentionally disabled jobs.
    const root = tempRoot();
    const args = inputs(root);
    writeFileSync(join(args.skillArtifact!, "metrics.json"), "{not-json\n");
    const result = readJson(join(args.iosArtifact!, "result.json"));
    result.status = "running";
    result.macro_avg_pct = 99;
    writeJson(join(args.iosArtifact!, "result.json"), result);

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("partial");
    expect(summary.scores).toEqual({
      ios_macro_pct: null,
      skill_trigger_recall: null,
      skill_uptake_rate: null,
    });
    expect(summary.build_health[6]?.status).toBe("warning");
    expect(readFileSync(join(args.outDir, "data/skill-metrics.json"), "utf8"))
      .toBe("{not-json\n");
  });

  test("keeps pending skill outcome complete when iOS was intentionally omitted", async () => {
    // Catches the skill evaluator's iOS-dependent pending label degrading a skill-only run.
    const root = tempRoot();
    const args = inputs(root, { ios: false });
    const metrics = readJson(join(args.skillArtifact!, "metrics.json"));
    metrics.outcome_status = "pending";
    writeJson(join(args.skillArtifact!, "metrics.json"), metrics);

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("complete");
    expect(summary.scores.skill_trigger_recall).toBe(0.5);
  });

  test("preserves legitimate null and numeric zero scores", async () => {
    // Catches nullish coercion (`Number(null)` or `|| 0`) corrupting unavailable data.
    const nullRoot = tempRoot();
    const nullArgs = inputs(nullRoot);
    const nullMetrics = readJson(join(nullArgs.skillArtifact!, "metrics.json"));
    const nullScore = nullMetrics.score as Record<string, Record<string, unknown>>;
    nullScore.trigger_quality!.recall = null;
    nullScore.context_uptake!.uptake_rate = null;
    writeJson(join(nullArgs.skillArtifact!, "metrics.json"), nullMetrics);
    const nullResult = readJson(join(nullArgs.iosArtifact!, "result.json"));
    nullResult.macro_avg_pct = null;
    writeJson(join(nullArgs.iosArtifact!, "result.json"), nullResult);

    const nullSummary = await normalizeRun(nullArgs);
    expect(nullSummary.status).toBe("complete");
    expect(nullSummary.scores).toEqual({
      ios_macro_pct: null,
      skill_trigger_recall: null,
      skill_uptake_rate: null,
    });

    const zeroRoot = tempRoot();
    const zeroArgs = inputs(zeroRoot);
    const zeroMetrics = readJson(join(zeroArgs.skillArtifact!, "metrics.json"));
    const zeroScore = zeroMetrics.score as Record<string, Record<string, unknown>>;
    zeroScore.trigger_quality!.recall = 0;
    zeroScore.context_uptake!.uptake_rate = 0;
    writeJson(join(zeroArgs.skillArtifact!, "metrics.json"), zeroMetrics);
    const zeroResult = readJson(join(zeroArgs.iosArtifact!, "result.json"));
    zeroResult.macro_avg_pct = 0;
    writeJson(join(zeroArgs.iosArtifact!, "result.json"), zeroResult);

    const zeroSummary = await normalizeRun(zeroArgs);
    expect(zeroSummary.status).toBe("complete");
    expect(zeroSummary.scores).toEqual({
      ios_macro_pct: 0,
      skill_trigger_recall: 0,
      skill_uptake_rate: 0,
    });
  });

  test("uses failed over partial status and producer build-health precedence", async () => {
    // Catches source-order bugs where syntax or iOS status hides author failure.
    const root = tempRoot();
    const args = inputs(root);
    const author = readJson(join(args.authoredArtifact, "manifest.json"));
    const authorHealth = author.build_health as Record<string, Record<string, unknown>>;
    authorHealth.app_authored!.status = "failed";
    writeJson(join(args.authoredArtifact, "manifest.json"), author);
    rmSync(join(args.skillArtifact!, "metrics.json"));

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("failed");
    expect(summary.build_health[0]?.status).toBe("failed");
    expect(summary.build_health[2]?.status).toBe("not_run");
  });

  test("prefers the v2 author Expo-export stage over the skill probe fallback", async () => {
    // Catches a later analyzer probe overriding the producer-owned stage outcome.
    const root = tempRoot();
    const args = inputs(root);
    const author = readJson(join(args.authoredArtifact, "manifest.json"));
    const authorHealth = author.build_health as Record<string, Record<string, unknown>>;
    authorHealth.expo_export = {
      status: "passed",
      detail: null,
      log: "author-agent-metadata/run-fixture-1/logs/d-expo-export.log",
    };
    writeJson(join(args.authoredArtifact, "manifest.json"), author);

    const summary = await normalizeRun(args);

    expect(summary.build_health[3]).toEqual({
      id: "expo_export",
      label: "Expo iOS bundle export",
      status: "passed",
      detail: null,
      log: "author-agent-metadata/run-fixture-1/logs/d-expo-export.log",
    });
  });

  test("aggregates normalized author and evaluator usage without coercion", async () => {
    // Catches the stable usage section remaining empty despite producer trace summaries.
    const root = tempRoot();
    const args = inputs(root);
    writeJson(
      join(
        args.authoredArtifact,
        "author-agent-metadata/run-fixture-1/telemetry/traces/muse-code-authoring.json",
      ),
      {
        sessions: [{
          turns: [
            { total_usage: { prompt_tokens: 4, completion_tokens: 2 } },
            { total_usage: { prompt_tokens: 3, completion_tokens: 1, ignored: "7" } },
          ],
        }],
      },
    );
    writeJson(
      join(args.iosArtifact!, "traces/test-plans/test_insert_1/summary.json"),
      {
        plan: "test_insert.txt",
        total_usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_cost_usd: 0.25,
        },
      },
    );
    writeJson(
      join(args.iosArtifact!, "traces/test-plans/test_insert_2/summary.json"),
      {
        plan: "test_insert.txt",
        total_usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_cost_usd: null,
        },
      },
    );

    const summary = await normalizeRun(args);

    expect(summary.usage.author).toEqual({
      completion_tokens: 3,
      prompt_tokens: 7,
    });
    expect(summary.usage.evaluator).toEqual({
      input_tokens: 12,
      output_tokens: 6,
      total_cost_usd: 0.25,
    });
  });

  test("does not read usage through producer artifact path traversal", async () => {
    // Catches manifest-controlled trace paths reading numeric data outside an artifact.
    const root = tempRoot();
    const args = inputs(root);
    writeJson(join(root, "outside-author.json"), {
      sessions: [{ turns: [{ total_usage: { prompt_tokens: 999 } }] }],
    });
    writeJson(join(root, "outside-traces/plan/summary.json"), {
      plan: "test_insert.txt",
      total_usage: { input_tokens: 999 },
    });
    const author = readJson(join(args.authoredArtifact, "manifest.json"));
    (author.artifacts as Record<string, unknown>).author_trace = "../outside-author.json";
    writeJson(join(args.authoredArtifact, "manifest.json"), author);
    const ios = readJson(join(args.iosArtifact!, "manifest.json"));
    (ios.artifacts as Record<string, unknown>).test_plan_traces = "../outside-traces/";
    writeJson(join(args.iosArtifact!, "manifest.json"), ios);

    const summary = await normalizeRun(args);

    expect(summary.usage).toEqual({ author: {}, evaluator: {} });
  });

  test("writes the stable eval-report manifest and exact machine-data inventory", async () => {
    // Catches report artifacts leaking source/log/trace/tar files or unstable paths.
    const root = tempRoot();
    const args = inputs(root);
    writeFileSync(join(args.authoredArtifact, "secret.log"), "do not copy");
    writeFileSync(join(args.iosArtifact!, "trace.json"), "do not copy");
    writeFileSync(join(args.skillArtifact!, "nested.tgz"), "do not copy");

    await normalizeRun(args);

    expect(readJson(join(args.outDir, "manifest.json"))).toEqual({
      schema_version: 1,
      artifact_type: "eval-report",
      run_id: "run-fixture-1",
      artifacts: {
        report: "report.html",
        summary: "summary.json",
        data: "data/",
        screenshots: "evidence/screenshots/",
      },
    });
    expect(readdirSync(args.outDir).sort()).toEqual([
      "data", "evidence", "manifest.json", "summary.json",
    ]);
    expect(readdirSync(join(args.outDir, "data")).sort()).toEqual([
      "author-manifest.json", "build-health.json", "ios-result.json", "skill-metrics.json",
    ]);
    expect(readdirSync(join(args.outDir, "evidence"))).toEqual(["screenshots"]);
    expect(readdirSync(join(args.outDir, "evidence/screenshots"))).toEqual([]);
  });
});

describe("reporting CLI", () => {
  test("parses required and optional artifact paths without inventing inputs", () => {
    // Catches optional evaluator arguments becoming required or defaulting to fake paths.
    expect(parseArgs([
      "--authored-artifact", "author",
      "--out-dir", "report",
    ])).toEqual({
      authoredArtifact: "author",
      skillArtifact: null,
      iosArtifact: null,
      outDir: "report",
    });
  });

  test("writes the machine-data artifact through the real Bun entrypoint", () => {
    // Catches the exported adapter working while the documented executable CLI is broken.
    const root = tempRoot();
    const args = inputs(root);
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "../main.ts"),
      "--authored-artifact", args.authoredArtifact,
      "--skill-artifact", args.skillArtifact!,
      "--ios-artifact", args.iosArtifact!,
      "--out-dir", args.outDir,
    ]);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(readJson(join(args.outDir, "manifest.json"))).toEqual(
      expect.objectContaining({ artifact_type: "eval-report", run_id: "run-fixture-1" }),
    );
  });
});

describe("copyScreenshotEvidence", () => {
  function screenshotRun(): {
    root: string;
    iosRoot: string;
    outDir: string;
    summary: ConsolidatedSummary;
  } {
    const root = tempRoot();
    const args = inputs(root);
    const planTrace = join(
      args.iosArtifact!,
      "traces/test-plans/test_insert_20260810_120000",
    );
    writeJson(join(planTrace, "summary.json"), {
      plan: "test_insert.txt",
      run_index: 1,
    });
    mkdirSync(join(planTrace, "screenshots"), { recursive: true });
    const result = readJson(join(args.iosArtifact!, "result.json"));
    const steps = ((result.test_plans as Array<Record<string, unknown>>)[0]?.steps) as Array<Record<string, unknown>>;
    steps[0]!.screenshot = "screenshots/step-01-final.png";
    steps[1]!.screenshot = "screenshots/step-02-final.png";
    writeFileSync(join(planTrace, "screenshots/step-01-final.png"), "passed png");
    writeFileSync(join(planTrace, "screenshots/step-02-final.png"), "failed png");
    writeJson(join(args.iosArtifact!, "result.json"), result);
    return {
      root,
      iosRoot: args.iosArtifact!,
      outDir: args.outDir,
      summary: undefined as unknown as ConsolidatedSummary,
    };
  }

  test("copies referenced PNGs to stable names, rewrites paths, and sorts failures first", async () => {
    // Catches nondeterministic evidence names/order and copying unreferenced images.
    const run = screenshotRun();
    writeFileSync(
      join(run.iosRoot, "traces/test-plans/test_insert_20260810_120000/screenshots/unreferenced.png"),
      "must not copy",
    );
    const args: ReportInputs = {
      authoredArtifact: join(run.root, "author"),
      skillArtifact: join(run.root, "skill"),
      iosArtifact: run.iosRoot,
      outDir: run.outDir,
    };
    run.summary = await normalizeRun(args);

    await copyScreenshotEvidence(run.summary, run.iosRoot, run.outDir);

    const plan = run.summary.ios.test_plans[0] as Record<string, unknown>;
    const steps = plan.steps as Array<Record<string, unknown>>;
    expect(steps.map((step) => step.description)).toEqual([
      "FAILED: Persist the note",
      "PASSED: Insert a note",
    ]);
    expect(steps.map((step) => step.screenshot)).toEqual([
      "evidence/screenshots/test-insert-run-01-step-02.png",
      "evidence/screenshots/test-insert-run-01-step-01.png",
    ]);
    expect(readdirSync(join(run.outDir, "evidence/screenshots")).sort()).toEqual([
      "test-insert-run-01-step-01.png",
      "test-insert-run-01-step-02.png",
    ]);
    expect(readFileSync(join(run.outDir, steps[0]!.screenshot as string), "utf8"))
      .toBe("failed png");
  });

  test("rejects traversal, symlink, hardlink, non-regular, and non-PNG evidence", async () => {
    // Catches report copying becoming an arbitrary-file exfiltration primitive.
    const cases: Array<{
      name: string;
      screenshot: string;
      setup: (planTrace: string, outside: string) => void;
      warning: string;
    }> = [
      {
        name: "traversal",
        screenshot: "../../../../../outside.png",
        setup: (_planTrace, outside) => writeFileSync(outside, "secret"),
        warning: "outside the iOS artifact",
      },
      {
        name: "symlink",
        screenshot: "screenshots/link.png",
        setup: (planTrace, outside) => {
          writeFileSync(outside, "secret");
          symlinkSync(outside, join(planTrace, "screenshots/link.png"));
        },
        warning: "symbolic link",
      },
      {
        name: "hardlink",
        screenshot: "screenshots/hard.png",
        setup: (planTrace, outside) => {
          writeFileSync(outside, "secret");
          linkSync(outside, join(planTrace, "screenshots/hard.png"));
        },
        warning: "multiple hard links",
      },
      {
        name: "non-regular",
        screenshot: "screenshots/directory.png",
        setup: (planTrace) => mkdirSync(join(planTrace, "screenshots/directory.png")),
        warning: "not a regular file",
      },
      {
        name: "non-PNG",
        screenshot: "screenshots/final.jpg",
        setup: (planTrace) => writeFileSync(join(planTrace, "screenshots/final.jpg"), "jpg"),
        warning: "not a PNG",
      },
    ];

    for (const candidate of cases) {
      const run = screenshotRun();
      const outside = join(run.root, `outside-${candidate.name}.png`);
      const planTrace = join(
        run.iosRoot,
        "traces/test-plans/test_insert_20260810_120000",
      );
      candidate.setup(planTrace, outside);
      const args: ReportInputs = {
        authoredArtifact: join(run.root, "author"),
        skillArtifact: join(run.root, "skill"),
        iosArtifact: run.iosRoot,
        outDir: run.outDir,
      };
      const result = readJson(join(run.iosRoot, "result.json"));
      const step = (((result.test_plans as Array<Record<string, unknown>>)[0]?.steps) as Array<Record<string, unknown>>)[0]!;
      step.screenshot = candidate.screenshot;
      const secondStep = (((result.test_plans as Array<Record<string, unknown>>)[0]?.steps) as Array<Record<string, unknown>>)[1]!;
      secondStep.screenshot = null;
      writeJson(join(run.iosRoot, "result.json"), result);
      run.summary = await normalizeRun(args);

      await copyScreenshotEvidence(run.summary, run.iosRoot, run.outDir);

      const normalizedStep = ((run.summary.ios.test_plans[0] as Record<string, unknown>).steps as Array<Record<string, unknown>>)[0]!;
      expect(normalizedStep.screenshot, candidate.name).toBeNull();
      expect(run.summary.warnings.join(" "), candidate.name).toContain(candidate.warning);
      expect(readdirSync(join(run.outDir, "evidence/screenshots")), candidate.name).toEqual([]);
    }
  });

  test("rejects physical escape through a symlinked trace directory", async () => {
    // Catches lexical containment checks that miss parent-directory symlinks.
    const root = tempRoot();
    const args = inputs(root);
    const tracesRoot = join(args.iosArtifact!, "traces/test-plans");
    const outsideTrace = join(root, "outside-trace");
    mkdirSync(join(outsideTrace, "screenshots"), { recursive: true });
    writeJson(join(outsideTrace, "summary.json"), { plan: "test_insert.txt", run_index: 1 });
    writeFileSync(join(outsideTrace, "screenshots/step-01-final.png"), "secret");
    mkdirSync(tracesRoot, { recursive: true });
    symlinkSync(outsideTrace, join(tracesRoot, "test_insert_escape"));
    const result = readJson(join(args.iosArtifact!, "result.json"));
    const step = (((result.test_plans as Array<Record<string, unknown>>)[0]?.steps) as Array<Record<string, unknown>>)[0]!;
    step.screenshot = "screenshots/step-01-final.png";
    writeJson(join(args.iosArtifact!, "result.json"), result);
    const summary = await normalizeRun(args);

    await copyScreenshotEvidence(summary, args.iosArtifact!, args.outDir);

    expect(((summary.ios.test_plans[0] as Record<string, unknown>).steps as Array<Record<string, unknown>>)[0]!.screenshot).toBeNull();
    expect(summary.warnings.join(" ")).toContain("outside the iOS artifact");
    expect(lstatSync(join(tracesRoot, "test_insert_escape")).isSymbolicLink()).toBe(true);
  });
});
