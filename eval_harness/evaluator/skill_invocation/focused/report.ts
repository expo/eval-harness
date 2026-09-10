import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoutingRow, Observation } from "./trace.ts";

export type Attempt = {
  id: string;
  family: string;
  attempt: number;
  condition: string;
  plugin_hash: string;
  status: "complete" | "infrastructure_error";
  duration_ms: number;
  routing: RoutingRow[];
  checks: Array<{
    id: string;
    status: "passed" | "failed" | "pending" | "unavailable";
    evidence: string;
  }>;
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
): "passed" | "failed" | "inconclusive" {
  if (attempt.status !== "complete") return "inconclusive";
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
export function writeReport(out: string, attempts: Attempt[]): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "metrics.json"),
    JSON.stringify({ schema_version: 1, attempts }, null, 2),
  );
  const ids = [...new Set(attempts.map((run) => run.id))];
  const matrix = ids
    .map((id) => {
      const runs = attempts.filter((run) => run.id === id);
      const valid = runs.filter(
        (run) => routingVerdict(run) !== "inconclusive",
      );
      const passed = valid.filter(
        (run) => routingVerdict(run) === "passed",
      ).length;
      return `<tr><td>${escape(id)}</td><td>${passed}/${valid.length} evaluable (${runs.length} attempted)</td><td>${runs.length - valid.length}</td><td>${runs.map((run) => `<a href="#${escape(run.id)}-${run.attempt}">Attempt ${run.attempt}</a>`).join(" · ")}</td></tr>`;
    })
    .join("");
  const detail = attempts
    .map(
      (
        run,
      ) => `<section id="${escape(run.id)}-${run.attempt}"><h2>${escape(run.id)} · attempt ${run.attempt}</h2>
    <p>${escape(run.status)} · ${escape(routingVerdict(run))} routing · ${(run.duration_ms / 1000).toFixed(1)} seconds · <a href="${escape(run.id)}/${run.attempt}/raw.jsonl">Raw trace</a> · <a href="${escape(run.id)}/${run.attempt}/manifest.json">Manifest</a></p>
    <table><tr><th>Skill</th><th>Expectation</th><th>Result</th><th>Evidence</th></tr>${run.routing.map((row) => `<tr><td>${escape(row.skill)}</td><td>${escape(row.expectation)}</td><td>${escape(row.status)}</td><td>${row.event === null ? "—" : `<a href="#${escape(run.id)}-${run.attempt}-event-${row.event}">Trace line ${row.event + 1}</a>`}</td></tr>`).join("")}</table>
    <h3>Outcome evidence</h3><p>Source checks do not establish native-runtime correctness. Review assertions remain pending until a human reviews the artifacts.</p>
    <ul>${run.checks.map((check) => `<li>${escape(check.id)}: <b>${escape(check.status)}</b> — ${escape(check.evidence)}</li>`).join("")}</ul>
    <details><summary>Execution evidence and final response</summary>${run.observation.events.map((event) => `<div id="${escape(run.id)}-${run.attempt}-event-${event.index}"><b>Line ${event.index + 1}: ${escape(event.kind)} ${escape(event.skill)}</b><pre>${escape(event.detail)}</pre></div>`).join("")}</details>
    <pre>${escape(run.observation.errors.join("\n"))}</pre></section>`,
    )
    .join("");
  writeFileSync(
    join(out, "report.html"),
    page(
      "Focused Expo skill evaluation",
      `<p>Each run uses the actual skill catalog in a fresh fixture. Full body delivery is scored separately from requests. Counts describe these attempts, not production reliability.</p><table><tr><th>Case</th><th>Routing passes</th><th>Inconclusive</th><th>Attempts</th></tr>${matrix}</table>${detail}`,
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
      new Set([...a, ...b].map((run) => run.condition)).size === 1;
    const count = (runs: Attempt[]) =>
      `${runs.filter((run) => routingVerdict(run) === "passed").length}/${runs.filter((run) => routingVerdict(run) !== "inconclusive").length} (${runs.length} attempted)`;
    const certain =
      compatible &&
      a.length === b.length &&
      [...a, ...b].every((run) => routingVerdict(run) !== "inconclusive");
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
      reason: compatible
        ? "Matched task, fixture, runtime, model and tool conditions; outcome reviews reported separately."
        : "Missing case or changed conditions; do not attribute this difference to the skill.",
    };
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "comparison.json"), JSON.stringify(rows, null, 2));
  writeFileSync(
    join(out, "comparison.html"),
    page(
      "Skill comparison",
      `<p>Routing changes are descriptive sample counts. This report does not claim statistical significance or task success.</p><table><tr><th>Case</th><th>Routing change</th><th>Baseline</th><th>Candidate</th><th>Failed source checks (before → after)</th><th>Conditions</th></tr>${rows.map((row) => `<tr><td>${escape(row.id)}</td><td>${escape(row.group)}</td><td>${escape(row.baseline)}</td><td>${escape(row.candidate)}</td><td>${row.baseline_failed_checks} → ${row.candidate_failed_checks}</td><td>${escape(row.reason)}</td></tr>`).join("")}</table>`,
    ),
  );
}
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:15px system-ui;margin:32px;max-width:1400px;color:#222}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{text-align:left;padding:10px;border-bottom:1px solid #ddd;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:2px solid #bbb;margin-top:32px}a{color:#165ac2}</style><h1>${escape(title)}</h1>${body}</html>`;
}
