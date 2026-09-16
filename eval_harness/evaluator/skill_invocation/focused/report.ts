import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdviceJudgment } from "./advice-judge.ts";
import { OUTCOME_CHECKS, type Check } from "./outcomes.ts";
import type { RoutingRow, Observation } from "./trace.ts";

export type Attempt = {
  id: string;
  family: string;
  attempt: number;
  condition: string;
  plugin_hash: string;
  skill_mode?: "with-expo" | "without-expo";
  artifact_path?: string;
  status: "complete" | "infrastructure_error";
  duration_ms: number;
  routing: RoutingRow[];
  checks: Check[];
  judgment?: AdviceJudgment;
  observation: Observation;
};
export const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
export function routingVerdict(
  attempt: Attempt,
): "passed" | "failed" | "inconclusive" | "not_applicable" {
  if (attempt.status !== "complete") return "inconclusive";
  if (attempt.skill_mode === "without-expo") return "not_applicable";
  if (
    attempt.routing.some((row) =>
      ["not_selected", "load_failed", "loaded_late", "forbidden_load"].includes(
        row.status,
      ),
    )
  )
    return "failed";
  return attempt.routing.some((row) => row.status === "unobservable")
    ? "inconclusive"
    : "passed";
}
export function outcomeVerdict(
  attempt: Attempt,
): "passed" | "failed" | "pending" | "unavailable" {
  if (attempt.status !== "complete") return "unavailable";
  if (attempt.checks.some((check) => check.status === "failed"))
    return "failed";
  if (attempt.judgment && attempt.judgment.status !== "graded")
    return "unavailable";
  if (attempt.checks.some((check) => check.status === "unavailable"))
    return "unavailable";
  if (attempt.checks.some((check) => check.status === "pending"))
    return "pending";
  // Syntax/preservation alone do not establish the requested repair or advice.
  if (
    attempt.judgment?.status === "graded" &&
    ["review:1", "review:2", "review:3"].every((id) =>
      attempt.checks.some((check) => check.id === id),
    )
  )
    return "passed";
  const groups = Object.values(OUTCOME_CHECKS);
  const applicable = groups.filter((ids) =>
    ids.some((id) => attempt.checks.some((check) => check.id === id)),
  );
  if (!applicable.length) return "pending";
  if (
    applicable.some(
      (ids) =>
        !ids.every((id) => attempt.checks.some((check) => check.id === id)),
    )
  )
    return "unavailable";
  return "passed";
}

export function summarize(attempts: Attempt[]) {
  const keys = [
    ...new Set(
      attempts.map((run) => `${run.id}:${run.skill_mode ?? "with-expo"}`),
    ),
  ];
  return keys.map((key) => {
    const runs = attempts.filter(
      (run) => `${run.id}:${run.skill_mode ?? "with-expo"}` === key,
    );
    const count = (status: ReturnType<typeof outcomeVerdict>) =>
      runs.filter((run) => outcomeVerdict(run) === status).length;
    const times = runs.map((run) => run.duration_ms).sort((a, b) => a - b);
    const costs = runs.map((run) => run.observation.cost_usd);
    const sameCase = attempts.filter((run) => run.id === runs[0]!.id);
    const withExpo = sameCase.filter(
      (run) => (run.skill_mode ?? "with-expo") === "with-expo",
    );
    const withoutExpo = sameCase.filter(
      (run) => run.skill_mode === "without-expo",
    );
    return {
      id: runs[0]!.id,
      skill_mode: runs[0]!.skill_mode ?? "with-expo",
      attempted: runs.length,
      paired_conditions:
        withExpo.length && withoutExpo.length
          ? withExpo.length === withoutExpo.length &&
            new Set(sameCase.map((run) => run.condition)).size === 1 &&
            sameCase.every((run) => run.status === "complete")
            ? "matched"
            : "inconclusive"
          : "unpaired",
      outcome_passed: count("passed"),
      grading: runs.some((run) => run.judgment)
        ? "provisional-model"
        : "executable",
      judge_errors: runs
        .filter((run) => run.judgment && run.judgment.status !== "graded")
        .map((run) => ({
          attempt: run.attempt,
          status: run.judgment!.status,
          reason: run.judgment!.evidence,
        })),
      judge_cost_usd: runs.every(
        (run) => !run.judgment || typeof run.judgment.cost_usd === "number",
      )
        ? runs.reduce((sum, run) => sum + (run.judgment?.cost_usd ?? 0), 0)
        : null,
      failed_criteria: [
        ...new Set(
          runs.flatMap((run) =>
            run.checks
              .filter((check) => check.status === "failed")
              .map((check) => check.id),
          ),
        ),
      ],
      outcome_failed: count("failed"),
      outcome_pending: count("pending"),
      outcome_unavailable: count("unavailable"),
      infrastructure_errors: runs.filter((run) => run.status !== "complete")
        .length,
      delivered_skills: Object.fromEntries(
        [
          ...new Set(
            runs.flatMap((run) =>
              run.observation.events
                .filter((event) => event.kind === "delivered" && event.skill)
                .map((event) => event.skill!),
            ),
          ),
        ]
          .sort()
          .map((skill) => [
            skill,
            runs.filter((run) =>
              run.observation.events.some(
                (event) => event.kind === "delivered" && event.skill === skill,
              ),
            ).length,
          ]),
      ),
      routing_passed: runs.filter((run) => routingVerdict(run) === "passed")
        .length,
      routing_evaluable: runs.filter((run) =>
        ["passed", "failed"].includes(routingVerdict(run)),
      ).length,
      median_seconds:
        (times[Math.floor((times.length - 1) / 2)]! +
          times[Math.floor(times.length / 2)]!) /
        2000,
      cost_usd: costs.every((cost) => typeof cost === "number")
        ? costs.reduce((sum, cost) => sum! + cost!, 0)
        : null,
    };
  });
}

export function findings(attempts: Attempt[]) {
  const summary = summarize(attempts);
  return [...new Set(attempts.map((run) => run.id))].map((id) => {
    const rows = summary.filter((row) => row.id === id);
    const runs = attempts.filter((run) => run.id === id);
    const graded = rows.reduce(
      (sum, row) => sum + row.outcome_passed + row.outcome_failed,
      0,
    );
    const attempted = runs.length;
    const withExpo = rows.find((row) => row.skill_mode === "with-expo");
    const withoutExpo = rows.find((row) => row.skill_mode === "without-expo");
    let message = "Single condition only; no catalog benefit comparison.";
    let next =
      "Compare matched with/without conditions before attributing a result to skills.";
    if (graded !== attempted) {
      message = `${graded}/${attempted} outcomes graded; comparison incomplete.`;
      next = rows.some((row) => row.judge_errors.length)
        ? "Grader errors prevented this comparison. Inspect the reported errors and replay grading of the saved answers; do not interpret missing grades as inconsistent answers."
        : "Resolve pending reviews or unavailable evidence before claiming a benefit.";
    } else if (rows.some((row) => row.paired_conditions !== "matched")) {
      message = "Conditions are unmatched; no catalog benefit comparison.";
    } else if (withExpo && withoutExpo) {
      const delta = withExpo.outcome_passed - withoutExpo.outcome_passed;
      message = `With Expo ${withExpo.outcome_passed}/${withExpo.attempted}; without ${withoutExpo.outcome_passed}/${withoutExpo.attempted}. ${delta === 0 ? "No observed outcome difference." : delta > 0 ? "More successes with Expo in this sample." : "Fewer successes with Expo in this sample."}`;
      next =
        delta === 0 && withExpo.outcome_failed === 0
          ? "Keep as regression coverage; this sample does not demonstrate added value. Compare time/cost before expanding trials."
          : "Inspect the failed criteria and trace delivery before editing a skill. Repeat the affected and neighboring cases after one targeted change.";
    }
    const failures = runs
      .filter((run) => outcomeVerdict(run) === "failed")
      .map((run) => ({
        condition: run.skill_mode ?? "with-expo",
        attempt: run.attempt,
        artifact: run.artifact_path ?? `${run.id}/${run.attempt}`,
        criteria: run.checks.filter((check) => check.status === "failed"),
        required_routing_failures: run.routing
          .filter(
            (row) => row.expectation === "required" && row.status !== "passed",
          )
          .map((row) => ({ skill: row.skill, status: row.status })),
        delivered_skills: [
          ...new Set(
            run.observation.events
              .filter((event) => event.kind === "delivered" && event.skill)
              .map((event) => event.skill),
          ),
        ],
      }));
    if (failures.length && graded === attempted) {
      if (id === "expo-config-repair")
        next =
          "Inspect the resolved-config differences: nested ios/extra merges and unset/empty environment fallback. Check whether relevant delivered guidance covers that failure before proposing a skill edit.";
      if (id === "expo-config-correct")
        next =
          "Inspect unnecessary edits to already-correct config. Test narrower instructions that preserve working configuration if the trace links those edits to skill guidance.";
      if (id === "signing-diagnosis")
        next =
          "Review the quoted cause/action/execution failures against the supplied log. If eas-app-stores was absent, test explicit loading; if delivered, inspect its diagnostic guidance. These are hypotheses, not established causes.";
    }
    return {
      id,
      graded,
      attempted,
      grading: rows.some((row) => row.grading === "provisional-model")
        ? "provisional-model"
        : "executable",
      message,
      next_step: next,
      failures,
    };
  });
}

export function writeReport(out: string, attempts: Attempt[]): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "metrics.json"),
    JSON.stringify({ schema_version: 2, attempts }, null, 2),
  );
  const summary = summarize(attempts);
  const insights = findings(attempts);
  writeFileSync(join(out, "findings.json"), JSON.stringify(insights, null, 2));
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  const matrix = summary
    .map(
      (row) => `<tr><td>${escape(row.id)}</td><td>${row.skill_mode}</td>
    <td>${row.grading}: ${row.outcome_passed} passed / ${row.outcome_passed + row.outcome_failed} evaluated</td>
    <td>${row.outcome_pending}</td><td>${row.outcome_unavailable}</td>
    <td>${row.skill_mode === "without-expo" ? "Not applicable" : `${row.routing_passed}/${row.routing_evaluable}`}</td>
    <td>${row.attempted}</td><td>${row.paired_conditions}</td><td>${row.median_seconds.toFixed(1)}s</td><td>${row.cost_usd === null ? "Unavailable" : `$${row.cost_usd.toFixed(3)}`}</td></tr>`,
    )
    .join("");
  const detail = attempts
    .map((run) => {
      const path = escape(run.artifact_path ?? `${run.id}/${run.attempt}`);
      const anchor = escape(
        `${run.id}-${run.skill_mode ?? "with-expo"}-${run.attempt}`,
      );
      return `<section id="${anchor}"><h2>${escape(run.id)} · ${run.skill_mode ?? "with-expo"} · attempt ${run.attempt}</h2>
    <p>Outcome: <b>${outcomeVerdict(run)}</b> · ${escape(run.status)} · ${routingVerdict(run)} routing · <a href="${path}/raw.jsonl">Raw trace</a> · <a href="${path}/manifest.json">Manifest</a></p>
    <p>${escape(run.judgment?.evidence ?? "Executable source/config checks; no model judgment.")}</p>
    <h3>Outcome evidence</h3><ul>${run.checks.map((check) => `<li>${escape(check.id)}: <b>${escape(check.status)}</b> — ${escape(check.evidence)}</li>`).join("")}</ul>
    <h3>Routing evidence</h3><table><tr><th>Skill</th><th>Expectation</th><th>Result</th><th>Evidence</th></tr>${run.routing.map((row) => `<tr><td>${escape(row.skill)}</td><td>${escape(row.expectation)}</td><td>${escape(row.status)}</td><td>${row.event === null ? "—" : `<a href="#${anchor}-event-${row.event}">Trace line ${row.event + 1}</a>`}</td></tr>`).join("")}</table>
    <details><summary>Execution evidence and final response</summary>${run.observation.events.map((event) => `<div id="${anchor}-event-${event.index}"><b>Line ${event.index + 1}: ${escape(event.kind)} ${escape(event.skill)}</b><pre>${escape(event.detail)}</pre></div>`).join("")}</details>
    <details><summary>Runtime-advertised skills (names only)</summary><pre>${escape(JSON.stringify(run.observation.advertised_skills ?? [], null, 2))}</pre></details>
    <pre>${escape(run.observation.errors.join("\n"))}</pre></section>`;
    })
    .join("");
  writeFileSync(
    join(out, "report.html"),
    page(
      "Focused Expo skill evaluation",
      ` ${existsSync(join(out, "replay.json")) ? "<p><b>Offline replay of saved judge evidence.</b> No new model calls. This derived report does not change the original CI error status. See replay.json for provenance.</p>" : ""}<p>Task outcomes and routing are separate. Pending reviews are not passes. Source/JS checks do not establish native-runtime correctness. Counts describe this sample, not production reliability. Costs are model-reported and exclude CI compute. Without Expo skills retains the runtime's other built-in skills.</p>
    <h2>What this experiment tells us</h2><ul>${insights.map((finding) => `<li><b>${escape(finding.id)}</b> (${finding.grading}): ${escape(finding.message)} ${escape(finding.next_step)}</li>`).join("")}</ul>
    <p>Advice judgments are provisional and gated by synthetic calibration, not expert validation. Judge costs are recorded separately in summary.json and judge-calibration.json. Failure evidence and delivery details are in findings.json; these suggest investigations, not proven causes.</p>
    <table><tr><th>Case</th><th>Condition</th><th>Outcome</th><th>Pending</th><th>Unavailable</th><th>Routing</th><th>Attempts</th><th>Paired conditions</th><th>Median time</th><th>Model cost</th></tr>${matrix}</table>${detail}`,
    ),
  );
}
export function compareReports(
  baseline: string,
  candidate: string,
  out: string,
): void {
  const read = (file: string): Attempt[] =>
    JSON.parse(readFileSync(file, "utf8")).attempts;
  const left = read(baseline),
    right = read(candidate);
  const keys = [...new Set([...left, ...right].map((run) => run.id))];
  const rows = keys.map((id) => {
    const a = left.filter((run) => run.id === id),
      b = right.filter((run) => run.id === id);
    const compatible =
      a.length > 0 &&
      b.length > 0 &&
      new Set([...a, ...b].map((run) => run.condition)).size === 1 &&
      new Set(a.map((run) => run.skill_mode ?? "with-expo")).size === 1 &&
      new Set(b.map((run) => run.skill_mode ?? "with-expo")).size === 1;
    const count = (runs: Attempt[]) =>
      `${runs.filter((run) => routingVerdict(run) === "passed").length}/${runs.filter((run) => ["passed", "failed"].includes(routingVerdict(run))).length} (${runs.length} attempted)`;
    const certain =
      compatible &&
      a.length === b.length &&
      [...a, ...b].every((run) =>
        ["passed", "failed"].includes(routingVerdict(run)),
      );
    const passes = (runs: Attempt[]) =>
      runs.filter((run) => routingVerdict(run) === "passed").length;
    const group = !certain
      ? "inconclusive"
      : passes(b) > passes(a)
        ? "improved in sample"
        : passes(b) < passes(a)
          ? "regressed in sample"
          : "unchanged in sample";
    const checks = (runs: Attempt[]) =>
      runs.reduce(
        (total, run) =>
          total +
          run.checks.filter((check) => check.status === "failed").length,
        0,
      );
    return {
      id,
      group,
      baseline: count(a),
      candidate: count(b),
      baseline_failed_checks: checks(a),
      candidate_failed_checks: checks(b),
      baseline_outcomes: summarize(a),
      candidate_outcomes: summarize(b),
      reason: compatible
        ? "Matched task, fixture, runtime, model and tool conditions; outcome reviews reported separately."
        : "Missing case or changed conditions; do not attribute this difference to the skill.",
    };
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "comparison.json"), JSON.stringify(rows, null, 2));
  const outcomes = (summary: ReturnType<typeof summarize>) =>
    summary
      .map(
        (row) =>
          `${row.outcome_passed}/${row.outcome_passed + row.outcome_failed} evaluated; ${row.outcome_pending} pending; ${row.outcome_unavailable} unavailable`,
      )
      .join("; ");
  writeFileSync(
    join(out, "comparison.html"),
    page(
      "Skill comparison",
      `<p>Routing changes are descriptive sample counts. This report does not claim statistical significance or task success.</p><table><tr><th>Case</th><th>Outcomes (before → after)</th><th>Routing change</th><th>Baseline</th><th>Candidate</th><th>Failed source checks (before → after)</th><th>Conditions</th></tr>${rows.map((row) => `<tr><td>${escape(row.id)}</td><td>${escape(outcomes(row.baseline_outcomes))} → ${escape(outcomes(row.candidate_outcomes))}</td><td>${escape(row.group)}</td><td>${escape(row.baseline)}</td><td>${escape(row.candidate)}</td><td>${row.baseline_failed_checks} → ${row.candidate_failed_checks}</td><td>${escape(row.reason)}</td></tr>`).join("")}</table>`,
    ),
  );
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:15px system-ui;margin:32px;max-width:1400px;color:#222}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:2px solid #bbb;margin-top:32px}a{color:#165ac2}</style><h1>${escape(title)}</h1>${body}</html>`;
}
