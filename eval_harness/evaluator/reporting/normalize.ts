import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  BuildHealthStage,
  ConsolidatedSummary,
  ReportInputs,
  StageStatus,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;
type ReadJsonResult = {
  path: string;
  raw: string | null;
  value: JsonRecord | null;
  error: string | null;
};

const STAGES = [
  ["app_authored", "App authored / required output present"],
  ["dependency_install", "Dependency install"],
  ["syntax", "Source syntax parse"],
  ["expo_export", "Expo iOS bundle export"],
  ["native_build", "Native iOS build"],
  ["app_launch", "App install and launch readiness"],
  ["evaluation", "iOS evaluation completion"],
] as const;

const STAGE_STATUSES = new Set<StageStatus>([
  "passed",
  "warning",
  "failed",
  "not_run",
]);

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stage(
  id: typeof STAGES[number][0],
  status: StageStatus = "not_run",
  detail: string | null = null,
  log: string | null = null,
): BuildHealthStage {
  const definition = STAGES.find(([candidate]) => candidate === id);
  return {
    id,
    label: definition?.[1] ?? id,
    status,
    detail,
    log,
  };
}

function producerStage(
  id: typeof STAGES[number][0],
  value: unknown,
): BuildHealthStage {
  const source = record(value);
  const sourceStatus = source?.status;
  const status = typeof sourceStatus === "string" &&
      STAGE_STATUSES.has(sourceStatus as StageStatus)
    ? sourceStatus as StageStatus
    : "not_run";
  return stage(
    id,
    status,
    stringOrNull(source?.detail),
    status === "not_run" ? null : stringOrNull(source?.log),
  );
}

async function ensureArtifactRoot(path: string, label: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} artifact path does not exist: ${path}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} artifact path must be a physical directory: ${path}`);
  }
  return await realpath(path);
}

async function readJson(root: string, name: string): Promise<ReadJsonResult> {
  const path = join(root, name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { path, raw: null, value: null, error: `${name} is missing` };
  }
  try {
    const value = record(JSON.parse(raw));
    return value === null
      ? { path, raw, value: null, error: `${name} must contain a JSON object` }
      : { path, raw, value, error: null };
  } catch {
    return { path, raw, value: null, error: `${name} is malformed JSON` };
  }
}

function validateManifest(
  source: ReadJsonResult,
  artifactType: string,
): string | null {
  if (source.error !== null) return source.error;
  if (source.value?.schema_version !== 2) {
    return `manifest.json has unsupported schema_version (expected 2)`;
  }
  if (source.value.artifact_type !== artifactType) {
    return `manifest.json has artifact_type=${String(source.value.artifact_type)} (expected ${artifactType})`;
  }
  return null;
}

function syntaxStage(metrics: JsonRecord | null): BuildHealthStage {
  const syntax = record(record(metrics?.build_health)?.syntax);
  if (syntax === null) return stage("syntax");
  if (syntax.ok === true) return stage("syntax", "passed");
  if (syntax.ok === false) {
    const failed = Array.isArray(syntax.failed_files) ? syntax.failed_files : [];
    return stage(
      "syntax",
      "failed",
      failed.length > 0
        ? `${failed.length} source file(s) failed syntax parsing`
        : "source syntax parsing failed",
    );
  }
  return stage("syntax", "warning", "source syntax result was unavailable");
}

function expoExportStage(
  metrics: JsonRecord | null,
  authorHealth: JsonRecord | null,
): BuildHealthStage {
  const produced = producerStage("expo_export", authorHealth?.expo_export);
  if (produced.status !== "not_run") return produced;
  const bundle = record(record(metrics?.build_health)?.bundle);
  if (bundle !== null) {
    if (bundle.ok === true) return stage("expo_export", "passed");
    if (bundle.ok === false || bundle.ok === null) {
      return stage(
        "expo_export",
        "warning",
        stringOrNull(bundle.reason) ?? "Expo export result was unavailable",
      );
    }
  }
  return produced;
}

function evaluationFailureDetail(result: JsonRecord | null): string | null {
  if (result === null) return null;
  const evaluatorErrors = Array.isArray(result.evaluator_errors)
    ? result.evaluator_errors
    : [];
  for (const rawError of evaluatorErrors) {
    const error = record(rawError);
    if (error === null) continue;
    const reason = stringOrNull(error.reason);
    const errorStage = stringOrNull(error.stage);
    if (reason !== null) return errorStage === null ? reason : `${errorStage}: ${reason}`;
  }
  const plans = Array.isArray(result.test_plans) ? result.test_plans : [];
  for (const rawPlan of plans) {
    const plan = record(rawPlan);
    if (plan?.status !== "evaluator_error") continue;
    return stringOrNull(plan.error_reason) ?? "iOS evaluator reported an infrastructure error";
  }
  return null;
}

function evaluationStage(
  manifestHealth: JsonRecord | null,
  result: JsonRecord | null,
  resultSupplied: boolean,
): BuildHealthStage {
  const manifestStage = producerStage("evaluation", manifestHealth?.evaluation);
  if (manifestStage.status === "failed") return manifestStage;
  const failure = evaluationFailureDetail(result);
  if (failure !== null || result?.status === "failed") {
    return stage(
      "evaluation",
      "failed",
      failure ?? "iOS evaluator reported failure",
      manifestStage.log,
    );
  }
  if (!resultSupplied) return manifestStage;
  if (result?.status === "completed") {
    return stage("evaluation", "passed", null, manifestStage.log);
  }
  if (result !== null) {
    return stage(
      "evaluation",
      "warning",
      `iOS evaluator result is non-terminal (${String(result.status ?? "missing status")})`,
      manifestStage.log,
    );
  }
  return manifestStage;
}

function normalizedSkills(metrics: JsonRecord | null): unknown[] {
  const source = metrics?.skills;
  if (Array.isArray(source)) return [...source];
  const byId = record(source);
  if (byId === null) return [];
  return Object.entries(byId)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([skillId, value]) => {
      const skill = record(value);
      return skill === null ? { skill_id: skillId, value } : { skill_id: skillId, ...skill };
    });
}

function normalizedPlans(result: JsonRecord | null): unknown[] {
  return Array.isArray(result?.test_plans)
    ? structuredClone(result.test_plans)
    : [];
}

function addWarnings(target: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const warning of value) {
    if (typeof warning === "string" && !target.includes(warning)) target.push(warning);
  }
}

function statusRank(status: ConsolidatedSummary["status"]): number {
  return status === "failed" ? 2 : status === "partial" ? 1 : 0;
}

function worseStatus(
  current: ConsolidatedSummary["status"],
  candidate: ConsolidatedSummary["status"],
): ConsolidatedSummary["status"] {
  return statusRank(candidate) > statusRank(current) ? candidate : current;
}

async function copyExactSource(
  source: ReadJsonResult,
  destination: string,
): Promise<boolean> {
  if (source.raw === null) return false;
  await copyFile(source.path, destination);
  return true;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runDetails(
  author: JsonRecord | null,
  skill: JsonRecord | null,
  iosManifest: JsonRecord | null,
): Record<string, unknown> {
  return {
    run_id: stringOrNull(author?.run_id),
    git_sha: stringOrNull(author?.git_sha),
    prd: stringOrNull(author?.prd),
    prompt_variant: stringOrNull(author?.prompt_variant),
    skill_scenario: stringOrNull(skill?.scenario) ?? stringOrNull(author?.scenario),
    author: {
      agent: stringOrNull(author?.agent),
      model: stringOrNull(author?.agent_model),
      effort: stringOrNull(author?.agent_reasoning_effort),
    },
    evaluator: {
      model: stringOrNull(iosManifest?.evaluator_model),
      effort: stringOrNull(iosManifest?.evaluator_reasoning_effort),
    },
  };
}

function numericUsage(value: unknown): Record<string, number | null> {
  const source = record(value);
  if (source === null) return {};
  const usage: Record<string, number | null> = {};
  for (const [key, rawValue] of Object.entries(source).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (rawValue === null || (typeof rawValue === "number" && Number.isFinite(rawValue))) {
      usage[key] = rawValue as number | null;
    }
  }
  return usage;
}

async function authorUsage(root: string, manifest: JsonRecord | null): Promise<Record<string, number | null>> {
  const tracePath = stringOrNull(record(manifest?.artifacts)?.author_trace);
  if (tracePath === null) return {};
  try {
    const physicalTrace = await containedRegularFile(root, tracePath);
    if (physicalTrace === null) return {};
    const trace = JSON.parse(await readFile(physicalTrace, "utf8")) as unknown;
    const traceRecord = record(trace);
    const sessions = Array.isArray(traceRecord?.sessions) ? traceRecord.sessions : [];
    const totals: Record<string, number> = {};
    for (const rawSession of sessions) {
      const session = record(rawSession);
      const turns = Array.isArray(session?.turns) ? session.turns : [];
      for (const rawTurn of turns) {
        for (const [key, value] of Object.entries(numericUsage(record(rawTurn)?.total_usage))) {
          if (value !== null) totals[key] = (totals[key] ?? 0) + value;
        }
      }
    }
    return totals;
  } catch {
    return {};
  }
}

async function evaluatorUsage(
  root: string | null,
  manifest: JsonRecord | null,
): Promise<Record<string, number | null>> {
  if (root === null) return {};
  const traceRoot = stringOrNull(record(manifest?.artifacts)?.test_plan_traces) ??
    "traces/test-plans/";
  const traces = await planTraceDirectories(root, traceRoot);
  const totals: Record<string, number> = {};
  for (const trace of traces) {
    for (const [key, value] of Object.entries(numericUsage(trace.summary.total_usage))) {
      if (value !== null) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

export async function normalizeRun(inputs: ReportInputs): Promise<ConsolidatedSummary> {
  const authoredRoot = await ensureArtifactRoot(inputs.authoredArtifact, "authored");
  const skillRoot = inputs.skillArtifact === null
    ? null
    : await ensureArtifactRoot(inputs.skillArtifact, "skill");
  const iosRoot = inputs.iosArtifact === null
    ? null
    : await ensureArtifactRoot(inputs.iosArtifact, "iOS");

  await mkdir(join(inputs.outDir, "data"), { recursive: true });
  await mkdir(join(inputs.outDir, "evidence", "screenshots"), { recursive: true });

  const warnings: string[] = [];
  let status: ConsolidatedSummary["status"] = "complete";

  const authorManifest = await readJson(authoredRoot, "manifest.json");
  const authorManifestError = validateManifest(authorManifest, "authored-app");
  if (authorManifestError !== null) {
    status = "failed";
    warnings.push(`authored artifact contract is invalid: ${authorManifestError}`);
  }
  await copyExactSource(
    authorManifest,
    join(inputs.outDir, "data", "author-manifest.json"),
  );
  const author = authorManifest.value;
  const authorHealth = record(author?.build_health);
  const authoredStage = producerStage("app_authored", authorHealth?.app_authored);
  if (authoredStage.status !== "passed") {
    status = "failed";
    warnings.push("authored app required-output gate did not pass");
  }

  let skillManifest: ReadJsonResult | null = null;
  let skillMetrics: ReadJsonResult | null = null;
  if (skillRoot === null) {
    warnings.push("skill evaluation was not supplied (disabled or unavailable)");
  } else {
    skillManifest = await readJson(skillRoot, "manifest.json");
    const manifestError = validateManifest(skillManifest, "skill-eval-report");
    if (manifestError !== null) {
      status = worseStatus(status, "partial");
      warnings.push(`skill artifact is incomplete: ${manifestError}`);
    }
    skillMetrics = await readJson(skillRoot, "metrics.json");
    if (skillMetrics.error !== null) {
      status = worseStatus(status, "partial");
      warnings.push(`skill artifact is missing authoritative metrics: ${skillMetrics.error}`);
    }
    await copyExactSource(
      skillMetrics,
      join(inputs.outDir, "data", "skill-metrics.json"),
    );
    if (
      author?.run_id !== null && author?.run_id !== undefined &&
      skillManifest.value?.run_id !== null && skillManifest.value?.run_id !== undefined &&
      author?.run_id !== skillManifest.value?.run_id
    ) {
      status = worseStatus(status, "partial");
      warnings.push("skill artifact run_id does not match the authored artifact");
    }
  }
  addWarnings(warnings, skillMetrics?.value?.warnings);

  let iosManifest: ReadJsonResult | null = null;
  let iosResult: ReadJsonResult | null = null;
  if (iosRoot === null) {
    warnings.push("iOS evaluation was not supplied (disabled or unavailable)");
  } else {
    iosManifest = await readJson(iosRoot, "manifest.json");
    const manifestError = validateManifest(iosManifest, "ios-eval-report");
    if (manifestError !== null) {
      status = worseStatus(status, "partial");
      warnings.push(`iOS artifact is incomplete: ${manifestError}`);
    }
    iosResult = await readJson(iosRoot, "result.json");
    if (iosResult.error !== null) {
      status = worseStatus(status, "partial");
      warnings.push(`iOS artifact is missing result.json`);
    }
    await copyExactSource(
      iosResult,
      join(inputs.outDir, "data", "ios-result.json"),
    );
    if (
      author?.run_id !== null && author?.run_id !== undefined &&
      iosManifest.value?.run_id !== null && iosManifest.value?.run_id !== undefined &&
      author?.run_id !== iosManifest.value?.run_id
    ) {
      status = worseStatus(status, "partial");
      warnings.push("iOS artifact run_id does not match the authored artifact");
    }
  }

  const metrics = skillMetrics?.value ?? null;
  const result = iosResult?.value ?? null;
  const iosHealth = record(iosManifest?.value?.build_health);
  const buildHealth: BuildHealthStage[] = [
    authoredStage,
    producerStage("dependency_install", iosHealth?.dependency_install),
    syntaxStage(metrics),
    expoExportStage(metrics, authorHealth),
    producerStage("native_build", iosHealth?.native_build),
    producerStage("app_launch", iosHealth?.app_launch),
    evaluationStage(iosHealth, result, iosResult?.raw !== null && iosResult !== null),
  ];

  if (buildHealth.some((item) => item.status === "failed")) status = "failed";
  const resultFailure = evaluationFailureDetail(result);
  if (resultFailure !== null) {
    status = "failed";
    if (!warnings.some((warning) => warning.includes(resultFailure))) {
      warnings.push(`iOS evaluator failed: ${resultFailure}`);
    }
  } else if (result !== null && result.status !== "completed") {
    status = worseStatus(status, "partial");
    warnings.push(`iOS evaluator result is non-terminal: ${String(result.status ?? "missing status")}`);
  }
  if (
    iosRoot !== null && status !== "failed" &&
    buildHealth
      .filter((item) => ["dependency_install", "native_build", "app_launch", "evaluation"].includes(item.id))
      .some((item) => item.status === "not_run")
  ) {
    status = worseStatus(status, "partial");
    warnings.push("iOS artifact contains a non-terminal build or evaluation stage");
  }

  const skillScore = record(metrics?.score);
  const triggerQuality = record(skillScore?.trigger_quality);
  const contextUptake = record(skillScore?.context_uptake);
  const summary: ConsolidatedSummary = {
    schema_version: 1,
    status,
    run: runDetails(author, metrics, iosManifest?.value ?? null),
    scores: {
      ios_macro_pct: result?.status === "completed" &&
          buildHealth[6]?.status === "passed"
        ? finiteNumberOrNull(result.macro_avg_pct)
        : null,
      skill_trigger_recall: finiteNumberOrNull(triggerQuality?.recall),
      skill_uptake_rate: finiteNumberOrNull(contextUptake?.uptake_rate),
    },
    build_health: buildHealth,
    skills: normalizedSkills(metrics),
    ios: { test_plans: normalizedPlans(result) },
    usage: {
      author: await authorUsage(authoredRoot, author),
      evaluator: await evaluatorUsage(iosRoot, iosManifest?.value ?? null),
    },
    warnings,
    artifacts: {
      author_manifest: authorManifest.raw === null ? null : "data/author-manifest.json",
      skill_metrics: skillMetrics?.raw === null || skillMetrics === null
        ? null
        : "data/skill-metrics.json",
      ios_result: iosResult?.raw === null || iosResult === null
        ? null
        : "data/ios-result.json",
      build_health: "data/build-health.json",
      screenshots: "evidence/screenshots/",
    },
  };

  await Promise.all([
    writeJson(join(inputs.outDir, "summary.json"), summary),
    writeJson(join(inputs.outDir, "data", "build-health.json"), buildHealth),
    writeJson(join(inputs.outDir, "manifest.json"), {
      schema_version: 1,
      artifact_type: "eval-report",
      run_id: stringOrNull(author?.run_id),
      artifacts: {
        report: "report.html",
        summary: "summary.json",
        data: "data/",
        screenshots: "evidence/screenshots/",
      },
    }),
  ]);
  return summary;
}

async function planTraceDirectories(
  iosRoot: string,
  testPlanTraces: string,
): Promise<Array<{ path: string; summary: JsonRecord }>> {
  const requestedRoot = resolve(iosRoot, testPlanTraces);
  if (!inside(iosRoot, requestedRoot)) return [];
  let root: string;
  try {
    const metadata = await lstat(requestedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return [];
    root = await realpath(requestedRoot);
    if (!inside(iosRoot, root)) return [];
  } catch {
    return [];
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories: Array<{ path: string; summary: JsonRecord }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    try {
      const summary = record(JSON.parse(await readFile(join(path, "summary.json"), "utf8")));
      if (summary !== null) directories.push({ path, summary });
    } catch {
      // A partial trace cannot safely resolve screenshot ownership.
    }
  }
  return directories;
}

function failedStep(stepValue: unknown): boolean {
  const step = record(stepValue);
  if (step === null) return false;
  if (typeof step.description === "string" && /^FAILED:/i.test(step.description)) return true;
  if (
    typeof step.points === "number" && typeof step.max_points === "number" &&
    step.points < step.max_points
  ) return true;
  for (const key of ["hard_assertions", "soft_assertions"] as const) {
    if (
      Array.isArray(step[key]) &&
      step[key].some((assertion) => record(assertion)?.passed === false)
    ) return true;
  }
  return false;
}

function safeSlug(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "test-plan";
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function containedRegularFile(
  root: string,
  reference: string,
): Promise<string | null> {
  const candidate = resolve(root, reference);
  if (!inside(root, candidate)) return null;
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
      return null;
    }
    const physical = await realpath(candidate);
    return inside(root, physical) ? physical : null;
  } catch {
    return null;
  }
}

function evidenceWarning(
  summary: ConsolidatedSummary,
  plan: JsonRecord,
  stepIndex: number,
  detail: string,
): void {
  summary.warnings.push(
    `screenshot for ${String(plan.test_plan ?? "unknown plan")} run ${String(plan.run_index ?? 1)} step ${stepIndex + 1} ${detail}`,
  );
}

export async function copyScreenshotEvidence(
  summary: ConsolidatedSummary,
  iosRoot: string,
  outDir: string,
): Promise<void> {
  const physicalIosRoot = await ensureArtifactRoot(iosRoot, "iOS");
  const manifest = await readJson(physicalIosRoot, "manifest.json");
  const traceRoot = stringOrNull(record(manifest.value?.artifacts)?.test_plan_traces) ??
    "traces/test-plans/";
  const traces = await planTraceDirectories(physicalIosRoot, traceRoot);
  const evidenceRoot = join(outDir, "evidence", "screenshots");
  await mkdir(evidenceRoot, { recursive: true });

  for (const rawPlan of summary.ios.test_plans) {
    const plan = record(rawPlan);
    if (plan === null) continue;
    const planName = stringOrNull(plan.test_plan) ?? "test-plan";
    const runIndex = typeof plan.run_index === "number" && Number.isInteger(plan.run_index)
      ? plan.run_index
      : 1;
    const matches = traces.filter(({ summary: traceSummary }) =>
      traceSummary.plan === planName || traceSummary.test_plan === planName
    );
    const exact = matches.find(({ summary: traceSummary }) =>
      traceSummary.run_index === runIndex
    );
    const trace = exact ?? matches[runIndex - 1] ?? null;
    const steps = Array.isArray(plan.steps) ? plan.steps : [];

    for (const [stepIndex, rawStep] of steps.entries()) {
      const step = record(rawStep);
      if (step === null || typeof step.screenshot !== "string") continue;
      const sourceReference = step.screenshot;
      step.screenshot = null;
      if (trace === null) {
        evidenceWarning(summary, plan, stepIndex, "has no matching plan trace");
        continue;
      }
      if (extname(sourceReference).toLowerCase() !== ".png") {
        evidenceWarning(summary, plan, stepIndex, "is not a PNG");
        continue;
      }
      const resolved = resolve(trace.path, sourceReference);
      if (!inside(physicalIosRoot, resolved)) {
        evidenceWarning(summary, plan, stepIndex, "resolves outside the iOS artifact");
        continue;
      }

      let sourceMetadata;
      try {
        sourceMetadata = await lstat(resolved);
      } catch {
        evidenceWarning(summary, plan, stepIndex, "does not exist");
        continue;
      }
      if (sourceMetadata.isSymbolicLink()) {
        evidenceWarning(summary, plan, stepIndex, "is a symbolic link");
        continue;
      }
      if (!sourceMetadata.isFile()) {
        evidenceWarning(summary, plan, stepIndex, "is not a regular file");
        continue;
      }
      if (sourceMetadata.nlink !== 1) {
        evidenceWarning(summary, plan, stepIndex, "has multiple hard links");
        continue;
      }
      let physicalSource;
      try {
        physicalSource = await realpath(resolved);
      } catch {
        evidenceWarning(summary, plan, stepIndex, "could not be physically resolved");
        continue;
      }
      if (!inside(physicalIosRoot, physicalSource)) {
        evidenceWarning(summary, plan, stepIndex, "resolves outside the iOS artifact");
        continue;
      }

      const stableName = `${safeSlug(planName)}-run-${String(runIndex).padStart(2, "0")}-step-${String(stepIndex + 1).padStart(2, "0")}.png`;
      await copyFile(physicalSource, join(evidenceRoot, stableName));
      step.screenshot = `evidence/screenshots/${stableName}`;
    }
    steps.sort((left, right) => Number(failedStep(right)) - Number(failedStep(left)));
  }

  await writeJson(join(outDir, "summary.json"), summary);
}
