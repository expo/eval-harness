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
} {
  const authored = join(root, "authored");
  const app = join(authored, "agent-workspace", "run-1");
  const bundle = join(authored, "eval-out", "run-1", "bundle");
  const traces = join(bundle, "telemetry", "traces");
  mkdirSync(app, { recursive: true });
  mkdirSync(traces, { recursive: true });
  writeFileSync(join(app, "package.json"), "{}");
  writeFileSync(join(app, "ready"), "yes\n");
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({ prd: "dataset/prds/test-app/prd/mvp.txt" }),
  );
  writeFileSync(
    join(traces, "claude-code-authoring.json"),
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
  return { authored, prdSkills, checksDir };
}

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

test("[REGRESSION] artifact discovery and analysis preserve the metrics contract", () => {
  withTempDir((root) => {
    const fixture = writeFixture(root);
    const outDir = join(root, "out");
    const layout = discoverArtifactLayout(fixture.authored);

    expect(layout.appDir).toEndWith(join("agent-workspace", "run-1"));
    expect(layout.tracePath).toEndWith("claude-code-authoring.json");
    expect(layout.manifestPath).toEndWith("manifest.json");
    expect(layout.resultPath).toBeNull();

    const payload = analyzeArtifacts({
      authoredArtifact: fixture.authored,
      evalArtifact: null,
      scenario: "skills_available_unmentioned",
      outDir,
      prdSkillsPath: fixture.prdSkills,
      checksDir: fixture.checksDir,
    });

    expect(payload).toMatchObject({
      app: "test-app",
      expected_skills: ["expo-test"],
      scenario: "skills_available_unmentioned",
      outcome_status: "pending",
      warnings: [],
      skills: {
        "expo-test": {
          triggered: true,
          uptake_status: "measured",
          uptake_rate: 1,
        },
      },
    });
    expect(JSON.parse(readFileSync(join(outDir, "metrics.json"), "utf8")))
      .toEqual(payload);
    expect(readFileSync(join(outDir, "report.html"), "utf8"))
      .toStartWith("<!doctype html>");
  });
});

test("[REGRESSION] HTML report escapes artifact-controlled values", () => {
  withTempDir((root) => {
    const path = join(root, "report.html");
    writeHtmlReport(
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
