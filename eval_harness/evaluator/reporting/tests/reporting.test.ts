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
  normalizeRunWithEvidence,
  validateConsolidatedSummary,
} from "../normalize.ts";
import { parseArgs } from "../main.ts";
import { renderReport } from "../render.ts";
import type { ConsolidatedSummary, ReportInputs } from "../types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
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

function completeTraceSummary(
  plan: string,
  options: { runIndex?: number; totalUsage?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    plan,
    platform: "ios",
    driver: "agent-device",
    score: 1,
    full_points: 1,
    total_usage: options.totalUsage ?? {},
    steps: [],
    ...(options.runIndex === undefined ? {} : { run_index: options.runIndex }),
  };
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
  test("preserves evaluator job terminal state and gates missing or failed outputs", async () => {
    const failedMissingRoot = tempRoot();
    const failedMissing = inputs(failedMissingRoot, { skill: false, ios: false });
    failedMissing.iosJobStatus = "failure";
    failedMissing.skillJobStatus = "skipped";
    const failedMissingSummary = await normalizeRun(failedMissing);
    expect(failedMissingSummary.status).toBe("failed");
    expect(failedMissingSummary.scores.ios_macro_pct).toBeNull();
    expect(failedMissingSummary.run.jobs).toEqual({ ios: "failure", skill: "skipped" });
    expect(failedMissingSummary.warnings).toContain("iOS evaluator job failed and produced no usable artifact");

    const failedArtifactRoot = tempRoot();
    const failedArtifact = inputs(failedArtifactRoot, { skill: true, ios: true });
    failedArtifact.iosJobStatus = "failure";
    failedArtifact.skillJobStatus = "failure";
    const failedArtifactSummary = await normalizeRun(failedArtifact);
    expect(failedArtifactSummary.status).toBe("failed");
    expect(failedArtifactSummary.scores).toEqual({
      ios_macro_pct: null,
      skill_trigger_recall: null,
      skill_uptake_rate: null,
    });
    expect(failedArtifactSummary.warnings).toContain("iOS evaluator job failed");
    expect(failedArtifactSummary.warnings).toContain("skill evaluator job failed");

    const diagnosticRoot = tempRoot();
    const diagnostic = inputs(diagnosticRoot, { skill: false, ios: true });
    diagnostic.iosJobStatus = "failure";
    diagnostic.skillJobStatus = "skipped";
    writeJson(join(diagnostic.iosArtifact!, "result.json"), {
      status: "failed",
      expected_plan_count: 0,
      terminal_plan_count: 0,
      macro_avg_pct: null,
      evaluator_errors: [{ stage: "preflight", reason: "missing credential" }],
      test_plans: [],
    });
    const diagnosticManifest = readJson(join(diagnostic.iosArtifact!, "manifest.json"));
    (diagnosticManifest.build_health as Record<string, unknown>).evaluation = {
      status: "failed",
      detail: "preflight: missing credential",
      log: null,
    };
    writeJson(join(diagnostic.iosArtifact!, "manifest.json"), diagnosticManifest);
    const diagnosticSummary = await normalizeRun(diagnostic);
    expect(diagnosticSummary.status).toBe("failed");
    expect(diagnosticSummary.scores.ios_macro_pct).toBeNull();
    expect(diagnosticSummary.build_health.at(-1)).toMatchObject({
      status: "failed",
      detail: "preflight: missing credential",
    });

    const successMissingRoot = tempRoot();
    const successMissing = inputs(successMissingRoot, { skill: false, ios: false });
    successMissing.iosJobStatus = "success";
    successMissing.skillJobStatus = "success";
    const successMissingSummary = await normalizeRun(successMissing);
    expect(successMissingSummary.status).toBe("failed");
    expect(successMissingSummary.warnings).toContain("successful iOS evaluator job artifact is unavailable");
    expect(successMissingSummary.warnings).toContain("successful skill evaluator job artifact is unavailable");

    const skippedRoot = tempRoot();
    const skipped = inputs(skippedRoot, { skill: false, ios: false });
    skipped.iosJobStatus = "skipped";
    skipped.skillJobStatus = "skipped";
    const skippedSummary = await normalizeRun(skipped);
    expect(skippedSummary.status).toBe("complete");
    expect(skippedSummary.scores).toEqual({
      ios_macro_pct: null,
      skill_trigger_recall: null,
      skill_uptake_rate: null,
    });
    expect(renderReport(skippedSummary)).toContain("iOS job</dt><dd>Skipped");
    expect(renderReport(skippedSummary)).toContain("Skill job</dt><dd>Skipped");
  });

  test("keeps an early native-build diagnostic on its actual ladder rung", async () => {
    // Catches a failed EAS job replacing exact producer evidence with a generic
    // evaluation-stage failure after the evaluator never ran.
    const root = tempRoot();
    const args = inputs(root, { skill: false, ios: true });
    args.iosJobStatus = "failure";
    args.skillJobStatus = "skipped";
    const reason = "authored app is missing required Expo config (ios.bundleIdentifier and scheme are required)";
    writeJson(join(args.iosArtifact!, "result.json"), {
      status: "failed",
      expected_plan_count: 0,
      terminal_plan_count: 0,
      macro_avg_pct: null,
      evaluator_errors: [{ stage: "native_build", reason }],
      test_plans: [],
    });
    const manifest = readJson(join(args.iosArtifact!, "manifest.json"));
    const health = manifest.build_health as Record<string, unknown>;
    health.native_build = { status: "failed", detail: reason, log: "logs/d-expo-config.err" };
    health.app_launch = { status: "not_run", detail: null, log: null };
    health.evaluation = { status: "not_run", detail: null, log: null };
    writeJson(join(args.iosArtifact!, "manifest.json"), manifest);

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("failed");
    expect(summary.scores.ios_macro_pct).toBeNull();
    expect(summary.build_health.find((stage) => stage.id === "native_build"))
      .toMatchObject({ status: "failed", detail: reason });
    expect(summary.build_health.find((stage) => stage.id === "app_launch"))
      .toMatchObject({ status: "not_run", detail: null });
    expect(summary.build_health.find((stage) => stage.id === "evaluation"))
      .toMatchObject({ status: "not_run", detail: null });
    expect(summary.warnings).toContain(`iOS evaluator failed: native_build: ${reason}`);
    expect(renderReport(summary)).toContain("ios.bundleIdentifier and scheme are required");
  });

  test("rejects authoritative JSON symlinks, hardlinks, and FIFOs", async () => {
    // Catches producer JSON reads retaining arbitrary host or special-file content.
    const symlinkRoot = tempRoot();
    const symlinkArgs = inputs(symlinkRoot);
    const outsideManifest = join(symlinkRoot, "outside-manifest.json");
    cpSync(join(symlinkArgs.authoredArtifact, "manifest.json"), outsideManifest);
    rmSync(join(symlinkArgs.authoredArtifact, "manifest.json"));
    symlinkSync(outsideManifest, join(symlinkArgs.authoredArtifact, "manifest.json"));
    await expect(normalizeRun(symlinkArgs)).rejects.toThrow("unsafe authoritative JSON");

    const hardlinkRoot = tempRoot();
    const hardlinkArgs = inputs(hardlinkRoot);
    const outsideMetrics = join(hardlinkRoot, "outside-metrics.json");
    cpSync(join(hardlinkArgs.skillArtifact!, "metrics.json"), outsideMetrics);
    rmSync(join(hardlinkArgs.skillArtifact!, "metrics.json"));
    linkSync(outsideMetrics, join(hardlinkArgs.skillArtifact!, "metrics.json"));
    await expect(normalizeRun(hardlinkArgs)).rejects.toThrow("unsafe authoritative JSON");

    const fifoRoot = tempRoot();
    const fifoArgs = inputs(fifoRoot);
    const resultPath = join(fifoArgs.iosArtifact!, "result.json");
    const resultBytes = readFileSync(resultPath);
    rmSync(resultPath);
    expect(Bun.spawnSync(["mkfifo", resultPath]).exitCode).toBe(0);
    const writer = Bun.spawn(["sh", "-c", "printf '%s' \"$FIFO_JSON\" > \"$FIFO_PATH\""], {
      env: {
        FIFO_JSON: resultBytes.toString("utf8"),
        FIFO_PATH: resultPath,
        PATH: process.env.PATH ?? "",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    await expect(normalizeRun(fifoArgs)).rejects.toThrow("unsafe authoritative JSON");
    writer.kill();
    await writer.exited;
  });

  test("rejects a symlinked child trace directory instead of reading its usage", async () => {
    // Catches trace enumeration following a child directory outside the iOS artifact.
    const root = tempRoot();
    const args = inputs(root);
    const outsideTrace = join(root, "outside-plan-trace");
    writeJson(join(outsideTrace, "summary.json"), {
      plan: "test_insert.txt",
      total_usage: { input_tokens: 999 },
    });
    const tracesRoot = join(args.iosArtifact!, "traces/test-plans");
    mkdirSync(tracesRoot, { recursive: true });
    symlinkSync(outsideTrace, join(tracesRoot, "escaped-trace"));

    await expect(normalizeRun(args)).rejects.toThrow("unsafe plan trace directory");
  });

  test("rejects linked trace summaries while allowing only physical single-link files", async () => {
    // Catches diagnostic-summary skipping accidentally weakening unsafe-topology rejection.
    for (const kind of ["symlink", "hardlink"] as const) {
      const root = tempRoot();
      const args = inputs(root);
      const trace = join(args.iosArtifact!, "traces/test-plans/test_insert_diagnostic");
      const outside = join(root, `${kind}-summary.json`);
      mkdirSync(trace, { recursive: true });
      writeJson(outside, completeTraceSummary("test_insert.txt"));
      if (kind === "symlink") {
        symlinkSync(outside, join(trace, "summary.json"));
      } else {
        linkSync(outside, join(trace, "summary.json"));
      }

      await expect(normalizeRun(args)).rejects.toThrow("unsafe authoritative JSON");
    }
  });

  test("rejects a special child trace node instead of ignoring it", async () => {
    // Catches a FIFO/device in the trace-directory set being mistaken for an absent diagnostic.
    const root = tempRoot();
    const args = inputs(root);
    const traces = join(args.iosArtifact!, "traces/test-plans");
    mkdirSync(traces, { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(traces, "diagnostic-fifo")]).exitCode).toBe(0);

    await expect(normalizeRun(args)).rejects.toThrow("unsafe plan trace directory");
  });

  test("rejects an unsafe author trace instead of silently dropping usage", async () => {
    // Catches an existing manifest-referenced author trace link being treated as absent.
    const root = tempRoot();
    const args = inputs(root);
    const trace = join(
      args.authoredArtifact,
      "author-agent-metadata/run-fixture-1/telemetry/traces/muse-code-authoring.json",
    );
    const outside = join(root, "outside-author-trace.json");
    writeJson(outside, {
      sessions: [{ turns: [{ total_usage: { prompt_tokens: 999 } }] }],
    });
    mkdirSync(dirname(trace), { recursive: true });
    symlinkSync(outside, trace);

    await expect(normalizeRun(args)).rejects.toThrow("unsafe author trace");
  });

  test("rejects a symlink output root and any overlap with an input artifact", async () => {
    // Catches report writes following an output alias or overwriting producer input.
    const symlinkRoot = tempRoot();
    const symlinkArgs = inputs(symlinkRoot);
    const outside = join(symlinkRoot, "outside-output");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "keep");
    symlinkSync(outside, symlinkArgs.outDir);
    await expect(normalizeRun(symlinkArgs)).rejects.toThrow("output");
    expect(readdirSync(outside)).toEqual(["sentinel"]);

    const overlapRoot = tempRoot();
    const overlapArgs = inputs(overlapRoot);
    overlapArgs.outDir = join(overlapArgs.authoredArtifact, "eval-report");
    await expect(normalizeRun(overlapArgs)).rejects.toThrow("overlap");
    expect(existsSync(overlapArgs.outDir)).toBe(false);
  });

  test("leaves an existing report untouched when generation fails", async () => {
    // Catches direct writes mutating the prior report before all input validation succeeds.
    const root = tempRoot();
    const args = inputs(root);
    mkdirSync(args.outDir);
    writeFileSync(join(args.outDir, "sentinel.txt"), "prior report");
    const outsideManifest = join(root, "outside-manifest.json");
    cpSync(join(args.authoredArtifact, "manifest.json"), outsideManifest);
    rmSync(join(args.authoredArtifact, "manifest.json"));
    symlinkSync(outsideManifest, join(args.authoredArtifact, "manifest.json"));

    await expect(normalizeRun(args)).rejects.toThrow("unsafe authoritative JSON");

    expect(readdirSync(args.outDir)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(args.outDir, "sentinel.txt"), "utf8")).toBe("prior report");
  });

  test("full to author-only rerun publishes only the new exact inventory", async () => {
    // Catches stale optional JSON, screenshots, HTML, and arbitrary prior files surviving reruns.
    const root = tempRoot();
    const fullArgs = inputs(root);
    await normalizeRun(fullArgs);
    writeFileSync(join(fullArgs.outDir, "report.html"), "stale HTML");
    writeFileSync(join(fullArgs.outDir, "stale.log"), "stale log");
    writeFileSync(join(fullArgs.outDir, "evidence/screenshots/stale.png"), "stale image");

    const authorOnlyArgs: ReportInputs = {
      authoredArtifact: fullArgs.authoredArtifact,
      skillArtifact: null,
      iosArtifact: null,
      outDir: fullArgs.outDir,
    };
    await normalizeRun(authorOnlyArgs);

    expect(readdirSync(fullArgs.outDir).sort()).toEqual([
      "data", "evidence", "manifest.json", "summary.json",
    ]);
    expect(readdirSync(join(fullArgs.outDir, "data")).sort()).toEqual([
      "author-manifest.json", "build-health.json",
    ]);
    expect(readdirSync(join(fullArgs.outDir, "evidence/screenshots"))).toEqual([]);
  });

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
    const normalizedPlan = summary.ios.test_plans[0] as Record<string, unknown>;
    const normalizedStep = (normalizedPlan.steps as Array<Record<string, unknown>>)[0]!;
    expect(normalizedStep).toEqual(expect.objectContaining({
      description: "PASSED: Insert a note",
      iterations: 3,
      hard_assertion_count: 1,
      soft_assertion_count: 1,
    }));
    expect(normalizedStep.hard_assertions).toEqual([
      { command: "assertVisible: note-row", fatal: false, passed: true },
    ]);
    expect(summary.build_health.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "app_authored", status: "passed" },
      { id: "dependency_install", status: "passed" },
      { id: "syntax", status: "passed" },
      { id: "expo_export", status: "warning" },
      { id: "native_build", status: "passed" },
      { id: "app_launch", status: "passed" },
      { id: "evaluation", status: "warning" },
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

  test("marks partial behavioral credit warning while keeping the run terminal", async () => {
    // Catches a non-perfect behavioral score rendering as a green evaluation rung.
    const root = tempRoot();
    const args = inputs(root);

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("complete");
    expect(summary.scores.ios_macro_pct).toBe(82.5);
    expect(summary.build_health[6]).toEqual({
      id: "evaluation",
      label: "iOS evaluation completion",
      status: "warning",
      detail: "iOS behavior completed with partial credit (82.5%)",
      log: "logs/s7-eval.log",
    });
  });

  test("keeps an all-N/A completed suite terminal without a false behavioral failure", async () => {
    // Catches the producer's aggregate zero for no scored plans becoming partial/failure.
    const root = tempRoot();
    const args = inputs(root);
    writeJson(join(args.iosArtifact!, "result.json"), {
      status: "completed",
      expected_plan_count: 1,
      terminal_plan_count: 1,
      macro_avg_pct: 0,
      evaluator_errors: [],
      test_plans: [{
        test_plan: "test_insert.txt",
        run_index: 1,
        status: "not_applicable",
        na_reason: "feature is outside this PRD",
        score: 0,
        full_points: 0,
        macro_pct: null,
        steps: [],
      }],
    });

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("complete");
    expect(summary.scores.ios_macro_pct).toBeNull();
    expect(summary.build_health[6]?.status).toBe("passed");
  });

  test("reports an all-N/A result when its safe diagnostic trace has no summary", async () => {
    // Catches a normal seed N/A early return making the consolidated report fail.
    const root = tempRoot();
    const args = inputs(root);
    mkdirSync(
      join(args.iosArtifact!, "traces/test-plans/test_insert_20260810_120000"),
      { recursive: true },
    );
    writeJson(join(args.iosArtifact!, "result.json"), {
      status: "completed",
      expected_plan_count: 1,
      terminal_plan_count: 1,
      macro_avg_pct: 0,
      evaluator_errors: [],
      test_plans: [{
        test_plan: "test_insert.txt",
        run_index: 1,
        status: "not_applicable",
        na_reason: "feature is outside this PRD",
        score: 0,
        full_points: 0,
        macro_pct: null,
        steps: [],
      }],
    });

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("complete");
    expect(summary.build_health[6]?.status).toBe("passed");
    expect(summary.scores.ios_macro_pct).toBeNull();
    expect(summary.usage.evaluator).toEqual({});
  });

  test("reports evaluator restart failure when its safe diagnostic trace has no summary", async () => {
    // Catches a restart failure's retained trace hiding its authoritative evaluator detail.
    const root = tempRoot();
    const args = inputs(root);
    mkdirSync(
      join(args.iosArtifact!, "traces/test-plans/test_insert_20260810_120000"),
      { recursive: true },
    );
    writeJson(join(args.iosArtifact!, "result.json"), {
      status: "failed",
      expected_plan_count: 1,
      terminal_plan_count: 1,
      macro_avg_pct: null,
      evaluator_errors: [{ stage: "restart", reason: "development client never launched" }],
      test_plans: [{
        test_plan: "test_insert.txt",
        run_index: 1,
        status: "evaluator_error",
        error_stage: "restart",
        error_reason: "development client never launched",
        score: null,
        full_points: null,
        macro_pct: null,
        steps: [],
      }],
    });

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("failed");
    expect(summary.build_health[6]?.detail).toBe(
      "restart: development client never launched",
    );
    expect(summary.scores.ios_macro_pct).toBeNull();
  });

  test("skips safe malformed and incomplete diagnostic trace summaries", async () => {
    // Catches safe crash leftovers being treated as authoritative usage or ownership records.
    const root = tempRoot();
    const args = inputs(root);
    const traces = join(args.iosArtifact!, "traces/test-plans");
    mkdirSync(join(traces, "malformed"), { recursive: true });
    writeFileSync(join(traces, "malformed/summary.json"), "{not-json\n");
    writeJson(join(traces, "incomplete/summary.json"), { plan: "test_insert.txt" });

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("complete");
    expect(summary.usage.evaluator).toEqual({});
  });

  test("withholds the iOS score when an earlier infrastructure gate failed", async () => {
    // Catches a valid-looking result surviving a failed install/build/launch prerequisite.
    const root = tempRoot();
    const args = inputs(root);
    const manifest = readJson(join(args.iosArtifact!, "manifest.json"));
    const health = manifest.build_health as Record<string, Record<string, unknown>>;
    health.native_build!.status = "failed";
    writeJson(join(args.iosArtifact!, "manifest.json"), manifest);

    const summary = await normalizeRun(args);

    expect(summary.status).toBe("failed");
    expect(summary.scores.ios_macro_pct).toBeNull();
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

  test("degrades structurally incomplete producer JSON by artifact criticality", async () => {
    // Catches valid JSON objects bypassing required v2 producer-field validation.
    const optionalRoot = tempRoot();
    const optionalArgs = inputs(optionalRoot);
    const metrics = readJson(join(optionalArgs.skillArtifact!, "metrics.json"));
    delete metrics.score;
    writeJson(join(optionalArgs.skillArtifact!, "metrics.json"), metrics);
    const iosResult = readJson(join(optionalArgs.iosArtifact!, "result.json"));
    delete iosResult.test_plans;
    writeJson(join(optionalArgs.iosArtifact!, "result.json"), iosResult);

    const optionalSummary = await normalizeRun(optionalArgs);

    expect(optionalSummary.status).toBe("partial");
    expect(optionalSummary.scores).toEqual({
      ios_macro_pct: null,
      skill_trigger_recall: null,
      skill_uptake_rate: null,
    });
    expect(optionalSummary.warnings.join(" ")).toContain("required fields");

    const authorRoot = tempRoot();
    const authorArgs = inputs(authorRoot, { skill: false, ios: false });
    const author = readJson(join(authorArgs.authoredArtifact, "manifest.json"));
    delete author.run_id;
    writeJson(join(authorArgs.authoredArtifact, "manifest.json"), author);

    const authorSummary = await normalizeRun(authorArgs);

    expect(authorSummary.status).toBe("failed");
    expect(authorSummary.warnings.join(" ")).toContain("required fields");
  });

  test("withholds iOS scoring and detail for malformed nested step or assertion records", async () => {
    // Catches incomplete nested producer data being rendered as a successful behavioral result.
    const mutations: Array<(step: Record<string, unknown>) => void> = [
      (step) => { delete step.iterations; },
      (step) => {
        const assertion = (step.hard_assertions as Array<Record<string, unknown>>)[0]!;
        delete assertion.passed;
      },
      (step) => {
        const assertion = (step.soft_assertions as Array<Record<string, unknown>>)[0]!;
        assertion.evidence = { forged: true };
      },
      (step) => { step.screenshot = 42; },
    ];

    for (const mutate of mutations) {
      const root = tempRoot();
      const args = inputs(root);
      const result = readJson(join(args.iosArtifact!, "result.json"));
      const plan = (result.test_plans as Array<Record<string, unknown>>)[0]!;
      const step = (plan.steps as Array<Record<string, unknown>>)[0]!;
      mutate(step);
      writeJson(join(args.iosArtifact!, "result.json"), result);

      const summary = await normalizeRun(args);

      expect(summary.status).toBe("partial");
      expect(summary.scores.ios_macro_pct).toBeNull();
      expect(summary.ios.test_plans).toEqual([]);
      expect(summary.build_health[6]?.status).toBe("warning");
      expect(summary.warnings.join(" ")).toContain("required fields");
    }
  });

  test("requires canonical fields in optional v2 producer manifests", async () => {
    // Catches schema/type-only manifest validation accepting unusable artifact indexes.
    const skillRoot = tempRoot();
    const skillArgs = inputs(skillRoot, { ios: false });
    const skillManifest = readJson(join(skillArgs.skillArtifact!, "manifest.json"));
    delete skillManifest.artifacts;
    writeJson(join(skillArgs.skillArtifact!, "manifest.json"), skillManifest);

    const skillSummary = await normalizeRun(skillArgs);

    expect(skillSummary.status).toBe("partial");
    expect(skillSummary.warnings.join(" ")).toContain("required fields");

    const iosRoot = tempRoot();
    const iosArgs = inputs(iosRoot, { skill: false });
    const iosManifest = readJson(join(iosArgs.iosArtifact!, "manifest.json"));
    delete iosManifest.build_health;
    writeJson(join(iosArgs.iosArtifact!, "manifest.json"), iosManifest);

    const iosSummary = await normalizeRun(iosArgs);

    expect(iosSummary.status).toBe("partial");
    expect(iosSummary.warnings.join(" ")).toContain("required fields");
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
          session_meta: { cli_version: "0.1.0-R708.1" },
          turns: [
            {
              total_usage: { prompt_tokens: 4, completion_tokens: 2 },
              steps: [{ tool_calls: [
                { name: "bash", args: { command: "bun install" } },
                { name: "Skill", args: { skill: "expo-router" } },
              ] }],
            },
            {
              total_usage: { prompt_tokens: 3, completion_tokens: 1, ignored: "7" },
              steps: [{ tool_calls: [
                { name: "Skill", args: { skill: "expo-router" } },
                { name: "Skill", args: { skill: "bundled:read-session" } },
              ] }],
            },
          ],
        }],
      },
    );
    writeJson(
      join(args.iosArtifact!, "traces/test-plans/test_insert_1/summary.json"),
      completeTraceSummary("test_insert.txt", { totalUsage: {
        input_tokens: 10,
        output_tokens: 5,
        total_cost_usd: 0.25,
      } }),
    );
    writeJson(
      join(args.iosArtifact!, "traces/test-plans/test_insert_2/summary.json"),
      completeTraceSummary("test_insert.txt", { totalUsage: {
        input_tokens: 2,
        output_tokens: 1,
        total_cost_usd: null,
      } }),
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
    expect(summary.run.author).toEqual({
      agent: "muse-code",
      model: "muse-spark-1.2",
      effort: "high",
      cli_version: "0.1.0-R708.1",
      tool_calls: 4,
      skill_reads: ["expo-router"],
    });
  });

  test("extracts provider-aware author skill reads with shared trigger semantics", async () => {
    // Catches Claude-only Skill parsing dropping Codex path reads or corrupting Muse exact IDs.
    const cases = [
      {
        agent: "claude-code",
        calls: [
          { name: "Skill", args: { skill: "expo:expo-router" } },
          { name: "Skill", args: { skill: "expo:expo-router" } },
        ],
        expected: ["expo-router"],
      },
      {
        agent: "codex",
        calls: [{
          name: "exec_command",
          args: {
            cmd: "sed -n '1,80p' .agents/skills/expo-ui/SKILL.md && rg title .agents/skills/expo-ui/SKILL.md",
          },
        }],
        expected: ["expo-ui"],
      },
      {
        agent: "muse-code",
        calls: [
          { name: "Skill", args: { skill: "expo:expo-router" } },
          { name: "Skill", args: { skill: "expo:expo-router" } },
          { name: "Skill", args: { skill: "bundled:read-session" } },
        ],
        expected: ["expo:expo-router"],
      },
    ];

    for (const provider of cases) {
      const root = tempRoot();
      const args = inputs(root, { skill: false, ios: false });
      const manifest = readJson(join(args.authoredArtifact, "manifest.json"));
      manifest.agent = provider.agent;
      writeJson(join(args.authoredArtifact, "manifest.json"), manifest);
      writeJson(
        join(
          args.authoredArtifact,
          "author-agent-metadata/run-fixture-1/telemetry/traces/muse-code-authoring.json",
        ),
        {
          agent: provider.agent,
          sessions: [{ turns: [{ total_usage: {}, steps: [{ tool_calls: provider.calls }] }] }],
        },
      );

      const summary = await normalizeRun(args);
      expect((summary.run.author as Record<string, unknown>).skill_reads)
        .toEqual(provider.expected);
    }
  });

  test("rejects producer artifact path traversal before reading usage", async () => {
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

    await expect(normalizeRun(args)).rejects.toThrow("unsafe author trace");
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
  test("runtime validation rejects an invalid consolidated summary", () => {
    // Catches TypeScript-only schema assurances disappearing at the JSON publish boundary.
    expect(() => validateConsolidatedSummary({
      schema_version: 1,
      status: "complete",
      run: {},
      scores: {
        ios_macro_pct: Number.NaN,
        skill_trigger_recall: null,
        skill_uptake_rate: null,
      },
      build_health: [],
      skills: [],
      ios: { test_plans: [] },
      usage: { author: {}, evaluator: {} },
      warnings: [],
      artifacts: {},
    })).toThrow("invalid consolidated summary");
  });

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

  test("parses and validates optional EAS evaluator job statuses", () => {
    expect(parseArgs([
      "--authored-artifact", "/author",
      "--out-dir", "/out",
      "--ios-job-status", "failure",
      "--skill-job-status", "skipped",
    ])).toEqual({
      authoredArtifact: "/author",
      skillArtifact: null,
      iosArtifact: null,
      outDir: "/out",
      iosJobStatus: "failure",
      skillJobStatus: "skipped",
    });
    expect(parseArgs([
      "--authored-artifact", "/author",
      "--out-dir", "/out",
      "--ios-job-status", "cancelled",
    ])).toBe(2);
  });

  test("writes the exact complete artifact through the real Bun entrypoint", () => {
    // Catches the CLI omitting the human report or leaking stale/non-contract files.
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
    expect(readdirSync(args.outDir).sort()).toEqual([
      "data", "evidence", "manifest.json", "report.html", "summary.json",
    ]);
    expect(readFileSync(join(args.outDir, "report.html"), "utf8"))
      .toContain("Build and evaluation ladder");
  });

  test("atomically replaces stale report files and includes report.html", async () => {
    // Catches report rendering happening after publication or stale files surviving a rerun.
    const root = tempRoot();
    const args = inputs(root);
    await normalizeRunWithEvidence(args);
    writeFileSync(join(args.outDir, "stale.log"), "stale");
    writeFileSync(join(args.outDir, "report.html"), "stale report");

    await normalizeRunWithEvidence(args);

    expect(readdirSync(args.outDir).sort()).toEqual([
      "data", "evidence", "manifest.json", "report.html", "summary.json",
    ]);
    expect(readFileSync(join(args.outDir, "report.html"), "utf8"))
      .not.toContain("stale report");
  });

  test("preserves the prior report when rendering fails inside publication", async () => {
    // Catches a render failure replacing a complete prior artifact with a partial directory.
    const root = tempRoot();
    const args = inputs(root);
    await normalizeRunWithEvidence(args);
    const priorReport = readFileSync(join(args.outDir, "report.html"), "utf8");
    const priorSummary = readFileSync(join(args.outDir, "summary.json"), "utf8");

    await expect(normalizeRunWithEvidence(args, () => {
      throw new Error("synthetic render failure");
    })).rejects.toThrow("synthetic render failure");

    expect(readFileSync(join(args.outDir, "report.html"), "utf8")).toBe(priorReport);
    expect(readFileSync(join(args.outDir, "summary.json"), "utf8")).toBe(priorSummary);
  });
});

describe("renderReport", () => {
  async function fixtureSummary(): Promise<ConsolidatedSummary> {
    const root = tempRoot();
    const args = inputs(root);
    const summary = await normalizeRun(args);
    const plan = summary.ios.test_plans[0] as Record<string, unknown>;
    const steps = plan.steps as Array<Record<string, unknown>>;
    steps[0]!.screenshot = "evidence/screenshots/test-insert-run-01-step-01.png";
    steps[1]!.screenshot = "evidence/screenshots/test-insert-run-01-step-02.png";
    const author = (summary.run.author as Record<string, unknown>);
    author.cli_version = "Muse Code 0.1.0";
    author.tool_calls = 14;
    author.skill_reads = ["expo-router", "expo-native-ui"];
    return summary;
  }

  function telemetryCard(html: string, heading: string): string {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(
      new RegExp(`<article class="telemetry-card"><h3>${escaped}</h3>([\\s\\S]*?)</article>`),
    );
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  }

  function elementContaining(html: string, tag: "article" | "li", marker: string): string {
    const markerIndex = html.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const start = html.lastIndexOf(`<${tag}`, markerIndex);
    const end = html.indexOf(`</${tag}>`, markerIndex);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(markerIndex);
    return html.slice(start, end + tag.length + 3);
  }

  test("renders the approved postmortem hierarchy and explicit status text", async () => {
    // Catches a generic dashboard replacing the ordered dossier and status-readable run spine.
    const summary = await fixtureSummary();
    summary.build_health[0]!.status = "failed";
    summary.build_health[1]!.status = "warning";
    summary.build_health[2]!.status = "passed";
    summary.build_health[4]!.status = "not_run";

    const html = renderReport(summary);
    const headings: Array<[string, string]> = [
      ["Build and evaluation ladder", '<h2 id="ladder-title">Build and evaluation ladder</h2>'],
      ["Skill use", '<h2 id="results-title">Skill use</h2>'],
      ["iOS behavior", "<h3>iOS behavior</h3>"],
      ["Visual evidence", '<h2 id="evidence-title">Visual evidence</h2>'],
      ["Evaluation details", '<h2 id="details-title">Evaluation details</h2>'],
      ["Run telemetry and provenance", '<h2 id="telemetry-title">Run telemetry and provenance</h2>'],
    ];
    for (const [, token] of headings) expect(html).toContain(token);
    for (let index = 1; index < headings.length; index += 1) {
      expect(html.indexOf(headings[index - 1]![1])).toBeLessThan(html.indexOf(headings[index]![1]));
    }
    expect(html).toContain("Failed");
    expect(html).toContain("Warning");
    expect(html).toContain("Passed");
    expect(html).toContain("Not run");
    expect(html).toContain("iOS quality");
    expect(html).toContain("Skill recall");
    expect(html).toContain("Skill uptake");
    expect(html).toContain("Run status");
  });

  test("places failed final-state evidence before passing evidence", async () => {
    // Catches successful previews obscuring the failure evidence collaborators need first.
    const html = renderReport(await fixtureSummary());

    expect(html.indexOf("FAILED: Persist the note"))
      .toBeLessThan(html.indexOf("PASSED: Insert a note"));
    expect(html.indexOf("Failed final state"))
      .toBeLessThan(html.indexOf("Passed final state"));
  });

  test("keeps run completion semantics independent from partial quality scores", async () => {
    // Catches a terminal run being mislabeled Passed despite partial behavioral/skill scores.
    const summary = await fixtureSummary();
    summary.status = "complete";
    summary.scores.ios_macro_pct = 82.5;
    summary.scores.skill_trigger_recall = 0.5;
    summary.scores.skill_uptake_rate = 0.75;

    const complete = renderReport(summary);
    summary.status = "partial";
    const partial = renderReport(summary);
    summary.status = "failed";
    const failed = renderReport(summary);

    const completeCard = elementContaining(complete, "article", "Run status");
    const partialCard = elementContaining(partial, "article", "Run status");
    const failedCard = elementContaining(failed, "article", "Run status");
    expect(completeCard).toContain("score-card score-passed");
    expect(completeCard).toContain("> Complete</span>");
    expect(completeCard).toContain('<p class="score-value">Complete</p>');
    expect(completeCard).not.toContain("Passed");
    expect(partialCard).toContain("score-card score-warning");
    expect(partialCard).toContain("> Partial</span>");
    expect(partialCard).toContain('<p class="score-value">Partial</p>');
    expect(failedCard).toContain("score-card score-failed");
    expect(failedCard).toContain("> Failed</span>");
    expect(failedCard).toContain('<p class="score-value">Failed</p>');
  });

  test("renders all producer check states without passing unscored checks", async () => {
    // Catches passed:null checks falling through to a green Passed badge.
    const summary = await fixtureSummary();
    const skill = summary.skills[0] as Record<string, unknown>;
    skill.checks = [
      { id: "check-passed", status: "passed", passed: true },
      { id: "check-failed", status: "failed", passed: false },
      { id: "check-not-applicable", status: "not_applicable", passed: null },
      { id: "check-unavailable", status: "unavailable", passed: null },
    ];

    const html = renderReport(summary);

    const passed = elementContaining(html, "li", "<strong>check-passed</strong>");
    const failed = elementContaining(html, "li", "<strong>check-failed</strong>");
    const notApplicable = elementContaining(
      html,
      "li",
      "<strong>check-not-applicable</strong>",
    );
    const unavailable = elementContaining(html, "li", "<strong>check-unavailable</strong>");
    expect(passed).toContain("status-passed");
    expect(passed).toContain("Passed");
    expect(failed).toContain("status-failed");
    expect(failed).toContain("Failed");
    expect(notApplicable).toContain("status-not_run");
    expect(notApplicable).toContain("Not run");
    expect(notApplicable).not.toContain("status-passed");
    expect(unavailable).toContain("status-warning");
    expect(unavailable).toContain("Warning");
    expect(unavailable).not.toContain("status-passed");
  });

  test("distinguishes an observed empty skill-read set from a missing trace", async () => {
    // Catches a valid zero-read trace being rendered as missing telemetry.
    const observedRoot = tempRoot();
    const observedArgs = inputs(observedRoot, { skill: false, ios: false });
    writeJson(
      join(
        observedArgs.authoredArtifact,
        "author-agent-metadata/run-fixture-1/telemetry/traces/muse-code-authoring.json",
      ),
      {
        sessions: [{
          session_meta: { cli_version: "0.1.0" },
          turns: [{
            total_usage: { prompt_tokens: 1 },
            steps: [{ tool_calls: [{ name: "bash", args: { command: "pwd" } }] }],
          }],
        }],
      },
    );
    const observed = await normalizeRun(observedArgs);
    const observedAuthor = observed.run.author as Record<string, unknown>;

    const missingRoot = tempRoot();
    const missingArgs = inputs(missingRoot, { skill: false, ios: false });
    const missing = await normalizeRun(missingArgs);
    const missingAuthor = missing.run.author as Record<string, unknown>;

    const malformedRoot = tempRoot();
    const malformedArgs = inputs(malformedRoot, { skill: false, ios: false });
    const malformedTrace = join(
      malformedArgs.authoredArtifact,
      "author-agent-metadata/run-fixture-1/telemetry/traces/muse-code-authoring.json",
    );
    mkdirSync(dirname(malformedTrace), { recursive: true });
    writeFileSync(
      malformedTrace,
      "{not-json\n",
    );
    const malformed = await normalizeRun(malformedArgs);
    const malformedAuthor = malformed.run.author as Record<string, unknown>;

    expect(observedAuthor.skill_reads).toEqual([]);
    expect(telemetryCard(renderReport(observed), "Skill reads")).toContain("<dd>None</dd>");
    expect("skill_reads" in missingAuthor).toBe(false);
    expect(telemetryCard(renderReport(missing), "Skill reads"))
      .toContain("<dd>Not recorded</dd>");
    expect("skill_reads" in malformedAuthor).toBe(false);
    expect(telemetryCard(renderReport(malformed), "Skill reads"))
      .toContain("<dd>Not recorded</dd>");
  });

  test("escapes adversarial data and emits no executable or remote content", async () => {
    // Catches producer-controlled values breaking out of text or attribute contexts.
    const summary = await fixtureSummary();
    summary.run.prd = '<img src=x onerror=alert(1)>';
    summary.run.git_sha = '</style><script>alert("x")</script>';
    summary.warnings.push('<img src=x onerror=alert(1)>');
    const plan = summary.ios.test_plans[0] as Record<string, unknown>;
    const steps = plan.steps as Array<Record<string, unknown>>;
    steps[0]!.description = 'Passed "quoted" <svg/onload=alert(1)>';
    steps[0]!.screenshot = 'evidence/screenshots/final" onerror="alert(1).png';

    const html = renderReport(summary);

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;/style&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("&quot; onerror=&quot;");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  test("uses only relative screenshot URLs and explains their evidentiary limit", async () => {
    // Catches evidence links depending on a server or being presented as model-visible proof.
    const html = renderReport(await fixtureSummary());
    const sources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)]
      .map((match) => match[1]);

    expect(sources).toEqual([
      "evidence/screenshots/test-insert-run-01-step-02.png",
      "evidence/screenshots/test-insert-run-01-step-01.png",
    ]);
    expect(sources.every((source) =>
      source !== undefined && !source.startsWith("/") && !source.includes("://")
    )).toBe(true);
    expect(html).toContain("human final-state context");
    expect(html).toContain("accessibility and structured state");
    expect(html).toContain("cannot inspect captured image pixels today");
  });

  test("renders expandable detail and available telemetry without scripts", async () => {
    // Catches drill-down and provenance being dropped from the collaborator-facing report.
    const html = renderReport(await fixtureSummary());

    expect(html).toContain("<details");
    expect(html).toContain("Tool calls");
    expect(html).toContain("14");
    expect(html).toContain("Skill reads");
    expect(html).toContain("expo-router");
    expect(html).toContain("Versions");
    expect(html).toContain("Muse Code 0.1.0");
    expect(html).toContain("Machine data paths");
    expect(html.match(/Scored steps/g) ?? []).toHaveLength(1);
    expect(html.toLowerCase()).not.toContain("<script");
  });

  test("uses a normal-text accessible warning token", async () => {
    // #8A5A0A has a contrast ratio above 4.5:1 against the white report surface.
    expect(renderReport(await fixtureSummary())).toContain("--warn: #8A5A0A;");
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
    writeJson(
      join(planTrace, "summary.json"),
      completeTraceSummary("test_insert.txt", { runIndex: 1 }),
    );
    mkdirSync(join(planTrace, "screenshots"), { recursive: true });
    const result = readJson(join(args.iosArtifact!, "result.json"));
    const steps = ((result.test_plans as Array<Record<string, unknown>>)[0]?.steps) as Array<Record<string, unknown>>;
    steps[0]!.screenshot = "screenshots/step-01-final.png";
    steps[1]!.screenshot = "screenshots/step-02-final.png";
    writeFileSync(join(planTrace, "screenshots/step-01-final.png"), PNG_BYTES);
    writeFileSync(join(planTrace, "screenshots/step-02-final.png"), PNG_BYTES);
    writeJson(join(args.iosArtifact!, "result.json"), result);
    return {
      root,
      iosRoot: args.iosArtifact!,
      outDir: args.outDir,
      summary: undefined as unknown as ConsolidatedSummary,
    };
  }

  test("preserves formal step order while linking failed-first evidence to stable step anchors", async () => {
    // Catches presentation sorting mutating the authoritative producer step sequence or identity.
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
      "PASSED: Insert a note",
      "FAILED: Persist the note",
    ]);
    expect(steps.map((step) => step.screenshot)).toEqual([
      "evidence/screenshots/test-insert-run-01-step-01.png",
      "evidence/screenshots/test-insert-run-01-step-02.png",
    ]);
    const persisted = readJson(join(run.outDir, "summary.json"));
    const persistedPlan = (persisted.ios as Record<string, unknown>)
      .test_plans as Array<Record<string, unknown>>;
    expect((persistedPlan[0]!.steps as Array<Record<string, unknown>>)
      .map((step) => step.description)).toEqual([
        "PASSED: Insert a note",
        "FAILED: Persist the note",
      ]);
    expect(readdirSync(join(run.outDir, "evidence/screenshots")).sort()).toEqual([
      "test-insert-run-01-step-01.png",
      "test-insert-run-01-step-02.png",
    ]);
    expect(readFileSync(join(run.outDir, steps[1]!.screenshot as string)))
      .toEqual(PNG_BYTES);

    const html = renderReport(run.summary);
    const failedMarker = html.indexOf('<figure class="evidence-card evidence-failed">');
    const failedCard = html.slice(
      html.lastIndexOf("<figure", failedMarker),
      html.indexOf("</figure>", failedMarker) + "</figure>".length,
    );
    expect(failedCard).toContain('href="#ios-plan-01-run-01-step-02"');
    expect(failedCard).toContain("View step 02 details");
    expect(html).toContain('id="ios-plan-01-run-01-step-01"');
    expect(html).toContain('id="ios-plan-01-run-01-step-02"');
    expect(html.indexOf('id="ios-plan-01-run-01-step-01"'))
      .toBeLessThan(html.indexOf('id="ios-plan-01-run-01-step-02"'));
    expect(html.indexOf("Failed final state"))
      .toBeLessThan(html.indexOf("Passed final state"));
  });

  test("copies and renders an evaluator-aborted screenshot without fabricating a scored step", async () => {
    // Catches formal-abort evidence remaining stranded in the producer trace.
    const root = tempRoot();
    const args = inputs(root);
    const trace = join(args.iosArtifact!, "traces/test-plans/test_insert_aborted");
    mkdirSync(join(trace, "screenshots"), { recursive: true });
    writeFileSync(join(trace, "screenshots/step-01-final.png"), PNG_BYTES);
    writeJson(join(trace, "summary.json"), {
      plan: "test_insert.txt",
      run_index: 1,
      platform: "ios",
      driver: "agent-device",
      status: "evaluator_error",
      error_stage: "step_1",
      error_reason: "driver_error: agent aborted",
      score: null,
      full_points: null,
      total_usage: {},
      steps: [],
      terminal_evidence: [{
        step_number: 1,
        step_name: "Insert a note",
        screenshot: "screenshots/step-01-final.png",
        screenshot_error: null,
      }],
    });
    writeJson(join(args.iosArtifact!, "result.json"), {
      status: "failed",
      expected_plan_count: 1,
      terminal_plan_count: 1,
      macro_avg_pct: null,
      evaluator_errors: [{ stage: "formal", reason: "agent aborted" }],
      test_plans: [{
        test_plan: "test_insert.txt",
        run_index: 1,
        status: "evaluator_error",
        error_stage: "formal",
        error_reason: "agent aborted",
        score: null,
        full_points: null,
        macro_pct: null,
        steps: [],
        terminal_evidence: [{
          step_number: 1,
          step_name: "Insert a note",
          screenshot: "screenshots/step-01-final.png",
          screenshot_error: null,
        }],
      }],
    });

    const summary = await normalizeRunWithEvidence(args);

    expect(summary.status).toBe("failed");
    const plan = summary.ios.test_plans[0] as Record<string, unknown>;
    expect(plan.steps).toEqual([]);
    expect(plan.score).toBeNull();
    const terminalEvidence = plan.terminal_evidence as Array<Record<string, unknown>>;
    expect(terminalEvidence).toEqual([
      {
        step_number: 1,
        step_name: "Insert a note",
        screenshot: "evidence/screenshots/test-insert-run-01-step-01.png",
        screenshot_error: null,
      },
    ]);
    expect(readdirSync(join(args.outDir, "evidence/screenshots"))).toEqual([
      "test-insert-run-01-step-01.png",
    ]);
    expect(readFileSync(
      join(args.outDir, terminalEvidence[0]!.screenshot as string),
    )).toEqual(PNG_BYTES);

    const html = renderReport(summary);
    expect(html).toContain("Evaluator-aborted final state");
    expect(html).toContain("Insert a note");
    expect(html).toContain(
      'src="evidence/screenshots/test-insert-run-01-step-01.png"',
    );
    expect(html).toContain('href="#ios-plan-01-run-01"');
    expect(html).toContain('id="ios-plan-01-run-01"');
  });

  test("renders an aborted-step screenshot error as a plan diagnostic", async () => {
    // Catches a best-effort capture failure being silently discarded.
    const root = tempRoot();
    const args = inputs(root);
    const result = readJson(join(args.iosArtifact!, "result.json"));
    const plan = (result.test_plans as Array<Record<string, unknown>>)[0]!;
    plan.status = "evaluator_error";
    plan.error_stage = "step_1";
    plan.error_reason = "driver_error: screen unavailable";
    plan.score = null;
    plan.full_points = null;
    plan.macro_pct = null;
    plan.steps = [];
    plan.terminal_evidence = [{
      step_number: 1,
      step_name: "Insert a note",
      screenshot: null,
      screenshot_error: "simctl screenshot failed",
    }];
    result.status = "failed";
    result.macro_avg_pct = null;
    result.evaluator_errors = [{
      test_plan: "test_insert.txt",
      run_index: 1,
      stage: "step_1",
      reason: "driver_error: screen unavailable",
    }];
    writeJson(join(args.iosArtifact!, "result.json"), result);

    const summary = await normalizeRunWithEvidence(args);
    const html = renderReport(summary);

    expect(summary.scores.ios_macro_pct).toBeNull();
    expect(readdirSync(join(args.outDir, "evidence/screenshots"))).toEqual([]);
    expect(html).toContain("Screenshot capture warning");
    expect(html).toContain("simctl screenshot failed");
  });

  test("rejects unsafe existing output destinations without touching their targets", async () => {
    // Catches direct evidence publication following summary/data/evidence aliases.
    for (const kind of ["summary-symlink", "data-hardlink", "evidence-symlink"] as const) {
      const run = screenshotRun();
      const args: ReportInputs = {
        authoredArtifact: join(run.root, "author"),
        skillArtifact: join(run.root, "skill"),
        iosArtifact: run.iosRoot,
        outDir: run.outDir,
      };
      run.summary = await normalizeRun(args);
      const outside = join(run.root, `outside-${kind}`);
      if (kind === "summary-symlink") {
        writeFileSync(outside, "outside summary");
        rmSync(join(run.outDir, "summary.json"));
        symlinkSync(outside, join(run.outDir, "summary.json"));
      } else if (kind === "data-hardlink") {
        writeFileSync(outside, "outside data");
        rmSync(join(run.outDir, "data/build-health.json"));
        linkSync(outside, join(run.outDir, "data/build-health.json"));
      } else {
        mkdirSync(outside);
        writeFileSync(join(outside, "sentinel"), "outside evidence");
        rmSync(join(run.outDir, "evidence/screenshots"), { recursive: true });
        symlinkSync(outside, join(run.outDir, "evidence/screenshots"));
      }

      await expect(
        copyScreenshotEvidence(run.summary, run.iosRoot, run.outDir),
      ).rejects.toThrow("unsafe output");
      if (kind === "evidence-symlink") {
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside evidence");
      } else {
        expect(readFileSync(outside, "utf8")).toContain("outside");
      }
    }
  });

  test("real CLI preserves the prior report when evidence validation fails", () => {
    // Catches normalize succeeding before evidence failure and replacing a good prior report.
    const run = screenshotRun();
    mkdirSync(run.outDir);
    writeFileSync(join(run.outDir, "sentinel.txt"), "prior complete report");
    writeFileSync(
      join(run.iosRoot, "traces/test-plans/test_insert_20260810_120000/screenshots/step-01-final.png"),
      "invalid png",
    );
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "../main.ts"),
      "--authored-artifact", join(run.root, "author"),
      "--skill-artifact", join(run.root, "skill"),
      "--ios-artifact", run.iosRoot,
      "--out-dir", run.outDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(readdirSync(run.outDir)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(run.outDir, "sentinel.txt"), "utf8"))
      .toBe("prior complete report");
  });

  test("fails traversal, symlink, hardlink, non-regular, and non-PNG evidence", async () => {
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

      await expect(
        copyScreenshotEvidence(run.summary, run.iosRoot, run.outDir),
      ).rejects.toThrow(candidate.warning);
      expect(readdirSync(join(run.outDir, "evidence/screenshots")), candidate.name).toEqual([]);
    }
  });

  test("rejects a .png reference whose bytes lack the PNG signature", async () => {
    // Catches extension-only validation copying disguised arbitrary files.
    const run = screenshotRun();
    const source = join(
      run.iosRoot,
      "traces/test-plans/test_insert_20260810_120000/screenshots/step-01-final.png",
    );
    writeFileSync(source, "not actually png data");
    const args: ReportInputs = {
      authoredArtifact: join(run.root, "author"),
      skillArtifact: join(run.root, "skill"),
      iosArtifact: run.iosRoot,
      outDir: run.outDir,
    };
    run.summary = await normalizeRun(args);

    await expect(
      copyScreenshotEvidence(run.summary, run.iosRoot, run.outDir),
    ).rejects.toThrow("invalid PNG signature");
  });

  test("rejects ambiguous positional trace ownership", async () => {
    // Catches an arbitrary sorted trace being assigned when repeats do not correspond exactly.
    const run = screenshotRun();
    const duplicateTrace = join(
      run.iosRoot,
      "traces/test-plans/test_insert_20260810_130000",
    );
    writeJson(
      join(duplicateTrace, "summary.json"),
      completeTraceSummary("test_insert.txt"),
    );
    mkdirSync(join(duplicateTrace, "screenshots"));
    writeFileSync(join(duplicateTrace, "screenshots/step-01-final.png"), PNG_BYTES);
    const args: ReportInputs = {
      authoredArtifact: join(run.root, "author"),
      skillArtifact: join(run.root, "skill"),
      iosArtifact: run.iosRoot,
      outDir: run.outDir,
    };
    run.summary = await normalizeRun(args);

    await expect(
      copyScreenshotEvidence(run.summary, run.iosRoot, run.outDir),
    ).rejects.toThrow("ambiguous plan trace ownership");
  });

  test("rejects deterministic evidence destination collisions", async () => {
    // Catches distinct plan names collapsing to one stable evidence filename.
    const run = screenshotRun();
    const result = readJson(join(run.iosRoot, "result.json"));
    const firstPlan = (result.test_plans as Array<Record<string, unknown>>)[0]!;
    const secondPlan = structuredClone(firstPlan);
    firstPlan.test_plan = "test_a-b.txt";
    secondPlan.test_plan = "test_a_b.txt";
    result.expected_plan_count = 2;
    result.terminal_plan_count = 2;
    result.test_plans = [firstPlan, secondPlan];
    writeJson(join(run.iosRoot, "result.json"), result);
    rmSync(join(run.iosRoot, "traces"), { recursive: true });
    for (const [name, plan] of [["one", "test_a-b.txt"], ["two", "test_a_b.txt"]] as const) {
      const trace = join(run.iosRoot, "traces/test-plans", name);
      writeJson(
        join(trace, "summary.json"),
        completeTraceSummary(plan, { runIndex: 1 }),
      );
      mkdirSync(join(trace, "screenshots"));
      writeFileSync(join(trace, "screenshots/step-01-final.png"), PNG_BYTES);
      writeFileSync(join(trace, "screenshots/step-02-final.png"), PNG_BYTES);
    }
    const args: ReportInputs = {
      authoredArtifact: join(run.root, "author"),
      skillArtifact: join(run.root, "skill"),
      iosArtifact: run.iosRoot,
      outDir: run.outDir,
    };
    run.summary = await normalizeRun(args);

    await expect(
      copyScreenshotEvidence(run.summary, run.iosRoot, run.outDir),
    ).rejects.toThrow("evidence destination collision");
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
    await expect(normalizeRun(args)).rejects.toThrow("unsafe plan trace directory");
    expect(lstatSync(join(tracesRoot, "test_insert_escape")).isSymbolicLink()).toBe(true);
  });
});
