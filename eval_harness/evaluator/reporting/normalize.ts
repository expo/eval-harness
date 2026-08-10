import {
  constants,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
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
import { skillsFromToolCall } from "../skill_invocation/uptake_checks/trigger.ts";
import { renderReport } from "./render.ts";

type JsonRecord = Record<string, unknown>;
type ReadJsonResult = {
  path: string;
  raw: Buffer | null;
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
  const path = resolve(root, name);
  if (!inside(root, path)) {
    throw new Error(`unsafe authoritative JSON path outside artifact: ${name}`);
  }
  try {
    const pathMetadata = await lstat(path);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.nlink !== 1) {
      throw new Error(`unsafe authoritative JSON file: ${name}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { path, raw: null, value: null, error: `${name} is missing` };
    }
    if (error instanceof Error && error.message.startsWith("unsafe authoritative JSON")) {
      throw error;
    }
    throw new Error(`unsafe authoritative JSON file: ${name}`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { path, raw: null, value: null, error: `${name} is missing` };
    }
    throw new Error(`unsafe authoritative JSON file: ${name}`);
  }
  let raw: Buffer | null = null;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`unsafe authoritative JSON file: ${name}`);
    }
    const physical = await realpath(path);
    if (!inside(root, physical)) {
      throw new Error(`unsafe authoritative JSON file outside artifact: ${name}`);
    }
    raw = await handle.readFile();
    const value = record(JSON.parse(raw.toString("utf8")));
    return value === null
      ? { path, raw, value: null, error: `${name} must contain a JSON object` }
      : { path, raw, value, error: null };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unsafe authoritative JSON")) {
      throw error;
    }
    return { path, raw, value: null, error: `${name} is malformed JSON` };
  } finally {
    await handle.close();
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
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

function validStageRecord(value: unknown): boolean {
  const source = record(value);
  return source !== null &&
    typeof source.status === "string" &&
    STAGE_STATUSES.has(source.status as StageStatus) &&
    (source.detail === null || typeof source.detail === "string") &&
    (source.log === null || typeof source.log === "string");
}

function validateAuthorFields(value: JsonRecord | null): string | null {
  const health = record(value?.build_health);
  if (
    typeof value?.run_id !== "string" || value.run_id.length === 0 ||
    health === null ||
    !validStageRecord(health.app_authored) ||
    !validStageRecord(health.expo_export) ||
    record(value.artifacts) === null
  ) {
    return "author manifest is missing required fields";
  }
  return null;
}

function validateSkillManifestFields(value: JsonRecord | null): string | null {
  const artifacts = record(value?.artifacts);
  if (
    artifacts?.metrics !== "metrics.json" || artifacts.report !== "report.html" ||
    !(value?.run_id === null || typeof value?.run_id === "string")
  ) {
    return "skill manifest is missing required fields";
  }
  return null;
}

function validateIosManifestFields(value: JsonRecord | null): string | null {
  const artifacts = record(value?.artifacts);
  const health = record(value?.build_health);
  if (
    typeof value?.run_id !== "string" || value.run_id.length === 0 ||
    artifacts?.result !== "result.json" ||
    typeof artifacts.test_plan_traces !== "string" ||
    health === null ||
    !validStageRecord(health.dependency_install) ||
    !validStageRecord(health.native_build) ||
    !validStageRecord(health.app_launch) ||
    !validStageRecord(health.evaluation)
  ) {
    return "iOS manifest is missing required fields";
  }
  return null;
}

function nullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validHardAssertion(value: unknown): boolean {
  const assertion = record(value);
  return assertion !== null && nonEmptyString(assertion.command) &&
    typeof assertion.fatal === "boolean" && typeof assertion.passed === "boolean";
}

function validSoftAssertion(value: unknown): boolean {
  const assertion = record(value);
  return assertion !== null && nonEmptyString(assertion.check) &&
    typeof assertion.fatal === "boolean" && typeof assertion.passed === "boolean" &&
    typeof assertion.evidence === "string";
}

function validIosStep(value: unknown): boolean {
  const step = record(value);
  if (step === null || !nonEmptyString(step.description) ||
    typeof step.points !== "number" || !Number.isFinite(step.points) ||
    typeof step.max_points !== "number" || !Number.isFinite(step.max_points) ||
    !nonNegativeInteger(step.iterations) ||
    !Array.isArray(step.hard_assertions) || !step.hard_assertions.every(validHardAssertion) ||
    !Array.isArray(step.soft_assertions) || !step.soft_assertions.every(validSoftAssertion) ||
    !nonNegativeInteger(step.hard_assertion_count) ||
    !nonNegativeInteger(step.soft_assertion_count) ||
    !nullableString(step.screenshot) || !nullableString(step.screenshot_error)
  ) return false;
  return step.hard_assertion_count === step.hard_assertions.length &&
    step.soft_assertion_count === step.soft_assertions.length;
}

function validTerminalEvidence(value: unknown): boolean {
  const evidence = record(value);
  return evidence !== null &&
    typeof evidence.step_number === "number" && Number.isInteger(evidence.step_number) &&
    evidence.step_number >= 1 && nonEmptyString(evidence.step_name) &&
    nullableString(evidence.screenshot) && nullableString(evidence.screenshot_error) &&
    (evidence.screenshot !== null || evidence.screenshot_error !== null);
}

function validEvaluatorError(value: unknown): boolean {
  const error = record(value);
  if (error === null || !nonEmptyString(error.stage) || !nonEmptyString(error.reason)) {
    return false;
  }
  const plan = error.test_plan;
  const run = error.run_index;
  return (plan === undefined || plan === null || nonEmptyString(plan)) &&
    (run === undefined || run === null ||
      (typeof run === "number" && Number.isInteger(run) && run >= 1));
}

function validateSkillMetricsFields(value: JsonRecord | null): string | null {
  const score = record(value?.score);
  const trigger = record(score?.trigger_quality);
  const uptake = record(score?.context_uptake);
  const health = record(value?.build_health);
  if (
    typeof value?.scenario !== "string" ||
    (value.outcome_status !== "complete" && value.outcome_status !== "pending") ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string") ||
    trigger === null || !("recall" in trigger) || !nullableFiniteNumber(trigger.recall) ||
    uptake === null || !("uptake_rate" in uptake) || !nullableFiniteNumber(uptake.uptake_rate) ||
    health === null || !("syntax" in health) || !("bundle" in health) ||
    record(value.skills) === null
  ) {
    return "skill metrics are missing required fields";
  }
  return null;
}

function validateIosResultFields(value: JsonRecord | null): string | null {
  const plans = value?.test_plans;
  if (
    (value?.status !== "completed" && value?.status !== "incomplete" && value?.status !== "failed") ||
    !nonNegativeInteger(value.expected_plan_count) ||
    !nonNegativeInteger(value.terminal_plan_count) ||
    value.terminal_plan_count > value.expected_plan_count ||
    !("macro_avg_pct" in value) || !nullableFiniteNumber(value.macro_avg_pct) ||
    !Array.isArray(value.evaluator_errors) ||
    !value.evaluator_errors.every(validEvaluatorError) ||
    (value.status === "completed" && value.evaluator_errors.length > 0) ||
    !Array.isArray(plans)
  ) {
    return "iOS result is missing required fields";
  }
  for (const rawPlan of plans) {
    const plan = record(rawPlan);
    const terminalEvidence = plan?.terminal_evidence;
    if (
      plan === null || !nonEmptyString(plan.test_plan) ||
      typeof plan.run_index !== "number" || !Number.isInteger(plan.run_index) ||
      plan.run_index < 1 ||
      !["completed", "not_applicable", "evaluator_error"].includes(String(plan.status)) ||
      !Array.isArray(plan.steps) || !plan.steps.every(validIosStep) ||
      (terminalEvidence !== undefined && (
        !Array.isArray(terminalEvidence) || !terminalEvidence.every(validTerminalEvidence)
      ))
    ) {
      return "iOS result test plans are missing required fields";
    }
    if (plan.status === "completed" && (
      typeof plan.score !== "number" || !Number.isFinite(plan.score) ||
      typeof plan.full_points !== "number" || !Number.isFinite(plan.full_points) ||
      typeof plan.macro_pct !== "number" || !Number.isFinite(plan.macro_pct)
    )) return "iOS result completed plans are missing required fields";
    if (plan.status === "not_applicable" && (
      typeof plan.na_reason !== "string" || plan.score !== 0 || plan.full_points !== 0 ||
      plan.macro_pct !== null || plan.steps.length !== 0
    )) return "iOS result N/A plans are missing required fields";
    if (plan.status !== "evaluator_error" &&
      Array.isArray(terminalEvidence) && terminalEvidence.length > 0
    ) return "iOS result terminal evidence is only valid for evaluator errors";
    if (plan.status === "evaluator_error" && (
      !nonEmptyString(plan.error_stage) || !nonEmptyString(plan.error_reason) ||
      plan.score !== null || plan.full_points !== null || plan.macro_pct !== null
    )) return "iOS result evaluator-error plans are missing required fields";
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
  resultValid: boolean,
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
  if (!resultValid) {
    return stage(
      "evaluation",
      "warning",
      "iOS result is structurally incomplete",
      manifestStage.log,
    );
  }
  if (result?.status === "completed") {
    const plans = Array.isArray(result.test_plans) ? result.test_plans : [];
    const allNotApplicable = plans.length > 0 && plans.every((rawPlan) =>
      record(rawPlan)?.status === "not_applicable"
    );
    const macro = finiteNumberOrNull(result.macro_avg_pct);
    if (!allNotApplicable && macro !== null && macro < 100) {
      return stage(
        "evaluation",
        "warning",
        `iOS behavior completed with partial credit (${macro}%)`,
        manifestStage.log,
      );
    }
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

function allIosPlansNotApplicable(result: JsonRecord | null): boolean {
  const plans = Array.isArray(result?.test_plans) ? result.test_plans : [];
  return plans.length > 0 && plans.every((rawPlan) =>
    record(rawPlan)?.status === "not_applicable"
  );
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
  await writeFile(destination, source.raw);
  return true;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runDetails(
  author: JsonRecord | null,
  skill: JsonRecord | null,
  iosManifest: JsonRecord | null,
  authorTelemetry: AuthorTraceTelemetry,
  inputs: ReportInputs,
): Record<string, unknown> {
  const authorDetails: Record<string, unknown> = {
    agent: stringOrNull(author?.agent),
    model: stringOrNull(author?.agent_model),
    effort: stringOrNull(author?.agent_reasoning_effort),
  };
  const cliVersion = authorTelemetry.cliVersion ?? stringOrNull(author?.muse_cli_version);
  if (cliVersion !== null) authorDetails.cli_version = cliVersion;
  if (authorTelemetry.toolCalls !== null) authorDetails.tool_calls = authorTelemetry.toolCalls;
  if (authorTelemetry.skillReads !== null) {
    authorDetails.skill_reads = authorTelemetry.skillReads;
  }
  return {
    run_id: stringOrNull(author?.run_id),
    git_sha: stringOrNull(author?.git_sha),
    prd: stringOrNull(author?.prd),
    prompt_variant: stringOrNull(author?.prompt_variant),
    skill_scenario: stringOrNull(skill?.scenario) ?? stringOrNull(author?.scenario),
    ...(inputs.iosJobStatus === undefined && inputs.skillJobStatus === undefined
      ? {}
      : {
        jobs: {
          ios: inputs.iosJobStatus ?? null,
          skill: inputs.skillJobStatus ?? null,
        },
      }),
    author: authorDetails,
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

export function validateConsolidatedSummary(
  value: unknown,
): asserts value is ConsolidatedSummary {
  const summary = record(value);
  const scores = record(summary?.scores);
  const ios = record(summary?.ios);
  const usage = record(summary?.usage);
  const authorUsageValue = record(usage?.author);
  const evaluatorUsageValue = record(usage?.evaluator);
  const artifacts = record(summary?.artifacts);
  const expectedStageIds = STAGES.map(([id]) => id);
  const health = Array.isArray(summary?.build_health) ? summary.build_health : null;
  const validUsage = (candidate: JsonRecord | null): boolean =>
    candidate !== null && Object.values(candidate).every(nullableFiniteNumber);
  const validArtifacts = artifacts !== null && Object.values(artifacts).every(
    (item) => item === null || typeof item === "string",
  ) && artifacts.author_manifest !== undefined &&
    artifacts.build_health === "data/build-health.json" &&
    artifacts.screenshots === "evidence/screenshots/" &&
    (artifacts.skill_metrics === null || artifacts.skill_metrics === "data/skill-metrics.json") &&
    (artifacts.ios_result === null || artifacts.ios_result === "data/ios-result.json");
  const validHealth = health !== null && health.length === STAGES.length &&
    health.every((rawStage, index) => {
      const item = record(rawStage);
      return item !== null && item.id === expectedStageIds[index] &&
        typeof item.label === "string" &&
        typeof item.status === "string" &&
        STAGE_STATUSES.has(item.status as StageStatus) &&
        (item.detail === null || typeof item.detail === "string") &&
        (item.log === null || typeof item.log === "string");
    });
  if (
    summary?.schema_version !== 1 ||
    !["complete", "partial", "failed"].includes(String(summary.status)) ||
    record(summary.run) === null || scores === null ||
    !nullableFiniteNumber(scores.ios_macro_pct) ||
    !nullableFiniteNumber(scores.skill_trigger_recall) ||
    !nullableFiniteNumber(scores.skill_uptake_rate) ||
    !validHealth || !Array.isArray(summary.skills) ||
    ios === null || !Array.isArray(ios.test_plans) ||
    !validUsage(authorUsageValue) || !validUsage(evaluatorUsageValue) ||
    !Array.isArray(summary.warnings) ||
    !summary.warnings.every((warning) => typeof warning === "string") ||
    !validArtifacts
  ) {
    throw new Error("invalid consolidated summary schema");
  }
}

type AuthorTraceTelemetry = {
  usage: Record<string, number | null>;
  toolCalls: number | null;
  skillReads: string[] | null;
  cliVersion: string | null;
};

async function authorTraceTelemetry(
  root: string,
  manifest: JsonRecord | null,
): Promise<AuthorTraceTelemetry> {
  const unavailable = (): AuthorTraceTelemetry => ({
    usage: {},
    toolCalls: null,
    skillReads: null,
    cliVersion: null,
  });
  const tracePath = stringOrNull(record(manifest?.artifacts)?.author_trace);
  if (tracePath === null) return unavailable();
  try {
    const traceBytes = await secureRegularBytes(root, tracePath, "author trace", true);
    if (traceBytes === null) return unavailable();
    const trace = JSON.parse(traceBytes.toString("utf8")) as unknown;
    const traceRecord = record(trace);
    if (traceRecord === null || !Array.isArray(traceRecord.sessions)) return unavailable();
    const agent = String(traceRecord?.agent ?? manifest?.agent ?? "").toLowerCase();
    const sessions = traceRecord.sessions;
    const totals: Record<string, number> = {};
    const skillReads = new Set<string>();
    let toolCalls = 0;
    let cliVersion: string | null = null;
    for (const rawSession of sessions) {
      const session = record(rawSession);
      cliVersion ??= stringOrNull(record(session?.session_meta)?.cli_version);
      const turns = Array.isArray(session?.turns) ? session.turns : [];
      for (const rawTurn of turns) {
        const turn = record(rawTurn);
        for (const [key, value] of Object.entries(numericUsage(turn?.total_usage))) {
          if (value !== null) totals[key] = (totals[key] ?? 0) + value;
        }
        const steps = Array.isArray(turn?.steps) ? turn.steps : [];
        for (const rawStep of steps) {
          const step = record(rawStep);
          const calls = Array.isArray(step?.tool_calls)
            ? step.tool_calls as unknown[]
            : [];
          toolCalls += calls.length;
          for (const rawCall of calls) {
            const call = record(rawCall);
            if (call === null) continue;
            for (const skillId of skillsFromToolCall(agent, {
              name: call.name,
              args: record(call.args),
            })) {
              skillReads.add(skillId);
            }
          }
        }
      }
    }
    return { usage: totals, toolCalls, skillReads: [...skillReads], cliVersion };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unsafe author trace")) {
      throw error;
    }
    return unavailable();
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

type OutputTarget = {
  path: string;
  parent: string;
  existed: boolean;
};

async function prepareOutputTarget(
  outDir: string,
  inputRoots: string[],
): Promise<OutputTarget> {
  const requested = resolve(outDir);
  for (const inputRoot of inputRoots) {
    if (inside(inputRoot, requested) || inside(requested, inputRoot)) {
      throw new Error(`output target must not overlap an input artifact: ${outDir}`);
    }
  }
  const requestedParent = dirname(requested);
  await mkdir(requestedParent, { recursive: true });
  const parentMetadata = await lstat(requestedParent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`output parent must be a physical directory: ${requestedParent}`);
  }
  const parent = await realpath(requestedParent);
  const target = join(parent, basename(requested));
  let existed = false;
  try {
    const metadata = await lstat(target);
    existed = true;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`output target must be a physical directory: ${outDir}`);
    }
    const physical = await realpath(target);
    if (physical !== target) {
      throw new Error(`output target must resolve to its physical directory: ${outDir}`);
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  for (const inputRoot of inputRoots) {
    if (inside(inputRoot, target) || inside(target, inputRoot)) {
      throw new Error(`output target must not overlap an input artifact: ${outDir}`);
    }
  }
  return { path: target, parent, existed };
}

async function publishFromCleanStage<T>(
  outDir: string,
  inputRoots: string[],
  generate: (stagingDir: string) => Promise<T>,
): Promise<T> {
  const target = await prepareOutputTarget(outDir, inputRoots);
  const staging = await mkdtemp(join(target.parent, `.${basename(target.path)}.staging-`));
  let backup: string | null = null;
  try {
    const generated = await generate(staging);
    if (target.existed) {
      backup = join(
        target.parent,
        `.${basename(target.path)}.backup-${crypto.randomUUID()}`,
      );
      await rename(target.path, backup);
    }
    try {
      await rename(staging, target.path);
    } catch (error) {
      if (backup !== null) await rename(backup, target.path);
      throw error;
    }
    if (backup !== null) await rm(backup, { recursive: true, force: true });
    return generated;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function normalizeInto(inputs: ReportInputs): Promise<ConsolidatedSummary> {
  const authoredRoot = await ensureArtifactRoot(inputs.authoredArtifact, "authored");
  const skillRoot = inputs.skillArtifact === null || inputs.skillJobStatus === "skipped"
    ? null
    : await ensureArtifactRoot(inputs.skillArtifact, "skill");
  const iosRoot = inputs.iosArtifact === null || inputs.iosJobStatus === "skipped"
    ? null
    : await ensureArtifactRoot(inputs.iosArtifact, "iOS");

  await mkdir(join(inputs.outDir, "data"), { recursive: true });
  await mkdir(join(inputs.outDir, "evidence", "screenshots"), { recursive: true });

  const warnings: string[] = [];
  let status: ConsolidatedSummary["status"] = "complete";

  const applyJobStatus = (
    label: "iOS evaluator" | "skill evaluator",
    jobStatus: ReportInputs["iosJobStatus"],
    artifactRoot: string | null,
  ): void => {
    if (jobStatus === "failure") {
      status = "failed";
      warnings.push(
        artifactRoot === null
          ? `${label} job failed and produced no usable artifact`
          : `${label} job failed`,
      );
    } else if (jobStatus === "success" && artifactRoot === null) {
      status = "failed";
      warnings.push(`successful ${label} job artifact is unavailable`);
    } else if (jobStatus === "skipped") {
      warnings.push(`${label} job was skipped`);
    }
  };
  applyJobStatus("iOS evaluator", inputs.iosJobStatus, iosRoot);
  applyJobStatus("skill evaluator", inputs.skillJobStatus, skillRoot);

  const authorManifest = await readJson(authoredRoot, "manifest.json");
  const authorManifestError = validateManifest(authorManifest, "authored-app");
  const authorFieldsError = validateAuthorFields(authorManifest.value);
  if (authorManifestError !== null || authorFieldsError !== null) {
    status = "failed";
    warnings.push(
      `authored artifact contract is invalid: ${authorManifestError ?? authorFieldsError}`,
    );
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
  let skillMetricsValid = false;
  if (skillRoot === null) {
    warnings.push("skill evaluation was not supplied (disabled or unavailable)");
  } else {
    skillManifest = await readJson(skillRoot, "manifest.json");
    const manifestError = validateManifest(skillManifest, "skill-eval-report");
    const manifestFieldsError = validateSkillManifestFields(skillManifest.value);
    if (manifestError !== null || manifestFieldsError !== null) {
      status = worseStatus(status, "partial");
      warnings.push(
        `skill artifact is incomplete: ${manifestError ?? manifestFieldsError}`,
      );
    }
    skillMetrics = await readJson(skillRoot, "metrics.json");
    if (skillMetrics.error !== null) {
      status = worseStatus(status, "partial");
      warnings.push(`skill artifact is missing authoritative metrics: ${skillMetrics.error}`);
    } else {
      const fieldsError = validateSkillMetricsFields(skillMetrics.value);
      if (fieldsError !== null) {
        status = worseStatus(status, "partial");
        warnings.push(`skill artifact required fields are invalid: ${fieldsError}`);
      } else {
        skillMetricsValid = true;
      }
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
  let iosResultValid = false;
  if (iosRoot === null) {
    warnings.push("iOS evaluation was not supplied (disabled or unavailable)");
  } else {
    iosManifest = await readJson(iosRoot, "manifest.json");
    const manifestError = validateManifest(iosManifest, "ios-eval-report");
    const manifestFieldsError = validateIosManifestFields(iosManifest.value);
    if (manifestError !== null || manifestFieldsError !== null) {
      status = worseStatus(status, "partial");
      warnings.push(
        `iOS artifact is incomplete: ${manifestError ?? manifestFieldsError}`,
      );
    }
    iosResult = await readJson(iosRoot, "result.json");
    if (iosResult.error !== null) {
      status = worseStatus(status, "partial");
      warnings.push(`iOS artifact is missing result.json`);
    } else {
      const fieldsError = validateIosResultFields(iosResult.value);
      if (fieldsError !== null) {
        status = worseStatus(status, "partial");
        warnings.push(`iOS artifact required fields are invalid: ${fieldsError}`);
      } else {
        iosResultValid = true;
      }
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
  let evaluatorStage = evaluationStage(
    iosHealth,
    result,
    iosResult?.raw !== null && iosResult !== null,
    iosResultValid,
  );
  if (inputs.iosJobStatus === "failure") {
    evaluatorStage = stage("evaluation", "failed", "The EAS iOS evaluator job failed.", evaluatorStage.log);
  } else if (inputs.iosJobStatus === "success" && iosRoot === null) {
    evaluatorStage = stage("evaluation", "failed", "The successful EAS iOS evaluator job artifact is unavailable.");
  } else if (inputs.iosJobStatus === "skipped") {
    evaluatorStage = stage("evaluation", "not_run", "The EAS iOS evaluator job was disabled.");
  }
  const buildHealth: BuildHealthStage[] = [
    authoredStage,
    producerStage("dependency_install", iosHealth?.dependency_install),
    syntaxStage(metrics),
    expoExportStage(metrics, authorHealth),
    producerStage("native_build", iosHealth?.native_build),
    producerStage("app_launch", iosHealth?.app_launch),
    evaluatorStage,
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

  const skillScore = skillMetricsValid ? record(metrics?.score) : null;
  const triggerQuality = record(skillScore?.trigger_quality);
  const contextUptake = record(skillScore?.context_uptake);
  const authorTelemetry = await authorTraceTelemetry(authoredRoot, author);
  const summary: ConsolidatedSummary = {
    schema_version: 1,
    status,
    run: runDetails(author, metrics, iosManifest?.value ?? null, authorTelemetry, inputs),
    scores: {
      ios_macro_pct: inputs.iosJobStatus !== "failure" && inputs.iosJobStatus !== "skipped" &&
          iosResultValid && result?.status === "completed" &&
          !allIosPlansNotApplicable(result) &&
          [buildHealth[1], buildHealth[4], buildHealth[5]].every(
            (item) => item?.status === "passed",
          ) &&
          (buildHealth[6]?.status === "passed" || buildHealth[6]?.status === "warning")
        ? finiteNumberOrNull(result.macro_avg_pct)
        : null,
      skill_trigger_recall: inputs.skillJobStatus === "failure" || inputs.skillJobStatus === "skipped"
        ? null
        : finiteNumberOrNull(triggerQuality?.recall),
      skill_uptake_rate: inputs.skillJobStatus === "failure" || inputs.skillJobStatus === "skipped"
        ? null
        : finiteNumberOrNull(contextUptake?.uptake_rate),
    },
    build_health: buildHealth,
    skills: normalizedSkills(skillMetricsValid ? metrics : null),
    ios: { test_plans: normalizedPlans(iosResultValid ? result : null) },
    usage: {
      author: authorTelemetry.usage,
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

  validateConsolidatedSummary(summary);

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

export async function normalizeRun(inputs: ReportInputs): Promise<ConsolidatedSummary> {
  const authoredRoot = await ensureArtifactRoot(inputs.authoredArtifact, "authored");
  const skillRoot = inputs.skillArtifact === null || inputs.skillJobStatus === "skipped"
    ? null
    : await ensureArtifactRoot(inputs.skillArtifact, "skill");
  const iosRoot = inputs.iosArtifact === null || inputs.iosJobStatus === "skipped"
    ? null
    : await ensureArtifactRoot(inputs.iosArtifact, "iOS");
  const roots = [authoredRoot, skillRoot, iosRoot].filter(
    (root): root is string => root !== null,
  );
  return await publishFromCleanStage(inputs.outDir, roots, async (stagingDir) =>
    await normalizeInto({
      authoredArtifact: authoredRoot,
      skillArtifact: skillRoot,
      iosArtifact: iosRoot,
      outDir: stagingDir,
      ...(inputs.skillJobStatus === undefined ? {} : { skillJobStatus: inputs.skillJobStatus }),
      ...(inputs.iosJobStatus === undefined ? {} : { iosJobStatus: inputs.iosJobStatus }),
    })
  );
}

function validPlanTraceSummary(value: JsonRecord): boolean {
  const plan = stringOrNull(value.plan) ?? stringOrNull(value.test_plan);
  const baseValid = plan !== null && plan.length > 0 &&
    typeof value.platform === "string" && value.platform.length > 0 &&
    record(value.total_usage) !== null &&
    Array.isArray(value.steps) &&
    (value.run_index === undefined ||
      (typeof value.run_index === "number" && Number.isInteger(value.run_index) &&
        value.run_index >= 1));
  if (!baseValid) return false;
  if (value.status === "evaluator_error") {
    return value.score === null && value.full_points === null &&
      nonEmptyString(value.error_stage) && nonEmptyString(value.error_reason) &&
      Array.isArray(value.terminal_evidence) &&
      value.terminal_evidence.every(validTerminalEvidence);
  }
  return typeof value.score === "number" && Number.isFinite(value.score) &&
    typeof value.full_points === "number" && Number.isFinite(value.full_points);
}

async function planTraceDirectories(
  iosRoot: string,
  testPlanTraces: string,
): Promise<Array<{ path: string; summary: JsonRecord }>> {
  const requestedRoot = resolve(iosRoot, testPlanTraces);
  if (!inside(iosRoot, requestedRoot)) {
    throw new Error("unsafe plan trace root outside iOS artifact");
  }
  let root: string;
  try {
    const metadata = await lstat(requestedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("unsafe plan trace root must be a physical directory");
    }
    root = await realpath(requestedRoot);
    if (!inside(iosRoot, root)) {
      throw new Error("unsafe plan trace root outside iOS artifact");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unsafe plan trace")) {
      throw error;
    }
    if (!isMissingPathError(error)) throw error;
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
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`unsafe plan trace directory: ${entry.name}`);
    }
    const path = join(root, entry.name);
    const physical = await realpath(path);
    if (!inside(iosRoot, physical) || physical !== path) {
      throw new Error(`unsafe plan trace directory: ${entry.name}`);
    }
    const source = await readJson(physical, "summary.json");
    if (source.value === null || !validPlanTraceSummary(source.value)) continue;
    directories.push({ path: physical, summary: source.value });
  }
  return directories;
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

async function secureRegularBytes(
  root: string,
  reference: string,
  label: string,
  optional = false,
): Promise<Buffer | null> {
  const candidate = resolve(root, reference);
  if (!inside(root, candidate)) throw new Error(`unsafe ${label} path`);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (optional && isMissingPathError(error)) return null;
    throw new Error(`unsafe ${label}: missing file`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new Error(`unsafe ${label}: expected physical regular single-link file`);
  }
  const physical = await realpath(candidate);
  if (!inside(root, physical)) throw new Error(`unsafe ${label} physical path`);
  const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error(`unsafe ${label}: expected physical regular single-link file`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function requirePhysicalContainedDirectory(
  root: string,
  reference: string,
  label: string,
): Promise<string> {
  const candidate = resolve(root, reference);
  if (!inside(root, candidate)) throw new Error(`unsafe ${label} path`);
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`unsafe ${label}: expected physical directory`);
  }
  const physical = await realpath(candidate);
  if (!inside(root, physical) || physical !== candidate) {
    throw new Error(`unsafe ${label} physical path`);
  }
  return physical;
}

async function cloneMachineReport(sourceRoot: string, stagingRoot: string): Promise<void> {
  const allowedRoot = new Set(["manifest.json", "summary.json", "data", "evidence", "report.html"]);
  const rootEntries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!allowedRoot.has(entry.name)) {
      throw new Error(`unsafe output inventory entry: ${entry.name}`);
    }
  }
  await mkdir(join(stagingRoot, "data"), { recursive: true });
  await mkdir(join(stagingRoot, "evidence", "screenshots"), { recursive: true });
  for (const name of ["manifest.json", "summary.json"] as const) {
    const bytes = await secureRegularBytes(sourceRoot, name, `output ${name}`);
    await writeFile(join(stagingRoot, name), bytes!);
  }
  const report = await secureRegularBytes(
    sourceRoot,
    "report.html",
    "output report.html",
    true,
  );
  if (report !== null) await writeFile(join(stagingRoot, "report.html"), report);

  const dataRoot = await requirePhysicalContainedDirectory(sourceRoot, "data", "output data");
  const allowedData = new Set([
    "author-manifest.json",
    "build-health.json",
    "skill-metrics.json",
    "ios-result.json",
  ]);
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    if (!allowedData.has(entry.name)) {
      throw new Error(`unsafe output data entry: ${entry.name}`);
    }
    const bytes = await secureRegularBytes(dataRoot, entry.name, `output data/${entry.name}`);
    await writeFile(join(stagingRoot, "data", entry.name), bytes!);
  }
  const evidence = await requirePhysicalContainedDirectory(
    sourceRoot,
    "evidence",
    "output evidence",
  );
  const evidenceEntries = await readdir(evidence, { withFileTypes: true });
  if (evidenceEntries.length !== 1 || evidenceEntries[0]?.name !== "screenshots") {
    throw new Error("unsafe output evidence inventory");
  }
  const screenshots = await requirePhysicalContainedDirectory(
    sourceRoot,
    "evidence/screenshots",
    "output screenshots",
  );
  for (const entry of await readdir(screenshots, { withFileTypes: true })) {
    await secureRegularBytes(screenshots, entry.name, `output screenshot ${entry.name}`);
  }
}

function evidenceWarning(
  summary: ConsolidatedSummary,
  plan: JsonRecord,
  stepNumber: number,
  detail: string,
): void {
  summary.warnings.push(
    `screenshot for ${String(plan.test_plan ?? "unknown plan")} run ${String(plan.run_index ?? 1)} step ${stepNumber} ${detail}`,
  );
}

function unsafeEvidence(detail: string): never {
  throw new Error(`unsafe screenshot evidence: ${detail}`);
}

function planHasScreenshot(plan: JsonRecord): boolean {
  const scored = Array.isArray(plan.steps) && plan.steps.some((rawStep) =>
    typeof record(rawStep)?.screenshot === "string"
  );
  const terminal = Array.isArray(plan.terminal_evidence) &&
    plan.terminal_evidence.some((rawEvidence) =>
      typeof record(rawEvidence)?.screenshot === "string"
    );
  return scored || terminal;
}

function associatePlanTraces(
  plans: unknown[],
  traces: Array<{ path: string; summary: JsonRecord }>,
): Map<number, { path: string; summary: JsonRecord }> {
  const associations = new Map<number, { path: string; summary: JsonRecord }>();
  const planGroups = new Map<string, number[]>();
  for (const [index, rawPlan] of plans.entries()) {
    const plan = record(rawPlan);
    if (plan === null || typeof plan.test_plan !== "string") continue;
    const group = planGroups.get(plan.test_plan) ?? [];
    group.push(index);
    planGroups.set(plan.test_plan, group);
  }
  for (const trace of traces) {
    const tracePlan = stringOrNull(trace.summary.plan) ?? stringOrNull(trace.summary.test_plan);
    if (tracePlan === null) {
      throw new Error("ambiguous plan trace ownership: trace summary has no plan");
    }
    if (!planGroups.has(tracePlan)) {
      throw new Error(`ambiguous plan trace ownership: unmatched trace for ${tracePlan}`);
    }
  }
  for (const [planName, planIndexes] of planGroups) {
    const matchingTraces = traces.filter(({ summary: traceSummary }) =>
      traceSummary.plan === planName || traceSummary.test_plan === planName
    );
    const indexed = matchingTraces.filter(({ summary }) =>
      typeof summary.run_index === "number" && Number.isInteger(summary.run_index)
    );
    const positional = matchingTraces.filter(({ summary }) => summary.run_index === undefined);
    const referenced = planIndexes.some((index) => {
      const plan = record(plans[index]);
      return plan !== null && planHasScreenshot(plan);
    });
    if (indexed.length > 0) {
      if (positional.length > 0 || indexed.length !== planIndexes.length) {
        throw new Error(`ambiguous plan trace ownership for ${planName}`);
      }
      for (const planIndex of planIndexes) {
        const plan = record(plans[planIndex]);
        const runIndex = plan?.run_index;
        const candidates = indexed.filter(({ summary }) => summary.run_index === runIndex);
        if (candidates.length !== 1) {
          throw new Error(`ambiguous plan trace ownership for ${planName} run ${String(runIndex)}`);
        }
        associations.set(planIndex, candidates[0]!);
      }
    } else if (positional.length > 0) {
      if (positional.length !== planIndexes.length) {
        throw new Error(`ambiguous plan trace ownership for ${planName}`);
      }
      for (const [offset, planIndex] of planIndexes.entries()) {
        associations.set(planIndex, positional[offset]!);
      }
    } else if (referenced) {
      // Missing capture evidence is non-fatal, but no positional guess is made.
    }
  }
  return associations;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function copyScreenshotEvidenceInto(
  summary: ConsolidatedSummary,
  iosRoot: string,
  outDir: string,
): Promise<void> {
  const physicalIosRoot = await ensureArtifactRoot(iosRoot, "iOS");
  const manifest = await readJson(physicalIosRoot, "manifest.json");
  const traceRoot = stringOrNull(record(manifest.value?.artifacts)?.test_plan_traces) ??
    "traces/test-plans/";
  const traces = await planTraceDirectories(physicalIosRoot, traceRoot);
  const associations = associatePlanTraces(summary.ios.test_plans, traces);
  const evidenceRoot = join(outDir, "evidence", "screenshots");
  await mkdir(evidenceRoot, { recursive: true });
  const destinations = new Set<string>();

  for (const [planIndex, rawPlan] of summary.ios.test_plans.entries()) {
    const plan = record(rawPlan);
    if (plan === null) continue;
    const planName = stringOrNull(plan.test_plan) ?? "test-plan";
    const runIndex = typeof plan.run_index === "number" && Number.isInteger(plan.run_index)
      ? plan.run_index
      : 1;
    const trace = associations.get(planIndex) ?? null;
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const terminalEvidence = Array.isArray(plan.terminal_evidence)
      ? plan.terminal_evidence
      : [];
    const references = [
      ...steps.map((rawEvidence, index) => ({ rawEvidence, stepNumber: index + 1 })),
      ...terminalEvidence.map((rawEvidence) => {
        const evidence = record(rawEvidence);
        return {
          rawEvidence,
          stepNumber: typeof evidence?.step_number === "number" &&
              Number.isInteger(evidence.step_number)
            ? evidence.step_number
            : 1,
        };
      }),
    ];

    for (const { rawEvidence, stepNumber } of references) {
      const evidence = record(rawEvidence);
      if (evidence === null || typeof evidence.screenshot !== "string") continue;
      const sourceReference = evidence.screenshot;
      evidence.screenshot = null;
      if (trace === null) {
        evidenceWarning(summary, plan, stepNumber, "has no matching plan trace");
        continue;
      }
      if (extname(sourceReference).toLowerCase() !== ".png") {
        unsafeEvidence("referenced file is not a PNG");
      }
      const resolved = resolve(trace.path, sourceReference);
      if (!inside(physicalIosRoot, resolved)) {
        unsafeEvidence("referenced file resolves outside the iOS artifact");
      }

      let sourceMetadata;
      try {
        sourceMetadata = await lstat(resolved);
      } catch (error) {
        if (isMissingPathError(error)) {
          evidenceWarning(summary, plan, stepNumber, "does not exist");
          continue;
        }
        unsafeEvidence("referenced file metadata could not be read");
      }
      if (sourceMetadata.isSymbolicLink()) {
        unsafeEvidence("referenced file is a symbolic link");
      }
      if (!sourceMetadata.isFile()) {
        unsafeEvidence("referenced file is not a regular file");
      }
      if (sourceMetadata.nlink !== 1) {
        unsafeEvidence("referenced file has multiple hard links");
      }
      let physicalSource;
      try {
        physicalSource = await realpath(resolved);
      } catch (error) {
        if (isMissingPathError(error)) {
          evidenceWarning(summary, plan, stepNumber, "could not be physically resolved");
          continue;
        }
        unsafeEvidence("referenced file could not be physically resolved");
      }
      if (!inside(physicalIosRoot, physicalSource)) {
        unsafeEvidence("referenced file resolves outside the iOS artifact");
      }

      const stableName = `${safeSlug(planName)}-run-${String(runIndex).padStart(2, "0")}-step-${String(stepNumber).padStart(2, "0")}.png`;
      if (destinations.has(stableName)) {
        throw new Error(`evidence destination collision: ${stableName}`);
      }
      destinations.add(stableName);
      const bytes = await secureRegularBytes(
        physicalIosRoot,
        relative(physicalIosRoot, physicalSource),
        "screenshot evidence",
      );
      if (bytes === null) unsafeEvidence("referenced file disappeared");
      if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        unsafeEvidence("invalid PNG signature");
      }
      await writeFile(join(evidenceRoot, stableName), bytes);
      evidence.screenshot = `evidence/screenshots/${stableName}`;
    }
  }

  validateConsolidatedSummary(summary);
  await writeJson(join(outDir, "summary.json"), summary);
}

export async function copyScreenshotEvidence(
  summary: ConsolidatedSummary,
  iosRoot: string,
  outDir: string,
): Promise<void> {
  validateConsolidatedSummary(summary);
  const physicalIosRoot = await ensureArtifactRoot(iosRoot, "iOS");
  const working = structuredClone(summary);
  await publishFromCleanStage(outDir, [physicalIosRoot], async (stagingDir) => {
    const currentOutput = await ensureArtifactRoot(outDir, "output");
    await cloneMachineReport(currentOutput, stagingDir);
    await copyScreenshotEvidenceInto(working, physicalIosRoot, stagingDir);
  });
  for (const key of Object.keys(summary)) delete (summary as unknown as JsonRecord)[key];
  Object.assign(summary, working);
}

export async function normalizeRunWithEvidence(
  inputs: ReportInputs,
  renderer: (summary: ConsolidatedSummary) => string = renderReport,
): Promise<ConsolidatedSummary> {
  const authoredRoot = await ensureArtifactRoot(inputs.authoredArtifact, "authored");
  const skillRoot = inputs.skillArtifact === null || inputs.skillJobStatus === "skipped"
    ? null
    : await ensureArtifactRoot(inputs.skillArtifact, "skill");
  const iosRoot = inputs.iosArtifact === null || inputs.iosJobStatus === "skipped"
    ? null
    : await ensureArtifactRoot(inputs.iosArtifact, "iOS");
  const roots = [authoredRoot, skillRoot, iosRoot].filter(
    (root): root is string => root !== null,
  );
  return await publishFromCleanStage(inputs.outDir, roots, async (stagingDir) => {
    const summary = await normalizeInto({
      authoredArtifact: authoredRoot,
      skillArtifact: skillRoot,
      iosArtifact: iosRoot,
      outDir: stagingDir,
      ...(inputs.skillJobStatus === undefined ? {} : { skillJobStatus: inputs.skillJobStatus }),
      ...(inputs.iosJobStatus === undefined ? {} : { iosJobStatus: inputs.iosJobStatus }),
    });
    if (iosRoot !== null) {
      await copyScreenshotEvidenceInto(summary, iosRoot, stagingDir);
    }
    validateConsolidatedSummary(summary);
    await writeFile(join(stagingDir, "report.html"), renderer(summary), "utf8");
    return summary;
  });
}
