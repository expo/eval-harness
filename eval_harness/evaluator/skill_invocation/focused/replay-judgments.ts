import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CALIBRATION, SIGNING_RUBRIC, parseJudgment } from "./advice-judge.ts";
import { inside } from "./cases.ts";
import { writeReport, type Attempt } from "./report.ts";

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

// Re-validate saved evidence, without running authored code or calling any model.
// Write a derived artifact so the original CI evidence and exit status survive.
export function replayJudgments(source: string, destination: string): void {
  source = resolve(source);
  destination = resolve(destination);
  const rel = relative(source, destination);
  if (
    !rel ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) ||
    existsSync(destination)
  )
    throw new Error(
      "Replay destination must be new and outside the source artifact",
    );
  const metrics = read(join(source, "metrics.json"));
  const sourceMetricsHash = sha(metrics);
  const calibration = read(join(source, "judge-calibration.json"));
  if (
    !calibration.calibrated ||
    JSON.stringify(calibration.rubric) !== JSON.stringify(SIGNING_RUBRIC)
  )
    throw new Error("Saved calibration did not pass or uses another rubric");
  for (const sample of CALIBRATION) {
    const raw = read(join(source, "judge-calibration", sample.id, "raw.json"));
    if (
      raw.subtype !== "success" ||
      raw.is_error ||
      !parseJudgment(raw.structured_output, sample.answer).every(
        (row, i) => row.status === sample.expected[i],
      )
    )
      throw new Error(`Saved calibration is invalid: ${sample.id}`);
  }
  const recovered: string[] = [];
  const attempts: Attempt[] = metrics.attempts;
  for (const run of attempts.filter(
    (attempt) =>
      attempt.id === "signing-diagnosis" && attempt.status === "complete",
  )) {
    const path = inside(
      source,
      run.artifact_path ?? `${run.id}/${run.attempt}`,
    );
    const raw = read(join(path, "judge/raw.json"));
    const input = read(join(path, "judge/input.json"));
    if (
      JSON.stringify(input.criteria) !==
        JSON.stringify(
          SIGNING_RUBRIC.map((criterion, i) => ({
            id: `review:${i + 1}`,
            criterion,
          })),
        ) ||
      input.answer !== run.observation.final ||
      raw.subtype !== "success" ||
      raw.is_error
    )
      throw new Error(
        `Saved judge answer mismatch or unsuccessful result: ${run.artifact_path}`,
      );
    const checks = parseJudgment(raw.structured_output, run.observation.final);
    const manifest = read(join(path, "manifest.json"));
    if (manifest.adapter !== "claude-focused-v2")
      throw new Error("Unsupported author manifest");
    // The author manifest includes config plus these per-attempt fields. Verify
    // reconstruction against the original condition before changing judge metadata.
    const config = { ...manifest };
    for (const key of [
      "skill_mode",
      "plugin_hash",
      "intended_skills",
      "catalog_visibility",
      "attempt",
      "started_at",
    ])
      delete config[key];
    const author = sha({ ...config, resolved_model: run.observation.model });
    const condition = (models: string[]) =>
      sha({
        author,
        judge_model: calibration.model,
        resolved_models: models,
        rubric: SIGNING_RUBRIC,
        calibrated: true,
      });
    if (
      !run.judgment ||
      condition(run.judgment.resolved_models) !== run.condition
    )
      throw new Error(
        `Cannot reconstruct saved comparison condition: ${run.artifact_path}`,
      );
    if (run.judgment.status !== "graded")
      recovered.push(run.artifact_path ?? `${run.id}/${run.attempt}`);
    run.checks = [
      ...run.checks.filter((check) => !check.id.startsWith("review:")),
      ...checks,
    ];
    run.judgment = {
      status: "graded",
      requested_model: calibration.model,
      resolved_models: Object.keys(raw.modelUsage ?? {}),
      cost_usd:
        typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null,
      evidence:
        "Saved provisional model judgment revalidated offline; only bold/whitespace quote differences are ignored. No model calls or author reruns.",
    };
    run.condition = condition(run.judgment.resolved_models);
  }
  cpSync(source, destination, { recursive: true });
  writeFileSync(
    join(destination, "replay.json"),
    JSON.stringify(
      {
        source_metrics_sha256: sourceMetricsHash,
        quote_validation: "bold-whitespace-v1",
        replayed_at: new Date().toISOString(),
        recovered,
        model_calls: 0,
        note: "Derived report from saved judge responses. Original CI run remains errored; this is not a successful CI rerun.",
      },
      null,
      2,
    ),
  );
  writeReport(destination, attempts);
}
