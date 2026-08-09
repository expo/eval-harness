import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import {
  readBundleResult,
  type BundleResult,
} from "./build_health/bundle_check.ts";
import {
  checkSyntax,
  type SyntaxCheckResult,
} from "./build_health/syntax_check.ts";
import {
  SCORED_STATUSES,
  STATUS_UNAVAILABLE,
  CheckResult,
  UptakeResults,
  resolveChecksBySkill,
  resolveChecksForSkills,
  runChecks,
  type Check,
} from "./uptake_checks/registry.ts";
import {
  detectTriggeredSkills,
  loadTrace,
  scoreTriggerQuality,
  type NormalizedTrace,
  type TriggerQuality,
} from "./uptake_checks/trigger.ts";
import {
  appNameFromPrd,
  compareUnicodeCodePoints,
  dedupe,
  flattenStrings,
  loadPrdSkillsAsync,
  readJsonAsync,
  roundFloat,
  writeJsonAsync,
  type JsonObject,
} from "./utils.ts";

const TRACE_CANDIDATES = [
  "claude-code-authoring.json",
  "claude-authoring.json",
  "codex-authoring.json",
  "muse-code-authoring.json",
  "claude-code.json",
  "claude.json",
  "codex.json",
] as const;
const UNAVAILABLE_SCENARIOS = new Set(["skills_unavailable"]);
const BASELINE_SCENARIOS = UNAVAILABLE_SCENARIOS;

export type ArtifactLayout = {
  root: string;
  appDir: string | null;
  tracePath: string | null;
  manifestPath: string | null;
  resultPath: string | null;
};

export type ContextUptake = {
  passed: number;
  total: number;
  uptakeRate: number | null;
  skippedReason: string | null;
};

export type OutcomeDelta = {
  evaluatorPct: number | null;
  buildSuccess: boolean | null;
};

export type CaseRunScore = {
  triggerQuality: TriggerQuality;
  contextUptake: ContextUptake;
  outcomeDelta: OutcomeDelta;
};

type CheckJson = {
  id: string;
  category: string;
  kind: string;
  target: unknown;
  passed: boolean | null;
  evidence: string;
  status: string;
};

export type SkillResult = {
  expected: true;
  triggered: boolean;
  trigger_status: "observed" | "not_observed";
  uptake_status:
    | "unsupported"
    | "missing_app"
    | "unavailable"
    | "measured"
    | "not_applicable";
  passed: number | null;
  total: number | null;
  uptake_rate: number | null;
  checks: CheckJson[];
};

export type SkillRun = {
  app: string | null;
  scenario: string;
  skill_id: string;
  trigger_recall: number;
  trigger_precision: number;
  trigger_exact_match: boolean;
  detected_skills: string[];
  uptake_rate: number | null;
  evaluator_pct: number | null;
  build_success: boolean | null;
  skills: Record<string, SkillResult>;
};

export type SkillEvalPayload = {
  summary: string;
  app: string | null;
  expected_skills: string[];
  scenario: string;
  outcome_status: "complete" | "pending";
  warnings: string[];
  score: Record<string, unknown>;
  static_checks: CheckJson[];
  check_category_breakdown: Record<string, { passed: number; total: number }>;
  build_health: {
    syntax: SyntaxCheckResult | null;
    bundle: BundleResult | null;
  };
  runs: SkillRun[];
  skills: Record<string, SkillResult>;
  artifacts: Record<string, string | null>;
  braintrust_refs: string[];
  [key: string]: unknown;
};

export async function analyzeArtifacts(args: {
  authoredArtifact: string;
  evalArtifact: string | null;
  scenario: string;
  outDir: string;
  prdSkillsPath: string;
  checksDir: string;
}): Promise<SkillEvalPayload> {
  await mkdir(args.outDir, { recursive: true });
  const [authorLayout, evalLayout] = await Promise.all([
    discoverArtifactLayout(args.authoredArtifact),
    args.evalArtifact === null
      ? Promise.resolve(null)
      : discoverArtifactLayout(args.evalArtifact),
  ]);
  const warnings: string[] = [];
  const scenario = await resolveScenario(args.scenario, authorLayout, warnings);
  const { appName, expectedSkills: appExpectedSkills } =
    await resolveAppExpectedSkills(authorLayout, args.prdSkillsPath, warnings);
  const expectedSkills = UNAVAILABLE_SCENARIOS.has(scenario)
    ? []
    : appExpectedSkills;
  const pooled = resolveChecksForSkills(expectedSkills, args.checksDir);
  warnings.push(...pooled.warnings);
  const perSkill = resolveChecksBySkill(expectedSkills, args.checksDir);
  warnings.push(...perSkill.warnings);

  let staticPassed = 0;
  let staticTotal = pooled.checks.length;
  let staticRows: CheckJson[] = [];
  let categoryBreakdown: Record<string, { passed: number; total: number }> = {};
  let buildHealth: SkillEvalPayload["build_health"] = {
    syntax: null,
    bundle: null,
  };
  const resultsById = new Map<string, CheckResult>();
  if (authorLayout.appDir === null) {
    warnings.push("app tree not found");
  } else {
    const [checkResults, syntax] = await Promise.all([
      runChecks(pooled.checks, authorLayout.appDir),
      checkSyntax(authorLayout.appDir),
    ]);
    const uptake = new UptakeResults(checkResults);
    staticPassed = uptake.passed;
    staticTotal = uptake.total;
    staticRows = uptake.checks.map(checkResultToJson);
    categoryBreakdown = uptake.categoryBreakdown();
    for (const result of uptake.checks) resultsById.set(result.id, result);
    buildHealth = {
      syntax,
      bundle: readBundleResult(authorLayout.appDir),
    };
  }

  let trace: NormalizedTrace = {};
  if (authorLayout.tracePath === null) {
    warnings.push("author trace not found");
  } else {
    trace = loadTrace(authorLayout.tracePath);
  }
  const triggeredSkills = detectTriggeredSkills(trace);
  const skillResults = computeSkillResults({
    expectedSkills,
    triggeredSkills,
    checksBySkill: perSkill.checksBySkill,
    resultsById,
    appDirMissing: authorLayout.appDir === null,
  });
  const resultPath = evalLayout?.resultPath ?? null;
  const evaluatorPct = resultPath === null
    ? null
    : await readEvaluatorPct(resultPath);
  const buildSuccess = resultPath === null ? null : true;
  const score = scoreCaseRun({
    expectedSkills,
    triggeredSkills,
    staticPassed,
    staticTotal,
    evaluatorPct,
    buildSuccess,
  });
  const run: SkillRun = {
    app: appName,
    scenario,
    skill_id: expectedSkills.join(","),
    trigger_recall: score.triggerQuality.recall,
    trigger_precision: score.triggerQuality.precision,
    trigger_exact_match:
      setsEqual(new Set(score.triggerQuality.triggeredSkills), new Set(expectedSkills)),
    detected_skills: score.triggerQuality.triggeredSkills,
    uptake_rate: score.contextUptake.uptakeRate,
    evaluator_pct: evaluatorPct,
    build_success: buildSuccess,
    skills: skillResults,
  };
  const payload: SkillEvalPayload = {
    summary: `Skill eval artifact analysis for ${appName ?? "unknown app"}`,
    app: appName,
    expected_skills: expectedSkills,
    scenario,
    outcome_status: evaluatorPct === null ? "pending" : "complete",
    warnings,
    score: scoreToJson(score),
    static_checks: staticRows,
    check_category_breakdown: categoryBreakdown,
    build_health: buildHealth,
    runs: [run],
    skills: skillResults,
    artifacts: {
      authored_root: authorLayout.root,
      app_dir: authorLayout.appDir,
      author_trace: authorLayout.tracePath,
      author_manifest: authorLayout.manifestPath,
      eval_root: evalLayout?.root ?? null,
      eval_result: resultPath,
      eval_manifest: evalLayout?.manifestPath ?? null,
    },
    braintrust_refs: await collectBraintrustRefs(authorLayout, evalLayout, trace),
  };
  await Promise.all([
    writeJsonAsync(payload as JsonObject, path.join(args.outDir, "metrics.json")),
    writeHtmlReport(payload, path.join(args.outDir, "report.html")),
  ]);
  return payload;
}

async function resolveAppExpectedSkills(
  layout: ArtifactLayout,
  prdSkillsPath: string,
  warnings: string[],
): Promise<{ appName: string | null; expectedSkills: string[] }> {
  let prd: unknown = null;
  if (
    layout.manifestPath !== null &&
    await Bun.file(layout.manifestPath).exists()
  ) {
    prd = (await readJsonAsync<Record<string, unknown>>(layout.manifestPath)).prd;
  }
  const appName = typeof prd === "string" ? appNameFromPrd(prd) : null;
  if (appName === null) {
    warnings.push(`could not derive app name from manifest prd=${pythonRepr(prd)}`);
    return { appName, expectedSkills: [] };
  }
  if (!await Bun.file(prdSkillsPath).exists()) {
    warnings.push(`prd_skills map not found at ${prdSkillsPath}`);
    return { appName, expectedSkills: [] };
  }
  const expectedSkills = (await loadPrdSkillsAsync(prdSkillsPath))[appName];
  if (expectedSkills === undefined) {
    warnings.push(
      `no ground-truth skill set for app '${appName}' in ${prdSkillsPath}`,
    );
    return { appName, expectedSkills: [] };
  }
  return { appName, expectedSkills };
}

async function resolveScenario(
  input: string,
  layout: ArtifactLayout,
  warnings: string[],
): Promise<string> {
  if (
    layout.manifestPath === null ||
    !await Bun.file(layout.manifestPath).exists()
  ) return input;
  const recorded = (await readJsonAsync<Record<string, unknown>>(
    layout.manifestPath,
  )).scenario;
  if (typeof recorded !== "string" || recorded.length === 0) return input;
  if (input.length > 0 && recorded !== input) {
    warnings.push(
      `scenario mismatch: input='${input}' manifest='${recorded}'; using manifest`,
    );
  }
  return recorded;
}

export async function discoverArtifactLayout(root: string): Promise<ArtifactLayout> {
  const normalizedRoot = path.normalize(root);
  const files = await allFiles(normalizedRoot);
  return {
    root: normalizedRoot,
    appDir: findAppDir(normalizedRoot, files),
    tracePath: findTrace(files),
    manifestPath: firstExisting(
      normalizedRoot,
      ["bundle/manifest.json", "manifest.json"],
      "manifest.json",
      files,
    ),
    resultPath: firstExisting(
      normalizedRoot,
      ["bundle/eval/result.json", "eval/result.json", "result.json"],
      "result.json",
      files,
    ),
  };
}

export function scoreCaseRun(args: {
  expectedSkills: string[];
  triggeredSkills: string[];
  staticPassed: number;
  staticTotal: number;
  evaluatorPct: number | null;
  buildSuccess: boolean | null;
}): CaseRunScore {
  const triggerQuality = scoreTriggerQuality(
    args.expectedSkills,
    args.triggeredSkills,
  );
  const relevantTriggered = triggerQuality.matchedSkills.length > 0;
  const contextUptake: ContextUptake = relevantTriggered
    ? {
        passed: args.staticPassed,
        total: args.staticTotal,
        uptakeRate: args.staticTotal === 0
          ? null
          : roundFloat(args.staticPassed / args.staticTotal),
        skippedReason: null,
      }
    : {
        passed: 0,
        total: args.staticTotal,
        uptakeRate: null,
        skippedReason: "relevant skill did not trigger",
      };
  return {
    triggerQuality,
    contextUptake,
    outcomeDelta: {
      evaluatorPct: args.evaluatorPct,
      buildSuccess: args.buildSuccess,
    },
  };
}

export function computeSkillResults(args: {
  expectedSkills: string[];
  triggeredSkills: string[];
  checksBySkill: Record<string, Check[] | null>;
  resultsById: Map<string, CheckResult>;
  appDirMissing: boolean;
}): Record<string, SkillResult> {
  const triggered = new Set(args.triggeredSkills);
  const skills: Record<string, SkillResult> = {};
  for (const skillId of args.expectedSkills) {
    const isTriggered = triggered.has(skillId);
    const common = {
      expected: true as const,
      triggered: isTriggered,
      trigger_status: isTriggered ? "observed" as const : "not_observed" as const,
    };
    const checks = args.checksBySkill[skillId];
    if (checks === null || checks === undefined) {
      skills[skillId] = {
        ...common,
        uptake_status: "unsupported",
        passed: null,
        total: null,
        uptake_rate: null,
        checks: [],
      };
      continue;
    }
    if (args.appDirMissing) {
      skills[skillId] = {
        ...common,
        uptake_status: "missing_app",
        passed: null,
        total: checks.length,
        uptake_rate: null,
        checks: [],
      };
      continue;
    }
    const checkResults = checks.flatMap((check) => {
      const found = args.resultsById.get(check.id);
      return found === undefined ? [] : [found];
    });
    const scored = checkResults.filter((item) =>
      SCORED_STATUSES.has(item.status)
    );
    const passed = scored.filter((item) => item.passed === true).length;
    const unavailable = checkResults.some(
      (item) => item.status === STATUS_UNAVAILABLE,
    );
    // One unavailable required check means the complete uptake measurement is
    // unavailable. Keep any measured counts as evidence, but do not label a
    // partial result as fully measured.
    const uptakeStatus = unavailable
      ? "unavailable"
      : scored.length > 0
        ? "measured"
        : checkResults.length > 0
          ? "not_applicable"
          : "measured";
    skills[skillId] = {
      ...common,
      uptake_status: uptakeStatus,
      passed,
      total: scored.length,
      uptake_rate: scored.length === 0
        ? null
        : roundFloat(passed / scored.length),
      checks: checkResults.map(checkResultToJson),
    };
  }
  return skills;
}

export function aggregateSkillResults(
  runs: Array<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const run of runs) {
    for (const rawSkillId of String(run.skill_id ?? "").split(",")) {
      const skillId = rawSkillId.trim();
      if (skillId.length === 0) continue;
      const rows = grouped.get(skillId) ?? [];
      rows.push(run);
      grouped.set(skillId, rows);
    }
  }
  const output: Record<string, Record<string, unknown>> = {};
  for (const [skillId, rows] of grouped) {
    const baseline = rows.filter((row) =>
      BASELINE_SCENARIOS.has(String(row.scenario ?? ""))
    );
    const skillRows = rows.filter((row) =>
      !BASELINE_SCENARIOS.has(String(row.scenario ?? ""))
    );
    const baselineEval = average(values(baseline, "evaluator_pct"));
    const skillEval = average(values(skillRows, "evaluator_pct"));
    const recall = average(values(skillRows, "trigger_recall")) ?? 0;
    const precision = average(values(skillRows, "trigger_precision")) ?? 0;
    const exactMatch = average(
      skillRows.map((row) => row.trigger_exact_match ? 1 : 0),
    );
    const uptake = average(values(skillRows, "uptake_rate"));
    const buildSuccess = average(
      skillRows.map((row) => row.build_success ? 1 : 0),
    ) ?? 0;
    output[skillId] = {
      skill_id: skillId,
      baseline_evaluator_pct: baselineEval,
      skill_evaluator_pct: skillEval,
      outcome_delta: baselineEval === null || skillEval === null
        ? null
        : roundFloat(skillEval - baselineEval),
      trigger_recall: roundFloat(recall),
      trigger_precision: roundFloat(precision),
      trigger_accuracy: exactMatch === null ? null : roundFloat(exactMatch),
      uptake_rate: uptake === null ? null : roundFloat(uptake),
      build_success_rate: roundFloat(buildSuccess),
    };
  }
  return output;
}

export function printSummary(payload: SkillEvalPayload): void {
  const run = payload.runs[0] ?? {
    app: null,
    scenario: "",
    skill_id: "",
    detected_skills: [],
    uptake_rate: null,
    evaluator_pct: null,
    trigger_recall: null,
    trigger_precision: null,
    trigger_exact_match: false,
  };
  console.log("----- skill-eval summary -----");
  console.log(`app=${pythonDisplay(run.app)}`);
  console.log(`scenario=${pythonDisplay(run.scenario)}`);
  console.log(`expected_skills=${pythonDisplay(run.skill_id)}`);
  console.log(`detected_skills=${run.detected_skills.join(",")}`);
  console.log(`uptake_rate=${pythonFloatDisplay(run.uptake_rate)}`);
  console.log(`evaluator_pct=${pythonFloatDisplay(run.evaluator_pct)}`);
  console.log(`trigger_recall=${pythonFloatDisplay(run.trigger_recall)}`);
  console.log(`trigger_precision=${pythonFloatDisplay(run.trigger_precision)}`);
  console.log(`trigger_exact_match=${pythonDisplay(run.trigger_exact_match)}`);
}

export async function writeHtmlReport(
  payload: Record<string, unknown>,
  path: string,
): Promise<void> {
  const runs = (Array.isArray(payload.runs) ? payload.runs : []).filter(isRecord);
  const rows = runs.map((run) =>
    "<tr>" +
    `<td>${escapeHtml(run.app)}</td>` +
    `<td>${escapeHtml(run.scenario)}</td>` +
    `<td>${escapeHtml(run.skill_id)}</td>` +
    `<td>${escapeHtml(Array.isArray(run.detected_skills) ? run.detected_skills.join(", ") : "")}</td>` +
    `<td>${escapeHtml(run.trigger_exact_match)}</td>` +
    `<td>${escapeHtml(percent(run.trigger_recall))}</td>` +
    `<td>${escapeHtml(percent(run.trigger_precision))}</td>` +
    `<td>${escapeHtml(percent(run.uptake_rate))}</td>` +
    `<td>${escapeHtml(percent(run.evaluator_pct))}</td>` +
    "</tr>"
  );
  const skills = isRecord(payload.skills) ? payload.skills : {};
  const skillRows: string[] = [];
  const checkRows: string[] = [];
  for (const [skillId, rawResult] of Object.entries(skills)) {
    if (!isRecord(rawResult)) continue;
    const passed = rawResult.passed;
    const total = rawResult.total;
    skillRows.push(
      "<tr>" +
      `<td>${escapeHtml(skillId)}</td>` +
      `<td>${escapeHtml(rawResult.trigger_status)}</td>` +
      `<td>${escapeHtml(rawResult.uptake_status)}</td>` +
      `<td>${escapeHtml(passed === null || passed === undefined ? "n/a" : `${pythonDisplay(passed)}/${pythonDisplay(total)}`)}</td>` +
      `<td>${escapeHtml(percent(rawResult.uptake_rate))}</td>` +
      "</tr>",
    );
    const checks = Array.isArray(rawResult.checks) ? rawResult.checks : [];
    for (const rawCheck of checks) {
      if (!isRecord(rawCheck)) continue;
      checkRows.push(
        "<tr>" +
        `<td>${escapeHtml(skillId)}</td>` +
        `<td>${escapeHtml(rawCheck.id)}</td>` +
        `<td>${escapeHtml(rawCheck.status)}</td>` +
        `<td>${escapeHtml(rawCheck.evidence)}</td>` +
        "</tr>",
      );
    }
  }
  const document = `<!doctype html>
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
  <p>${escapeHtml(payload.summary ?? "")}</p>
  <p class="note">Initial v0 signal: trace trigger detection, static code uptake checks, and optional evaluator score. No LLM judge or screenshot evidence is used.</p>
  <table>
    <thead><tr><th>App</th><th>Scenario</th><th>Expected</th><th>Detected</th><th>Exact match</th><th>Recall</th><th>Precision</th><th>Uptake (pooled, legacy)</th><th>Evaluator</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
  <h2>Per-skill results</h2>
  <p class="note">Each expected skill's own trigger status and uptake, measured independently -- not the pooled number above.</p>
  <table>
    <thead><tr><th>Skill</th><th>Trigger</th><th>Uptake status</th><th>Passed/Total</th><th>Uptake rate</th></tr></thead>
    <tbody>${skillRows.join("")}</tbody>
  </table>
  <h2>Per-check detail</h2>
  <p class="note">Every check run per skill, including not_applicable (its precondition didn't hold for this app) and unavailable (evidence couldn't be collected, e.g. a parser didn't run) -- neither counts toward Passed/Total or Uptake rate above, but both are shown here rather than silently dropped.</p>
  <table>
    <thead><tr><th>Skill</th><th>Check</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody>${checkRows.join("")}</tbody>
  </table>
</body>
</html>
`;
  await Bun.write(path, document);
}

function findAppDir(root: string, files: string[]): string | null {
  const fileSet = new Set(files);
  for (const candidate of [
    path.join(root, "bundle", "app"),
    path.join(root, "app"),
  ]) {
    if (fileSet.has(path.join(candidate, "package.json"))) return candidate;
  }
  const workspacePackages = filesNamed(files, "package.json")
    .filter((candidate) => {
      const parts = path.relative(root, candidate).split(path.sep);
      return parts.length === 3 &&
        parts[0] === "agent-workspace" &&
        parts[2] === "package.json";
    })
    .sort(compareUnicodeCodePoints);
  if (workspacePackages[0] !== undefined) {
    return path.dirname(workspacePackages[0]);
  }
  const packages = filesNamed(files, "package.json").sort(
    compareUnicodeCodePoints,
  );
  for (const candidate of packages) {
    if (!candidate.split(path.sep).includes("node_modules")) {
      return path.dirname(candidate);
    }
  }
  return null;
}

function findTrace(files: string[]): string | null {
  for (const name of TRACE_CANDIDATES) {
    const match = files
      .filter((candidate) => path.basename(candidate) === name)
      .sort(compareUnicodeCodePoints)[0];
    if (match !== undefined) return match;
  }
  return null;
}

function firstExisting(
  root: string,
  preferred: string[],
  filename: string,
  files: string[],
): string | null {
  const fileSet = new Set(files);
  for (const relativePath of preferred) {
    const candidate = path.join(root, relativePath);
    if (fileSet.has(candidate)) return candidate;
  }
  return filesNamed(files, filename).sort(compareUnicodeCodePoints)[0] ?? null;
}

async function allFiles(root: string): Promise<string[]> {
  const visit = async (directory: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) return [];
      throw error;
    }
    entries.sort((left, right) =>
      compareUnicodeCodePoints(left.name, right.name)
    );
    const nested = await Promise.all(entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return await visit(candidate);
      return entry.isFile() ? [candidate] : [];
    }));
    return nested.flat();
  };
  return await visit(root);
}

function filesNamed(files: string[], filename: string): string[] {
  return files.filter((candidate) => path.basename(candidate) === filename);
}

async function readEvaluatorPct(resultPath: string): Promise<number | null> {
  const data = await readJsonAsync<Record<string, unknown>>(resultPath);
  if (data.macro_avg_pct !== null && data.macro_avg_pct !== undefined) {
    const value = Number(data.macro_avg_pct);
    if (Number.isFinite(value)) return value;
  }
  if (data.micro_pct !== null && data.micro_pct !== undefined) {
    const value = Number(data.micro_pct);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

async function collectBraintrustRefs(
  authorLayout: ArtifactLayout,
  evalLayout: ArtifactLayout | null,
  trace: NormalizedTrace,
): Promise<string[]> {
  const values = flattenStrings(trace).filter((item) =>
    item.toLowerCase().includes("braintrust")
  );
  const manifests = [
    authorLayout.manifestPath,
    evalLayout?.manifestPath ?? null,
  ];
  const manifestValues = await Promise.all(manifests.map(async (manifestPath) => {
    if (manifestPath === null || !await Bun.file(manifestPath).exists()) return [];
    try {
      return flattenStrings(await readJsonAsync<unknown>(manifestPath));
    } catch {
      // Malformed optional metadata is not fatal to analysis.
      return [];
    }
  }));
  for (const items of manifestValues) {
    for (const item of items) {
      if (item.toLowerCase().includes("braintrust")) values.push(item);
    }
  }
  return dedupe(values);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function values(rows: Array<Record<string, unknown>>, key: string): number[] {
  return rows.flatMap((row) => {
    const value = row[key];
    return value === null || value === undefined ? [] : [Number(value)];
  });
}

function average(numbers: number[]): number | null {
  if (numbers.length === 0) return null;
  return roundFloat(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function checkResultToJson(result: CheckResult): CheckJson {
  return {
    id: result.id,
    category: result.category,
    kind: result.kind,
    target: result.target,
    passed: result.passed,
    evidence: result.evidence,
    status: result.status,
  };
}

function scoreToJson(score: CaseRunScore): Record<string, unknown> {
  return {
    trigger_quality: {
      expected_skills: score.triggerQuality.expectedSkills,
      triggered_skills: score.triggerQuality.triggeredSkills,
      matched_skills: score.triggerQuality.matchedSkills,
      extra_skills: score.triggerQuality.extraSkills,
      missing_skills: score.triggerQuality.missingSkills,
      recall: score.triggerQuality.recall,
      precision: score.triggerQuality.precision,
      any_expo_skill_triggered: score.triggerQuality.anyExpoSkillTriggered,
    },
    context_uptake: {
      passed: score.contextUptake.passed,
      total: score.contextUptake.total,
      uptake_rate: score.contextUptake.uptakeRate,
      skipped_reason: score.contextUptake.skippedReason,
    },
    outcome_delta: {
      evaluator_pct: score.outcomeDelta.evaluatorPct,
      build_success: score.outcomeDelta.buildSuccess,
    },
  };
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function percent(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return String(value);
  return `${(numeric <= 1 ? numeric * 100 : numeric).toFixed(1)}%`;
}

function escapeHtml(value: unknown): string {
  const displayed = value === null || value === undefined ? "" : pythonDisplay(value);
  return displayed
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function pythonDisplay(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function pythonFloatDisplay(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "number" && Number.isInteger(value)) return `${value}.0`;
  return pythonDisplay(value);
}

function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value.replaceAll("'", "\\'")}'`;
  return pythonDisplay(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
