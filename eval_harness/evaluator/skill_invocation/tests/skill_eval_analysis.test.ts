import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { c as createArchive } from "tar";

import {
  aggregateSkillResults,
  analyzeArtifacts,
  computeSkillResults,
  discoverArtifactLayout,
  scoreCaseRun,
  writeHtmlReport,
  type SkillEvalPayload,
  type SkillResult,
} from "../analysis.ts";
import { CheckResult, type Check } from "../uptake_checks/registry.ts";

const CLI_PATH = resolve(import.meta.dir, "../main.ts");
const SHELL_ENTRYPOINT = resolve(import.meta.dir, "../scripts/eval-skill-use.sh");
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

function withTempDir<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "skill-analysis-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "skill-analysis-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function result(
  id: string,
  status: "passed" | "failed" | "not_applicable" | "unavailable",
): CheckResult {
  return new CheckResult({
    id,
    category: "structural",
    kind: "path_exists",
    target: [id],
    passed: status === "passed" ? true : status === "failed" ? false : null,
    evidence: `${id} is ${status}`,
    status,
  });
}

function check(id: string): Check {
  return {
    id,
    category: "structural",
    kind: "path_exists",
    target: [id],
    description: "",
    run: null,
  };
}

function writeFixture(root: string): {
  authored: string;
  prdSkills: string;
  checksDir: string;
  app: string;
  bundle: string;
  trace: string;
  manifest: string;
} {
  const authored = join(root, "authored");
  const app = join(authored, "agent-workspace", "run-1");
  const bundle = join(authored, "eval-out", "run-1", "bundle");
  const traces = join(bundle, "telemetry", "traces");
  mkdirSync(app, { recursive: true });
  mkdirSync(traces, { recursive: true });
  writeFileSync(join(app, "package.json"), "{}");
  writeFileSync(join(app, "ready"), "yes\n");
  const manifest = join(bundle, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({ prd: "dataset/prds/test-app/prd/mvp.txt" }),
  );
  const trace = join(traces, "claude-code-authoring.json");
  writeFileSync(
    trace,
    JSON.stringify({
      agent: "claude-code",
      sessions: [
        {
          turns: [
            {
              steps: [
                {
                  tool_calls: [
                    { name: "Skill", args: { skill: "expo:expo-test" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const prdSkills = join(root, "prd_skills.json");
  writeFileSync(prdSkills, JSON.stringify({ "test-app": ["expo-test"] }));
  const checksDir = join(root, "checks");
  mkdirSync(checksDir);
  writeFileSync(
    join(checksDir, "checks_data.json"),
    JSON.stringify({
      checks: [
        {
          id: "ready-file",
          category: "structural",
          kind: "path_exists",
          target: ["ready"],
        },
      ],
    }),
  );
  writeFileSync(
    join(checksDir, "skill_map.json"),
    JSON.stringify({ "expo-test": ["ready-file"] }),
  );
  return { authored, prdSkills, checksDir, app, bundle, trace, manifest };
}

const EXPECTED_HAPPY_REPORT = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Expo Skill Eval</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 32px; }
    th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }
    .note { color: #555; max-width: 760px; }
  </style>
</head>
<body>
  <h1>Expo Skill Eval</h1>
  <p>Skill eval artifact analysis for test-app</p>
  <p class="note">Initial v0 signal: trace trigger detection, static code uptake checks, and optional evaluator score. No LLM judge or screenshot evidence is used.</p>
  <table>
    <thead><tr><th>App</th><th>Scenario</th><th>Expected</th><th>Detected</th><th>Exact match</th><th>Recall</th><th>Precision</th><th>Uptake (pooled, legacy)</th><th>Evaluator</th></tr></thead>
    <tbody><tr><td>test-app</td><td>skills_available_unmentioned</td><td>expo-test</td><td>expo-test</td><td>True</td><td>100.0%</td><td>100.0%</td><td>100.0%</td><td>n/a</td></tr></tbody>
  </table>
  <h2>Per-skill results</h2>
  <p class="note">Each expected skill's own trigger status and uptake, measured independently -- not the pooled number above.</p>
  <table>
    <thead><tr><th>Skill</th><th>Trigger</th><th>Uptake status</th><th>Passed/Total</th><th>Uptake rate</th></tr></thead>
    <tbody><tr><td>expo-test</td><td>observed</td><td>measured</td><td>1/1</td><td>100.0%</td></tr></tbody>
  </table>
  <h2>Per-check detail</h2>
  <p class="note">Every check run per skill, including not_applicable (its precondition didn't hold for this app) and unavailable (evidence couldn't be collected, e.g. a parser didn't run) -- neither counts toward Passed/Total or Uptake rate above, but both are shown here rather than silently dropped.</p>
  <table>
    <thead><tr><th>Skill</th><th>Check</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody><tr><td>expo-test</td><td>ready-file</td><td>passed</td><td>found ready</td></tr></tbody>
  </table>
</body>
</html>
`;

test("[REGRESSION] case scoring gates pooled uptake on a relevant trigger", () => {
  const skipped = scoreCaseRun({
    expectedSkills: ["expo-test"],
    triggeredSkills: ["other"],
    staticPassed: 1,
    staticTotal: 1,
    evaluatorPct: null,
    buildSuccess: null,
  });
  const scored = scoreCaseRun({
    expectedSkills: ["expo-test"],
    triggeredSkills: ["expo-test"],
    staticPassed: 1,
    staticTotal: 2,
    evaluatorPct: 87.5,
    buildSuccess: true,
  });

  expect(skipped.contextUptake).toEqual({
    passed: 0,
    total: 1,
    uptakeRate: null,
    skippedReason: "relevant skill did not trigger",
  });
  expect(scored.contextUptake).toEqual({
    passed: 1,
    total: 2,
    uptakeRate: 0.5,
    skippedReason: null,
  });
  expect(scored.outcomeDelta).toEqual({
    evaluatorPct: 87.5,
    buildSuccess: true,
  });
});

test("[REGRESSION] per-skill results preserve support and evidence status", () => {
  const shared = check("shared");
  const unavailable = check("unavailable");
  const results = computeSkillResults({
    expectedSkills: ["skill-a", "skill-b", "unsupported"],
    triggeredSkills: ["skill-a"],
    checksBySkill: {
      "skill-a": [shared],
      "skill-b": [shared, unavailable],
      unsupported: null,
    },
    resultsById: new Map([
      ["shared", result("shared", "passed")],
      ["unavailable", result("unavailable", "unavailable")],
    ]),
    appDirMissing: false,
  });

  expect(results["skill-a"]).toMatchObject({
    triggered: true,
    trigger_status: "observed",
    uptake_status: "measured",
    passed: 1,
    total: 1,
    uptake_rate: 1,
  });
  expect(results["skill-b"]).toMatchObject({
    triggered: false,
    trigger_status: "not_observed",
    uptake_status: "unavailable",
    passed: 1,
    total: 1,
    uptake_rate: 1,
  });
  expect(results.unsupported).toEqual({
    expected: true,
    triggered: false,
    trigger_status: "not_observed",
    uptake_status: "unsupported",
    passed: null,
    total: null,
    uptake_rate: null,
    checks: [],
  });
});

test("[REGRESSION] aggregation compares skill runs with unavailable baselines", () => {
  expect(
    aggregateSkillResults([
      {
        skill_id: "expo-test",
        scenario: "skills_unavailable",
        evaluator_pct: 0.4,
      },
      {
        skill_id: "expo-test",
        scenario: "skills_available_unmentioned",
        evaluator_pct: 0.7,
        trigger_recall: 1,
        trigger_precision: 0.5,
        trigger_exact_match: false,
        uptake_rate: 0.75,
        build_success: true,
      },
    ]),
  ).toEqual({
    "expo-test": {
      skill_id: "expo-test",
      baseline_evaluator_pct: 0.4,
      skill_evaluator_pct: 0.7,
      outcome_delta: 0.3,
      trigger_recall: 1,
      trigger_precision: 0.5,
      trigger_accuracy: 0,
      uptake_rate: 0.75,
      build_success_rate: 1,
    },
  });
});

test("[REGRESSION] artifact discovery and analysis preserve the metrics contract", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    const outDir = join(root, "out");
    const layout = await discoverArtifactLayout(fixture.authored);

    expect(layout.appDir).toEndWith(join("agent-workspace", "run-1"));
    expect(layout.tracePath).toEndWith("claude-code-authoring.json");
    expect(layout.manifestPath).toEndWith("manifest.json");
    expect(layout.resultPath).toBeNull();

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_unmentioned",
      outDir,
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    const checkResult = {
      id: "ready-file",
      category: "structural",
      kind: "path_exists",
      target: ["ready"],
      passed: true,
      evidence: "found ready",
      status: "passed",
    };
    const skillResult: SkillResult = {
      expected: true,
      triggered: true,
      trigger_status: "observed",
      uptake_status: "measured",
      passed: 1,
      total: 1,
      uptake_rate: 1,
      checks: [checkResult],
    };
    const expectedPayload = {
      summary: "Skill eval artifact analysis for test-app",
      app: "test-app",
      expected_skills: ["expo-test"],
      scenario: "skills_available_unmentioned",
      outcome_status: "pending",
      warnings: [],
      score: {
        trigger_quality: {
          expected_skills: ["expo-test"],
          triggered_skills: ["expo-test"],
          matched_skills: ["expo-test"],
          extra_skills: [],
          missing_skills: [],
          recall: 1,
          precision: 1,
          any_expo_skill_triggered: true,
        },
        context_uptake: {
          passed: 1,
          total: 1,
          uptake_rate: 1,
          skipped_reason: null,
        },
        outcome_delta: { evaluator_pct: null, build_success: null },
      },
      static_checks: [checkResult],
      check_category_breakdown: { structural: { passed: 1, total: 1 } },
      build_health: {
        syntax: {
          total_files: 0,
          checked_files: 0,
          skipped_unavailable: 0,
          failed_files: [],
          ok: null,
        },
        bundle: null,
      },
      runs: [{
        app: "test-app",
        scenario: "skills_available_unmentioned",
        skill_id: "expo-test",
        trigger_recall: 1,
        trigger_precision: 1,
        trigger_exact_match: true,
        detected_skills: ["expo-test"],
        uptake_rate: 1,
        evaluator_pct: null,
        build_success: null,
        skills: { "expo-test": skillResult },
      }],
      skills: { "expo-test": skillResult },
      artifacts: {
        authored_root: fixture.authored,
        app_dir: fixture.app,
        author_trace: fixture.trace,
        author_manifest: fixture.manifest,
        eval_root: null,
        eval_result: null,
        eval_manifest: null,
      },
      braintrust_refs: [],
    } satisfies SkillEvalPayload;
    expect(payload).toEqual(expectedPayload);
    expect(JSON.parse(readFileSync(join(outDir, "metrics.json"), "utf8")))
      .toEqual(expectedPayload);
    expect(readFileSync(join(outDir, "report.html"), "utf8"))
      .toBe(EXPECTED_HAPPY_REPORT);
  });
});

test("[REGRESSION] artifact discovery ignores nested workspace dependencies", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    const dependency = join(
      fixture.app,
      "node_modules",
      "nested-dependency",
    );
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), "{}");

    const layout = await discoverArtifactLayout(fixture.authored);

    // Python searches only agent-workspace/*/package.json. A dependency's
    // nested package.json must never replace the authored app root.
    expect(layout.appDir).toBe(fixture.app);
  });
});

test("[REGRESSION] artifact discovery accepts Muse authoring traces", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    rmSync(fixture.trace);
    const museTrace = join(fixture.bundle, "telemetry", "traces", "muse-code-authoring.json");
    writeFileSync(
      museTrace,
      JSON.stringify({
        agent: "muse-code",
        sessions: [{ turns: [{ steps: [{ tool_calls: [{ name: "Skill", args: { skill: "expo-test" } }] }] }] }],
      }),
    );

    const layout = await discoverArtifactLayout(fixture.authored);
    expect(layout.tracePath).toBe(museTrace);
    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "muse-out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });
    expect(payload.score.trigger_quality).toMatchObject({
      triggered_skills: ["expo-test"],
      recall: 1,
      precision: 1,
    });
  });
});

test("[REGRESSION] evaluator results produce a complete outcome", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    const evalArtifact = join(root, "eval");
    const resultDir = join(evalArtifact, "eval-out", "run-1", "bundle", "eval");
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(
      join(resultDir, "result.json"),
      JSON.stringify({ macro_avg_pct: 87.5 }),
    );

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact,
      scenario: "skills_available_mentioned",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.outcome_status).toBe("complete");
    expect(payload.runs[0]).toMatchObject({
      evaluator_pct: 87.5,
      build_success: true,
    });
    expect(payload.skills["expo-test"]).toMatchObject({
      triggered: true,
      trigger_status: "observed",
      uptake_status: "measured",
      uptake_rate: 1,
    });
    expect(payload.artifacts.eval_result).toBe(join(resultDir, "result.json"));
  });
});

test("[REGRESSION] incomplete evaluator results are not outcome evidence", async () => {
  // Oracle: only an explicitly completed iOS suite is valid outcome evidence.
  // Catches: treating a finite partial score from an infrastructure failure as complete.
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    const evalArtifact = join(root, "eval");
    const resultDir = join(evalArtifact, "eval-out", "run-1", "bundle", "eval");
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(
      join(resultDir, "result.json"),
      JSON.stringify({ status: "incomplete", macro_avg_pct: 87.5 }),
    );

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.outcome_status).toBe("pending");
    expect(payload.runs[0]).toMatchObject({
      evaluator_pct: null,
      build_success: null,
    });
  });
});

test("[REGRESSION] non-finite evaluator scores cannot create complete outcomes", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    const evalArtifact = join(root, "eval");
    const resultDir = join(evalArtifact, "eval-out", "run-1", "bundle", "eval");
    mkdirSync(resultDir, { recursive: true });
    const resultPath = join(resultDir, "result.json");

    writeFileSync(
      resultPath,
      JSON.stringify({ macro_avg_pct: "n/a", micro_pct: 64.5 }),
    );
    const fallback = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "fallback-out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });
    expect(fallback.outcome_status).toBe("complete");
    expect(fallback.runs[0]?.evaluator_pct).toBe(64.5);

    writeFileSync(
      resultPath,
      JSON.stringify({ macro_avg_pct: "Infinity", micro_pct: "n/a" }),
    );
    const unavailable = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "unavailable-out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });
    expect(unavailable.outcome_status).toBe("pending");
    expect(unavailable.runs[0]?.evaluator_pct).toBeNull();
  });
});

test("[REGRESSION] a missing author trace degrades to warnings", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    rmSync(fixture.trace);

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.warnings).toContain("author trace not found");
    expect(payload.runs[0]?.trigger_recall).toBe(0);
    expect(payload.runs[0]?.uptake_rate).toBeNull();
  });
});

test("[REGRESSION] a missing app tree degrades to warnings", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    rmSync(fixture.app, { recursive: true });

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.warnings).toContain("app tree not found");
    expect(payload.static_checks).toEqual([]);
    expect(payload.runs[0]?.uptake_rate).toBe(0);
    expect(payload.skills["expo-test"]?.uptake_status).toBe("missing_app");
  });
});

test("[REGRESSION] expected skills without mappings remain unsupported", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    writeFileSync(join(fixture.checksDir, "skill_map.json"), "{}");

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.warnings).toContain(
      "no uptake checks mapped for skill 'expo-test'",
    );
    expect(payload.skills["expo-test"]).toMatchObject({
      uptake_status: "unsupported",
      passed: null,
      total: null,
      uptake_rate: null,
      checks: [],
    });
  });
});

test("[REGRESSION] unavailable scenarios expect no skill triggers", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    writeFileSync(
      fixture.trace,
      JSON.stringify({
        agent: "claude-code",
        sessions: [{
          turns: [{ steps: [{ tool_calls: [{ name: "Bash", args: { command: "ls" } }] }] }],
        }],
      }),
    );

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_unavailable",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.expected_skills).toEqual([]);
    expect(payload.runs[0]).toMatchObject({
      skill_id: "",
      trigger_recall: 1,
      trigger_precision: 1,
      trigger_exact_match: true,
    });
  });
});

test("[REGRESSION] manifest scenario overrides mismatched CLI input", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        prd: "dataset/prds/test-app/prd/mvp.txt",
        scenario: "skills_unavailable",
      }),
    );

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_mentioned",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.scenario).toBe("skills_unavailable");
    expect(payload.expected_skills).toEqual([]);
    expect(payload.warnings.some((warning) => warning.includes("scenario mismatch")))
      .toBe(true);
  });
});

test("[REGRESSION] unmapped PRDs produce an empty expected-skill set", async () => {
  await withTempDirAsync(async (root) => {
    const fixture = writeFixture(root);
    writeFileSync(
      fixture.manifest,
      JSON.stringify({ prd: "dataset/prds/unmapped-app/prd/mvp.txt" }),
    );

    const payload = await analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_unmentioned",
      outDir: join(root, "out"),
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload.expected_skills).toEqual([]);
    expect(payload.warnings.some((warning) =>
      warning.includes("no ground-truth skill set for app 'unmapped-app'")
    )).toBe(true);
  });
});

test("[REGRESSION] HTML report escapes artifact-controlled values", async () => {
  await withTempDirAsync(async (root) => {
    const path = join(root, "report.html");
    await writeHtmlReport(
      {
        summary: "<script>alert(1)</script>",
        runs: [
          {
            app: null,
            scenario: "skills_available_unmentioned",
            skill_id: "",
            detected_skills: [],
            trigger_exact_match: true,
            trigger_recall: 1,
            trigger_precision: 1,
            uptake_rate: null,
            evaluator_pct: null,
          },
        ],
        skills: {
          "<unsafe>": {
            trigger_status: "not_observed",
            uptake_status: "unsupported",
            passed: null,
            total: null,
            uptake_rate: null,
            checks: [],
          },
        },
      },
      path,
    );
    const html = readFileSync(path, "utf8");

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;unsafe&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("<td></td>");
    expect(html).not.toContain("<td>None</td>");
  });
});

test("[CHAR] Bun CLI preserves help and required-option errors", () => {
  const help = Bun.spawnSync([process.execPath, CLI_PATH, "--help"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const missing = Bun.spawnSync([process.execPath, CLI_PATH, "analyze-artifacts"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(help.exitCode).toBe(0);
  expect(help.stderr.toString()).toBe("");
  expect(help.stdout.toString()).toContain("Expo skill-eval helpers");
  expect(help.stdout.toString()).toContain("analyze-artifacts");
  expect(missing.exitCode).toBe(2);
  expect(missing.stdout.toString()).toBe("");
  expect(missing.stderr.toString()).toContain("usage:");
  expect(missing.stderr.toString()).toContain("--authored-artifact");
  expect(missing.stderr.toString()).toContain("--scenario");
  expect(missing.stderr.toString()).toContain("--out-dir");
});

test("[CHAR] Bun CLI writes reports and the stable console summary", () => {
  withTempDir((root) => {
    const fixture = writeFixture(root);
    const outDir = join(root, "out");
    const spawned = Bun.spawnSync([
      process.execPath,
      CLI_PATH,
      "analyze-artifacts",
      "--authored-artifact",
      fixture.authored,
      "--eval-artifact",
      "null",
      "--scenario",
      "skills_available_unmentioned",
      "--out-dir",
      outDir,
      "--prd-skills",
      fixture.prdSkills,
      "--checks-dir",
      fixture.checksDir,
    ], { stdout: "pipe", stderr: "pipe" });

    expect(spawned.exitCode).toBe(0);
    expect(spawned.stderr.toString()).toBe("");
    expect(spawned.stdout.toString()).toBe(
      "----- skill-eval summary -----\n" +
        "app=test-app\n" +
        "scenario=skills_available_unmentioned\n" +
        "expected_skills=expo-test\n" +
        "detected_skills=expo-test\n" +
        "uptake_rate=1.0\n" +
        "evaluator_pct=None\n" +
        "trigger_recall=1.0\n" +
        "trigger_precision=1.0\n" +
        "trigger_exact_match=True\n",
    );
    expect(JSON.parse(readFileSync(join(outDir, "metrics.json"), "utf8")))
      .toMatchObject({ app: "test-app", expected_skills: ["expo-test"] });
    expect(readFileSync(join(outDir, "report.html"), "utf8"))
      .toStartWith("<!doctype html>");
  });
});

test("[CHAR] Bun CLI accepts Python's unique long-option abbreviations", () => {
  withTempDir((root) => {
    const fixture = writeFixture(root);
    const outDir = join(root, "abbreviated-out");
    const spawned = Bun.spawnSync([
      process.execPath,
      CLI_PATH,
      "analyze-artifacts",
      "--authored",
      fixture.authored,
      "--scen",
      "skills_available_unmentioned",
      "--out",
      outDir,
      "--prd",
      fixture.prdSkills,
      "--checks",
      fixture.checksDir,
    ], { stdout: "pipe", stderr: "pipe" });

    expect(spawned.exitCode).toBe(0);
    expect(spawned.stderr.toString()).toBe("");
    expect(JSON.parse(readFileSync(join(outDir, "metrics.json"), "utf8")))
      .toMatchObject({ app: "test-app", expected_skills: ["expo-test"] });
  });
});

test("[REGRESSION] archived relative inputs preserve relative artifact paths", () => {
    // Oracle: relative user inputs remain relative in the stable metrics schema.
    // Catches: resolve() leaking runner-specific absolute paths into artifacts.
    withTempDir((root) => {
      const fixture = writeFixture(root);
      const archive = join(root, "authored.tar.gz");
      createArchive(
        { file: archive, cwd: fixture.authored, gzip: true, sync: true },
        ["."],
      );
      const relativeArchive = relative(REPO_ROOT, archive);
      const sharedOut = join(root, "relative-out");
      const relativeOut = relative(REPO_ROOT, sharedOut);
      const shared = [
        "analyze-artifacts",
        "--authored-artifact",
        relativeArchive,
        "--scenario",
        "skills_available_unmentioned",
        "--out-dir",
        relativeOut,
        "--prd-skills",
        fixture.prdSkills,
        "--checks-dir",
        fixture.checksDir,
      ];
      const bun = Bun.spawnSync([process.execPath, CLI_PATH, ...shared], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(bun.stderr.toString()).toBe("");
      expect(bun.exitCode).toBe(0);
      const bunMetrics = JSON.parse(
        readFileSync(join(sharedOut, "metrics.json"), "utf8"),
      );

      expect(bunMetrics.artifacts.authored_root.startsWith("/")).toBe(false);
      expect(bunMetrics.artifacts.author_trace.startsWith("/")).toBe(false);
      expect(bunMetrics.artifacts.author_manifest.startsWith("/")).toBe(false);
      expect(bunMetrics.artifacts.app_dir.startsWith("/")).toBe(false);
    });
});

test("[REGRESSION] shell entrypoint runs with Bun and no Python executable", () => {
  // Catches: accidentally restoring the retired Python caller or dropping
  // environment-to-CLI argument propagation.
  withTempDir((root) => {
    const fixture = writeFixture(root);
    const outDir = join(root, "shell-out");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const requiredCommands: Array<readonly [string, string]> = [
      ["bun", process.execPath],
      ["dirname", "/usr/bin/dirname"],
      ["find", "/usr/bin/find"],
      ["mkdir", "/bin/mkdir"],
      ["sort", "/usr/bin/sort"],
    ];
    for (const [name, target] of requiredCommands) {
      symlinkSync(target, join(bin, name));
    }
    const spawned = Bun.spawnSync(["/bin/bash", SHELL_ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: {
        PATH: bin,
        AUTHORED_ARTIFACT: fixture.authored,
        EVAL_ARTIFACT: "",
        SCENARIO: "skills_available_unmentioned",
        OUT_DIR: outDir,
        PRD_SKILLS: fixture.prdSkills,
        CHECKS_DIR: fixture.checksDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(spawned.exitCode).toBe(0);
    expect(spawned.stderr.toString()).toBe("");
    expect(spawned.stdout.toString()).toContain("app=test-app\n");
    expect(JSON.parse(readFileSync(join(outDir, "metrics.json"), "utf8")))
      .toMatchObject({ app: "test-app", expected_skills: ["expo-test"] });
  });
});
