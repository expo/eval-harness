import type {
  BuildHealthStage,
  ConsolidatedSummary,
  StageStatus,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

const STATUS_META: Record<StageStatus, { label: string }> = {
  passed: { label: "Passed" },
  warning: { label: "Warning" },
  failed: { label: "Failed" },
  not_run: { label: "Not run" },
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, fallback = "Not recorded"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percent(value: number | null, ratio: boolean): string {
  if (value === null) return "Not scored";
  const displayed = ratio ? value * 100 : value;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(displayed)}%`;
}

function scoreStatus(value: number | null, ratio: boolean): StageStatus {
  if (value === null) return "not_run";
  const normalized = ratio ? value : value / 100;
  if (normalized >= 1) return "passed";
  if (normalized > 0) return "warning";
  return "failed";
}

function statusBadge(status: StageStatus, label = STATUS_META[status].label): string {
  return `<span class="status status-${status}"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function renderScoreCard(
  label: string,
  value: string,
  status: StageStatus,
  note: string,
  statusLabel?: string,
  tone: "blue" | "green" | "amber" | "red" = "blue",
): string {
  return `<article class="metric score-card score-${status} metric-tone-${tone}">
    <div class="score-card-top"><p class="score-label">${escapeHtml(label)}</p>${statusBadge(status, statusLabel)}</div>
    <p class="score-value">${escapeHtml(value)}</p>
    <p class="score-note">${escapeHtml(note)}</p>
  </article>`;
}

function renderLadder(stages: BuildHealthStage[]): string {
  return `<ol class="ladder">
    ${stages.map((stage) => `<li class="rung rung-${stage.status}">
      <span class="rung-dot" aria-hidden="true"></span>
      <strong>${escapeHtml(stage.label)}</strong>
      <span>${escapeHtml(stage.detail ?? STATUS_META[stage.status].label)}</span>
      ${stage.log === null ? "" : `<small title="${escapeHtml(stage.log)}">Producer log recorded</small>`}
    </li>`).join("")}
  </ol>`;
}

function skillStatus(skill: JsonRecord): StageStatus {
  if (skill.triggered === false) return "failed";
  const uptake = finiteNumber(skill.uptake_rate);
  if (skill.triggered === true && uptake === 1) return "passed";
  if (skill.triggered === true || (uptake !== null && uptake > 0)) return "warning";
  return "not_run";
}

function renderSkills(skills: unknown[]): string {
  if (skills.length === 0) {
    return `<div class="empty-state"><strong>No skill result supplied.</strong><span>The skill evaluation may have been disabled or unavailable.</span></div>`;
  }
  return `<div class="table-wrap"><table class="result-table">
    <thead><tr><th>Expected skill</th><th>Read</th><th>Uptake</th><th>Result</th></tr></thead>
    <tbody>
    ${skills.map((rawSkill) => {
      const skill = record(rawSkill) ?? { value: rawSkill };
      const id = text(skill.skill_id, "Unknown skill");
      const status = skillStatus(skill);
      const uptake = finiteNumber(skill.uptake_rate);
      const trigger = skill.triggered === true
        ? "Read observed"
        : skill.triggered === false
        ? "Not read"
        : text(skill.trigger_status, "Trigger unknown");
      const passed = finiteNumber(skill.passed);
      const total = finiteNumber(skill.total);
      const uptakeText = passed !== null && total !== null
        ? `${passed}/${total}`
        : percent(uptake, true);
      const barWidth = uptake === null ? 0 : Math.max(0, Math.min(100, uptake * 100));
      return `<tr>
        <td><code>${escapeHtml(id)}</code></td>
        <td>${escapeHtml(trigger)}</td>
        <td>${escapeHtml(uptakeText)}<span class="bar" aria-hidden="true"><i style="width:${barWidth}%"></i></span></td>
        <td>${statusBadge(status)}</td>
      </tr>`;
    }).join("")}
    </tbody>
  </table></div>`;
}

function planStatus(plan: JsonRecord): StageStatus {
  if (plan.status === "evaluator_error") return "failed";
  if (plan.status === "not_applicable") return "not_run";
  const score = finiteNumber(plan.macro_pct);
  if (score === null) return plan.status === "completed" ? "warning" : "not_run";
  return scoreStatus(score, false);
}

function renderPlans(plans: unknown[]): string {
  if (plans.length === 0) {
    return `<div class="empty-state"><strong>No iOS result supplied.</strong><span>The behavioral evaluation may have been disabled or unavailable.</span></div>`;
  }
  return `<div class="table-wrap"><table class="result-table">
    <thead><tr><th>Product flow</th><th>Points</th><th>Score</th><th>Result</th></tr></thead>
    <tbody>
    ${plans.map((rawPlan) => {
      const plan = record(rawPlan) ?? { value: rawPlan };
      const status = planStatus(plan);
      const planName = text(plan.test_plan, "Unknown test plan");
      const macro = finiteNumber(plan.macro_pct);
      const score = finiteNumber(plan.score);
      const fullPoints = finiteNumber(plan.full_points);
      const points = score === null || fullPoints === null
        ? "No point total"
        : `${score}/${fullPoints} points`;
      return `<tr>
        <td><code>${escapeHtml(planName)}</code><span class="cell-note">Run ${escapeHtml(text(plan.run_index, "Not recorded"))}</span></td>
        <td>${escapeHtml(points)}</td>
        <td>${escapeHtml(percent(macro, false))}</td>
        <td>${statusBadge(status)}</td>
      </tr>`;
    }).join("")}
    </tbody>
  </table></div>`;
}

function assertionFailed(assertionValue: unknown): boolean {
  const assertion = record(assertionValue);
  return assertion?.passed === false || assertion?.ok === false;
}

function stepFailed(stepValue: unknown): boolean {
  const step = record(stepValue);
  if (step === null) return false;
  if (typeof step.description === "string" && /^FAILED:/i.test(step.description)) return true;
  const points = finiteNumber(step.points);
  const maximum = finiteNumber(step.max_points);
  if (points !== null && maximum !== null && points < maximum) return true;
  return ["hard_assertions", "soft_assertions"].some((key) =>
    Array.isArray(step[key]) && (step[key] as unknown[]).some(assertionFailed)
  );
}

type Evidence = {
  kind: "passed" | "failed" | "aborted";
  plan: string;
  run: string;
  detailId: string;
  detailLabel: string;
  description: string;
  screenshot: string;
};

function paddedOrdinal(value: number): string {
  return String(value + 1).padStart(2, "0");
}

function planAnchorId(planIndex: number, runValue: unknown): string {
  const run = typeof runValue === "number" && Number.isInteger(runValue)
    ? String(runValue).padStart(2, "0")
    : String(runValue ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "unknown";
  return `ios-plan-${paddedOrdinal(planIndex)}-run-${run}`;
}

function stepAnchorId(planIndex: number, runValue: unknown, stepIndex: number): string {
  return `${planAnchorId(planIndex, runValue)}-step-${paddedOrdinal(stepIndex)}`;
}

function safeScreenshotPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("evidence/screenshots/")) return null;
  if (value.startsWith("/") || value.includes("://")) return null;
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return null;
  return value;
}

function collectEvidence(plans: unknown[]): Evidence[] {
  const evidence: Evidence[] = [];
  for (const [planIndex, rawPlan] of plans.entries()) {
    const plan = record(rawPlan);
    if (plan === null) continue;
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    for (const [stepIndex, rawStep] of steps.entries()) {
      const step = record(rawStep);
      if (step === null) continue;
      const screenshot = safeScreenshotPath(step.screenshot);
      if (screenshot === null) continue;
      evidence.push({
        kind: stepFailed(step) ? "failed" : "passed",
        plan: text(plan.test_plan, "Unknown test plan"),
        run: text(plan.run_index, "Not recorded"),
        detailId: stepAnchorId(planIndex, plan.run_index, stepIndex),
        detailLabel: `View step ${String(stepIndex + 1).padStart(2, "0")} details`,
        description: text(step.description, "Untitled evaluation step"),
        screenshot,
      });
    }
    const terminalEvidence = Array.isArray(plan.terminal_evidence)
      ? plan.terminal_evidence
      : [];
    for (const rawEvidence of terminalEvidence) {
      const terminal = record(rawEvidence);
      if (terminal === null) continue;
      const screenshot = safeScreenshotPath(terminal.screenshot);
      if (screenshot === null) continue;
      const stepNumber = typeof terminal.step_number === "number" &&
          Number.isInteger(terminal.step_number)
        ? terminal.step_number
        : 1;
      evidence.push({
        kind: "aborted",
        plan: text(plan.test_plan, "Unknown test plan"),
        run: text(plan.run_index, "Not recorded"),
        detailId: planAnchorId(planIndex, plan.run_index),
        detailLabel: "View plan diagnostics",
        description: text(terminal.step_name, `Formal step ${stepNumber}`),
        screenshot,
      });
    }
  }
  const rank = { failed: 2, aborted: 1, passed: 0 } as const;
  return evidence.sort((left, right) => rank[right.kind] - rank[left.kind]);
}

function renderEvidence(plans: unknown[]): string {
  const evidence = collectEvidence(plans);
  if (evidence.length === 0) {
    return `<div class="empty-state"><strong>No final-state screenshots were collected.</strong><span>Behavioral scores remain available from structured evaluator evidence.</span></div>`;
  }
  return `<div class="evidence-grid">
    ${evidence.map((item) => {
      const status: StageStatus = item.kind === "failed"
        ? "failed"
        : item.kind === "aborted"
        ? "warning"
        : "passed";
      const label = item.kind === "failed"
        ? "Failed final state"
        : item.kind === "aborted"
        ? "Evaluator-aborted final state"
        : "Passed final state";
      return `<figure class="evidence-card evidence-${status}">
        <div class="evidence-frame"><img src="${escapeHtml(item.screenshot)}" alt="${escapeHtml(`${label}: ${item.description}`)}" loading="lazy"></div>
        <figcaption>
          <div class="evidence-caption-top">${statusBadge(status)}<span>${escapeHtml(label)}</span></div>
          <strong>${escapeHtml(item.description)}</strong>
          <span><code>${escapeHtml(item.plan)}</code>, run ${escapeHtml(item.run)}</span>
          <a class="evidence-link" href="#${escapeHtml(item.detailId)}">${escapeHtml(item.detailLabel)}</a>
        </figcaption>
      </figure>`;
    }).join("")}
  </div>`;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return text(value);
  }
  if (Array.isArray(value)) return value.length === 0 ? "None" : value.map((item) => text(item)).join(", ");
  const object = record(value);
  if (object === null) return "Not recorded";
  return Object.entries(object)
    .map(([key, item]) => `${humanize(key)}: ${text(item)}`)
    .join("; ");
}

function renderKeyValues(items: Array<[string, unknown]>): string {
  return `<dl class="key-values">
    ${items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(displayValue(value))}</dd></div>`).join("")}
  </dl>`;
}

function assertionTitle(assertion: JsonRecord, index: number): string {
  return text(
    assertion.description ?? assertion.assertion ?? assertion.name ?? assertion.check,
    `Assertion ${index + 1}`,
  );
}

function checkStatus(check: JsonRecord): StageStatus {
  switch (check.status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "not_applicable":
      return "not_run";
    case "unavailable":
      return "warning";
  }
  if (check.passed === true || check.ok === true) return "passed";
  if (check.passed === false || check.ok === false) return "failed";
  return "warning";
}

function renderAssertions(step: JsonRecord): string {
  const groups: Array<[string, unknown[]]> = [
    ["Hard assertions", Array.isArray(step.hard_assertions) ? step.hard_assertions : []],
    ["Soft assertions", Array.isArray(step.soft_assertions) ? step.soft_assertions : []],
  ];
  const populated = groups.filter(([, assertions]) => assertions.length > 0);
  if (populated.length === 0) return `<p class="muted">No assertion records were emitted for this step.</p>`;
  return populated.map(([label, assertions]) => `<div class="assertion-group">
    <h5>${escapeHtml(label)}</h5>
    <ul class="assertion-list">
      ${assertions.map((rawAssertion, index) => {
        const assertion = record(rawAssertion) ?? { value: rawAssertion };
        const status: StageStatus = assertionFailed(assertion) ? "failed" : "passed";
        return `<li>${statusBadge(status)}<div><strong>${escapeHtml(assertionTitle(assertion, index))}</strong>${renderKeyValues(Object.entries(assertion).filter(([key]) => !["description", "assertion", "name", "check"].includes(key)))}</div></li>`;
      }).join("")}
    </ul>
  </div>`).join("");
}

function renderEvaluationDetails(skills: unknown[], plans: unknown[]): string {
  const skillDetails = skills.map((rawSkill) => {
    const skill = record(rawSkill) ?? { value: rawSkill };
    const checks = Array.isArray(skill.checks) ? skill.checks : [];
    return `<details class="detail-block">
      <summary><span>Skill: <code>${escapeHtml(text(skill.skill_id, "Unknown"))}</code></span>${statusBadge(skillStatus(skill))}</summary>
      <div class="detail-content">
        ${renderKeyValues(Object.entries(skill).filter(([key]) => key !== "checks"))}
        <h4>Checks</h4>
        ${checks.length === 0
          ? `<p class="muted">No individual check records were emitted.</p>`
          : `<ol class="check-list">${checks.map((rawCheck, index) => {
            const check: JsonRecord = record(rawCheck) ?? { value: rawCheck };
            const status = checkStatus(check);
            return `<li>${statusBadge(status)}<div><strong>${escapeHtml(text(check.id ?? check.name, `Check ${index + 1}`))}</strong>${renderKeyValues(Object.entries(check).filter(([key]) => !["id", "name"].includes(key)))}</div></li>`;
          }).join("")}</ol>`}
      </div>
    </details>`;
  });
  const planDetails = plans.map((rawPlan, planIndex) => {
    const plan = record(rawPlan) ?? { value: rawPlan };
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const terminalEvidence = Array.isArray(plan.terminal_evidence)
      ? plan.terminal_evidence
      : [];
    return `<details class="detail-block" id="${escapeHtml(planAnchorId(planIndex, plan.run_index))}">
      <summary><span>iOS: <code>${escapeHtml(text(plan.test_plan, "Unknown"))}</code>, run ${escapeHtml(text(plan.run_index, "Not recorded"))}</span>${statusBadge(planStatus(plan))}</summary>
      <div class="detail-content">
        ${renderKeyValues(Object.entries(plan).filter(([key]) => !["steps", "terminal_evidence"].includes(key)))}
        ${terminalEvidence.length === 0 ? "" : `
          <h4>Diagnostic evidence</h4>
          ${terminalEvidence.map((rawEvidence) => {
            const evidence: JsonRecord = record(rawEvidence) ?? { value: rawEvidence };
            return `<div class="diagnostic-evidence">${renderKeyValues([
              ["Formal step", evidence.step_number],
              ["Step name", evidence.step_name],
              ["Screenshot", evidence.screenshot],
              ["Screenshot capture warning", evidence.screenshot_error],
            ])}</div>`;
          }).join("")}
        `}
        <h4>Scored steps</h4>
        ${steps.length === 0
          ? `<p class="muted">No scored steps were emitted.</p>`
          : steps.map((rawStep, index) => {
            const step: JsonRecord = record(rawStep) ?? { value: rawStep };
            const status: StageStatus = stepFailed(step) ? "failed" : "passed";
            const detailId = stepAnchorId(planIndex, plan.run_index, index);
            return `<details class="step-detail" id="${escapeHtml(detailId)}">
              <summary><span>${String(index + 1).padStart(2, "0")}. ${escapeHtml(text(step.description, "Untitled step"))}</span>${statusBadge(status)}</summary>
              <div class="step-content">
                ${renderKeyValues(Object.entries(step).filter(([key]) => !["description", "hard_assertions", "soft_assertions", "screenshot"].includes(key)))}
                ${renderAssertions(step)}
              </div>
            </details>`;
          }).join("")}
      </div>
    </details>`;
  });
  const details = [...skillDetails, ...planDetails];
  return details.length === 0
    ? `<div class="empty-state"><strong>No drill-down records available.</strong><span>See the machine-data paths for producer output.</span></div>`
    : details.join("");
}

function renderUsageDetails(
  usage: Record<string, number | null>,
  extras: Array<[string, unknown]>,
): string {
  return renderKeyValues([
    ...Object.entries(usage).map(([key, value]): [string, unknown] => [humanize(key), value]),
    ...extras,
  ]);
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) return `<p class="muted">No warnings recorded.</p>`;
  return `<ul class="warning-list">${warnings.map((warning) => `<li><span aria-hidden="true">!</span><span>${escapeHtml(warning)}</span></li>`).join("")}</ul>`;
}

function runStatus(summary: ConsolidatedSummary): StageStatus {
  return summary.status === "complete" ? "passed" : summary.status === "partial" ? "warning" : "failed";
}

function productName(prd: string): string {
  const normalized = prd.replaceAll("\\", "/");
  const match = normalized.match(/(?:^|\/)prds\/([^/]+)(?:\/|$)/i);
  if (match?.[1]) return humanize(match[1]);
  const basename = normalized.split("/").filter(Boolean).at(-1)?.replace(/\.[^.]+$/, "");
  return basename ? humanize(basename) : "Expo app";
}

function aggregatePoints(plans: unknown[]): { score: number; total: number; recorded: boolean } {
  let score = 0;
  let total = 0;
  let recorded = false;
  for (const rawPlan of plans) {
    const plan = record(rawPlan);
    const planScore = finiteNumber(plan?.score);
    const planTotal = finiteNumber(plan?.full_points);
    if (planScore === null || planTotal === null) continue;
    score += planScore;
    total += planTotal;
    recorded = true;
  }
  return { score, total, recorded };
}

function aggregateSkillChecks(skills: unknown[]): { passed: number; total: number; recorded: boolean } {
  let passed = 0;
  let total = 0;
  let recorded = false;
  for (const rawSkill of skills) {
    const skill = record(rawSkill);
    const skillPassed = finiteNumber(skill?.passed);
    const skillTotal = finiteNumber(skill?.total);
    if (skillPassed === null || skillTotal === null) continue;
    passed += skillPassed;
    total += skillTotal;
    recorded = true;
  }
  return { passed, total, recorded };
}

export function renderReport(summary: ConsolidatedSummary): string {
  const run = record(summary.run) ?? {};
  const author = record(run.author) ?? {};
  const evaluator = record(run.evaluator) ?? {};
  const jobs = record(run.jobs) ?? {};
  const evidence = collectEvidence(summary.ios.test_plans);
  const failedEvidence = evidence.filter((item) => item.kind === "failed").length;
  const iosStatus = scoreStatus(summary.scores.ios_macro_pct, false);
  const recallStatus = scoreStatus(summary.scores.skill_trigger_recall, true);
  const uptakeStatus = scoreStatus(summary.scores.skill_uptake_rate, true);
  const overallStatus = runStatus(summary);
  const overallLabel = summary.status === "complete"
    ? "Complete"
    : summary.status === "partial"
    ? "Partial"
    : "Failed";
  const prd = text(run.prd, "Unknown product brief");
  const product = productName(prd);
  const agentName = humanize(text(author.agent, "Unknown author"));
  const versions = record(run.versions);
  const points = aggregatePoints(summary.ios.test_plans);
  const skillChecks = aggregateSkillChecks(summary.skills);
  const triggeredSkills = summary.skills.filter((rawSkill) => record(rawSkill)?.triggered === true).length;
  const iosNote = points.recorded
    ? `${points.score} of ${points.total} evaluator points passed.`
    : "No behavioral point total was recorded.";
  const recallNote = summary.skills.length > 0
    ? `${triggeredSkills} of ${summary.skills.length} expected Expo skills were read.`
    : "No expected-skill records were supplied.";
  const uptakeNote = skillChecks.recorded
    ? `${skillChecks.passed} of ${skillChecks.total} source-level checks passed.`
    : "No source-level check total was recorded.";
  const runNote = summary.warnings.length === 0
    ? "No producer warnings were recorded."
    : `${summary.warnings.length} warning${summary.warnings.length === 1 ? " needs" : "s need"} review.`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(prd)} - Expo evaluation report</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1F2933;
      --muted: #637081;
      --line: #D9E0E7;
      --navy: #20384D;
      --blue: #507493;
      --green: #4F876D;
      --amber: #AA7C38;
      --red: #AD5C63;
      --blue-soft: #EDF4F8;
      --green-soft: #EDF6F1;
      --amber-soft: #FBF4E7;
      --red-soft: #FAEEF0;
      --canvas: #EEF2F5;
      --white: #FFFFFF;
      --pass: #356D55;
      --warn: #805F27;
      --fail: #934750;
      --not-run: #637081;
      --shadow: 0 4px 18px rgba(32, 56, 77, 0.08);
      --serif: Charter, "Iowan Old Style", Georgia, serif;
      --sans: "Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html { background: var(--canvas); color: var(--ink); font-family: var(--sans); line-height: 1.58; }
    body { margin: 0; min-width: 280px; }
    h1, h2 { font-family: var(--serif); font-weight: 600; letter-spacing: -.025em; }
    h1 { color: var(--white); font-size: clamp(1.9rem, 4vw, 2.9rem); line-height: 1.05; margin: 5px 0 8px; overflow-wrap: anywhere; }
    h2 { font-size: clamp(1.45rem, 2.5vw, 1.75rem); line-height: 1.18; margin: 0 0 6px; }
    h3, h4, h5, p { margin-top: 0; }
    h3 { font-size: .8rem; margin-bottom: 0; }
    h4 { font-size: .75rem; letter-spacing: .07em; margin: 22px 0 9px; text-transform: uppercase; }
    h5 { font-size: .86rem; margin: 16px 0 8px; }
    code { font-family: var(--mono); font-size: .88em; overflow-wrap: anywhere; }
    .hero { background: var(--navy); color: var(--white); padding: 30px max(28px, calc((100% - 1120px) / 2)); }
    .hero-inner { margin-inline: auto; max-width: 1120px; }
    .eyebrow { color: #B9CEDD; font-size: .69rem; font-weight: 750; letter-spacing: .08em; margin: 0; text-transform: uppercase; }
    .hero-deck { color: #DCE6ED; margin: 0; }
    .hero-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .chip { border: 1px solid rgba(255, 255, 255, .21); border-radius: 999px; color: #E9F0F5; font-size: .75rem; padding: 5px 9px; }
    .content, footer > div { margin-inline: auto; max-width: 1120px; width: min(1120px, calc(100% - 48px)); }
    .content { padding-block: 24px 52px; }
    .metrics { display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .metric, .panel { background: var(--white); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); min-width: 0; }
    .metric { min-height: 132px; padding: 17px; }
    .metric-tone-blue { background: var(--blue-soft); }
    .metric-tone-green { background: var(--green-soft); }
    .metric-tone-amber { background: var(--amber-soft); }
    .metric-tone-red { background: var(--red-soft); }
    .score-card-top { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .score-label { color: var(--muted); font-size: .69rem; font-weight: 750; letter-spacing: .055em; margin: 0; text-transform: uppercase; }
    .score-value { font-family: var(--serif); font-size: 2.2rem; line-height: 1; margin: 10px 0 7px; overflow-wrap: anywhere; }
    .score-note, .lede { color: var(--muted); font-size: .81rem; margin: 0; }
    .panel { margin-top: 20px; padding: 24px; }
    .section-head { align-items: start; display: flex; gap: 18px; justify-content: space-between; margin-bottom: 16px; }
    .status { align-items: center; background: var(--blue-soft); border-radius: 999px; color: var(--not-run); display: inline-flex; flex: none; font-size: .7rem; font-weight: 750; gap: 6px; padding: 5px 9px; white-space: nowrap; }
    .status-dot { background: currentColor; border-radius: 50%; display: block; height: 7px; width: 7px; }
    .status-passed { background: var(--green-soft); color: var(--pass); }
    .status-warning { background: var(--amber-soft); color: var(--warn); }
    .status-failed { background: var(--red-soft); color: var(--fail); }
    .status-not_run { color: var(--not-run); }
    .ladder { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); list-style: none; margin: 20px 0 0; padding: 0; }
    .rung { background: #F8FAF9; border-top: 4px solid var(--green); min-width: 0; padding: 14px 8px 10px; position: relative; text-align: center; }
    .rung::after { border-right: 2px solid #8B97A4; border-top: 2px solid #8B97A4; content: ""; height: 7px; position: absolute; right: -4px; top: 31px; transform: rotate(45deg); width: 7px; z-index: 2; }
    .rung:last-child::after { display: none; }
    .rung-warning { background: #FCF8EF; border-color: var(--amber); }
    .rung-failed { background: #FCF1F2; border-color: var(--red); }
    .rung-not_run { background: #F1F4F6; border-color: #9BA5AF; }
    .rung-dot { background: var(--green); border-radius: 50%; display: block; height: 9px; margin: 0 auto 7px; width: 9px; }
    .rung-warning .rung-dot { background: var(--amber); }
    .rung-failed .rung-dot { background: var(--red); }
    .rung-not_run .rung-dot { background: #9BA5AF; }
    .rung strong, .rung > span, .rung small { display: block; }
    .rung strong { color: var(--navy); font-size: .74rem; line-height: 1.25; }
    .rung > span:not(.rung-dot) { color: var(--muted); font-size: .68rem; line-height: 1.35; margin-top: 4px; }
    .rung small { color: var(--muted); font-size: .62rem; margin-top: 5px; overflow-wrap: anywhere; }
    .split { display: grid; gap: 18px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .outcome-panel { margin-top: 20px; }
    .table-wrap { overflow-x: auto; }
    .result-table { border-collapse: collapse; font-size: .78rem; width: 100%; }
    .result-table th, .result-table td { border-bottom: 1px solid var(--line); padding: 11px 9px; text-align: left; vertical-align: top; }
    .result-table th { color: var(--muted); font-size: .66rem; letter-spacing: .045em; text-transform: uppercase; }
    .result-table tr:last-child td { border-bottom: 0; }
    .result-table .status { font-size: .65rem; padding: 4px 7px; }
    .cell-note { color: var(--muted); display: block; font-size: .7rem; margin-top: 2px; }
    .bar { background: #E5E9ED; border-radius: 99px; display: block; height: 8px; margin-top: 5px; overflow: hidden; width: 100%; }
    .bar i { background: var(--green); display: block; height: 100%; }
    .muted { color: var(--muted); font-size: .81rem; margin-bottom: 0; }
    .evidence-note { background: var(--blue-soft); border-left: 4px solid var(--blue); border-radius: 7px; color: var(--muted); margin-bottom: 18px; padding: 13px 14px; }
    .evidence-note strong { color: var(--ink); }
    .evidence-grid { display: grid; gap: 14px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .evidence-card { background: #F8FAFB; border: 1px solid var(--line); border-radius: 12px; margin: 0; min-width: 0; overflow: hidden; }
    .evidence-failed { border-color: #DFB8BC; }
    .evidence-warning { border-color: #DEC999; }
    .evidence-frame { align-items: center; background: linear-gradient(145deg, #DCE5EB, #F5F7F8); display: flex; justify-content: center; min-height: 210px; overflow: hidden; padding: 12px; }
    .evidence-failed .evidence-frame { background: #F6E7E8; }
    .evidence-frame img { display: block; height: auto; max-height: 500px; max-width: 100%; object-fit: contain; }
    figcaption { display: grid; gap: 7px; padding: 12px; }
    figcaption > span { color: var(--muted); font-size: .75rem; }
    .evidence-link { color: var(--blue); font-size: .75rem; font-weight: 700; width: fit-content; }
    .evidence-caption-top { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .evidence-caption-top > span { color: var(--muted); font-size: .67rem; font-weight: 700; text-transform: uppercase; }
    details { background: var(--white); border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
    details + details { margin-top: 8px; }
    summary { align-items: center; cursor: pointer; display: flex; gap: 16px; justify-content: space-between; list-style-position: outside; min-width: 0; padding: 15px 18px; }
    summary > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    details[open] > summary { border-bottom: 1px solid var(--line); }
    .detail-content { padding: 18px; }
    .step-detail { background: var(--canvas); scroll-margin-top: 16px; }
    .step-detail + .step-detail { margin-top: 7px; }
    .step-content { background: var(--white); border-top: 1px solid var(--line); padding: 16px; }
    .key-values { display: grid; gap: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; }
    .key-values > div { border-bottom: 1px solid var(--line); min-width: 0; padding: 10px 12px 10px 0; }
    .key-values dt { color: var(--muted); font-size: .68rem; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
    .key-values dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    .assertion-list, .check-list, .warning-list { list-style: none; margin: 0; padding: 0; }
    .assertion-list li, .check-list li { align-items: start; border-top: 1px solid var(--line); display: grid; gap: 12px; grid-template-columns: auto minmax(0, 1fr); padding: 12px 0; }
    .assertion-list li > div, .check-list li > div { min-width: 0; }
    .telemetry-grid { display: grid; gap: 10px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .telemetry-card { background: #F8FAFB; border: 1px solid #E2E8ED; border-radius: 9px; min-width: 0; padding: 12px; }
    .telemetry-card h3 { color: var(--navy); font-size: .76rem; margin-bottom: 9px; }
    .telemetry-card .key-values { grid-template-columns: 1fr; }
    .telemetry-card .key-values > div { padding: 7px 0; }
    .warning-list li { align-items: start; border-bottom: 1px solid var(--line); display: grid; gap: 10px; grid-template-columns: 20px minmax(0, 1fr); padding: 9px 0; }
    .warning-list li > span:first-child { color: var(--warn); font-weight: 900; }
    .warning-panel { background: #FCF8EF; border-left: 4px solid var(--amber); border-radius: 7px; margin-top: 15px; padding: 13px 14px; }
    .warning-panel h3 { margin-bottom: 6px; }
    .empty-state { align-items: start; color: var(--muted); display: flex; flex-direction: column; gap: 4px; padding: 18px 0; }
    .empty-state strong { color: var(--ink); }
    footer { color: var(--muted); font-size: .75rem; padding: 0 0 24px; text-align: center; }
    a:focus-visible, summary:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
    @media (max-width: 900px) {
      .metrics, .split, .evidence-grid, .telemetry-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ladder { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .rung:nth-child(4n)::after { display: none; }
    }
    @media (max-width: 580px) {
      .hero { padding: 26px 18px; }
      .content, footer > div { width: min(100% - 24px, 1120px); }
      .metrics, .split, .evidence-grid, .telemetry-grid, .ladder { grid-template-columns: 1fr; }
      .panel { padding: 18px; }
      .section-head { flex-direction: column; gap: 10px; }
      .rung::after { display: none; }
      .key-values { grid-template-columns: 1fr; }
      summary { align-items: start; flex-direction: column; gap: 7px; }
    }
    @media print {
      :root { --shadow: none; }
      html, body { background: var(--white); }
      .hero { padding-block: 24px; }
      .content { padding-bottom: 20px; }
      .panel, .metric { break-inside: avoid; box-shadow: none; }
      details { break-inside: avoid; }
      details > * { display: block; }
      details:not([open]) > :not(summary) { display: block; }
      .evidence-card { break-inside: avoid; }
      .evidence-frame { min-height: 180px; }
    }
  </style>
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <p class="eyebrow">EAS authoring evaluation / single run</p>
      <h1>${escapeHtml(product)}, built by ${escapeHtml(agentName)}</h1>
      <p class="hero-deck">Combined authoring, Expo skill-use, build-health, and on-device evaluation evidence.</p>
      <div class="hero-chips" aria-label="Run configuration">
        <span class="chip">${escapeHtml(text(author.model))}</span>
        <span class="chip">${escapeHtml(text(author.effort))} reasoning</span>
        <span class="chip">${escapeHtml(text(run.prompt_variant))} prompt</span>
        <span class="chip">${escapeHtml(humanize(text(run.skill_scenario)))}</span>
        <span class="chip"><code>${escapeHtml(text(run.git_sha))}</code></span>
      </div>
    </div>
  </header>
  <main class="content">
    <section class="metrics" aria-label="Run score summary">
      ${renderScoreCard("iOS quality", percent(summary.scores.ios_macro_pct, false), iosStatus, iosNote, undefined, iosStatus === "failed" ? "red" : iosStatus === "not_run" ? "blue" : "green")}
      ${renderScoreCard("Skill recall", percent(summary.scores.skill_trigger_recall, true), recallStatus, recallNote, undefined, "blue")}
      ${renderScoreCard("Skill uptake", percent(summary.scores.skill_uptake_rate, true), uptakeStatus, uptakeNote, undefined, uptakeStatus === "failed" ? "red" : uptakeStatus === "not_run" ? "blue" : "green")}
      ${renderScoreCard("Run status", overallLabel, overallStatus, runNote, overallLabel, overallStatus === "passed" ? "green" : overallStatus === "warning" ? "amber" : "red")}
    </section>

    <section class="panel ladder-panel" aria-labelledby="ladder-title">
      <div class="section-head"><div><h2 id="ladder-title">Build and evaluation ladder</h2><p class="lede">Each stage is backed by a structured outcome; warning states are recorded, not inferred success.</p></div>${statusBadge(overallStatus, overallLabel)}</div>
      ${renderLadder(summary.build_health)}
    </section>

    <div class="split">
      <section class="panel outcome-panel" aria-labelledby="skills-title">
        <div class="section-head"><div><h2 id="skills-title">Skill use</h2><p class="lede">Did the agent find and apply the expected Expo guidance?</p></div>${statusBadge(recallStatus, summary.skills.length > 0 ? `${triggeredSkills}/${summary.skills.length} triggered` : undefined)}</div>
        ${renderSkills(summary.skills)}
      </section>
      <section class="panel outcome-panel" aria-labelledby="ios-title">
        <div class="section-head"><div><h2 id="ios-title">iOS behavior</h2><p class="lede">Results grouped by the evaluator's product-flow plans.</p></div>${statusBadge(iosStatus)}</div>
        ${renderPlans(summary.ios.test_plans)}
      </section>
    </div>

    <section class="panel evidence-panel" aria-labelledby="evidence-title">
      <div class="section-head"><div><h2 id="evidence-title">Visual evidence</h2><p class="lede">Failed final states appear first, followed by representative passing previews.</p></div>${statusBadge(failedEvidence > 0 ? "warning" : evidence.length > 0 ? "passed" : "not_run", `${failedEvidence} failed state${failedEvidence === 1 ? "" : "s"} shown`)}</div>
      <p class="evidence-note"><strong>Screenshots are human final-state context, not scoring proof.</strong> Claude evaluates from the accessibility and structured state exposed by the driver and cannot inspect captured image pixels today.</p>
      ${renderEvidence(summary.ios.test_plans)}
    </section>

    <section class="panel run-details-panel" aria-labelledby="run-details-title">
      <div class="section-head"><div><h2 id="run-details-title">Run details</h2><p class="lede">Diagnostics retained from logs and traces without promoting them to product scores.</p></div>${statusBadge(overallStatus, overallLabel)}</div>
      <div class="telemetry-grid">
        <article class="telemetry-card"><h3>Author</h3>${renderKeyValues([["Harness", agentName], ["Model", author.model], ["Effort", author.effort]])}</article>
        <article class="telemetry-card"><h3>Evaluator</h3>${renderKeyValues([["Model", evaluator.model], ["Effort", evaluator.effort], ["Harness", evaluator.cli_version]])}</article>
        <article class="telemetry-card"><h3>Author usage</h3>${renderUsageDetails(summary.usage.author, [["Tool calls", author.tool_calls], ["Skill reads", author.skill_reads]])}</article>
        <article class="telemetry-card"><h3>Evaluator usage</h3>${renderUsageDetails(summary.usage.evaluator, [["Tool calls", evaluator.tool_calls]])}</article>
        <article class="telemetry-card"><h3>Versions</h3>${renderKeyValues([["Author harness", author.cli_version], ["Evaluator harness", evaluator.cli_version], ...Object.entries(versions ?? {})])}</article>
        <article class="telemetry-card"><h3>Input</h3>${renderKeyValues([["PRD", prd], ["Prompt", run.prompt_variant], ["Scenario", run.skill_scenario]])}</article>
        <article class="telemetry-card"><h3>Run identity</h3>${renderKeyValues([["Run", run.run_id], ["Revision", run.git_sha], ["iOS job", humanize(text(jobs.ios))], ["Skill job", humanize(text(jobs.skill))]])}</article>
        <article class="telemetry-card"><h3>Machine data paths</h3>${renderKeyValues(Object.entries(summary.artifacts).map(([key, value]) => [humanize(key), value]))}</article>
      </div>
      <div class="warning-panel"><h3>Warnings</h3>${renderWarnings(summary.warnings)}</div>
    </section>

    <section class="panel details-panel" aria-labelledby="details-title">
      <div class="section-head"><div><h2 id="details-title">Detailed evidence</h2><p class="lede">Open a skill or plan to inspect checks, scored steps, assertions, and abort diagnostics.</p></div></div>
      ${renderEvaluationDetails(summary.skills, summary.ios.test_plans)}
    </section>
  </main>
  <footer><div>Static offline report | generated from normalized producer artifacts | screenshots are human evidence only</div></footer>
</body>
</html>`;
}
