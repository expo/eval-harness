import type {
  BuildHealthStage,
  ConsolidatedSummary,
  StageStatus,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

const STATUS_META: Record<StageStatus, { label: string; symbol: string }> = {
  passed: { label: "Passed", symbol: "✓" },
  warning: { label: "Warning", symbol: "!" },
  failed: { label: "Failed", symbol: "×" },
  not_run: { label: "Not run", symbol: "—" },
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

function statusBadge(status: StageStatus): string {
  const meta = STATUS_META[status];
  return `<span class="status status-${status}"><span aria-hidden="true">${meta.symbol}</span> ${meta.label}</span>`;
}

function renderScoreCard(
  label: string,
  value: string,
  status: StageStatus,
  note: string,
): string {
  return `<article class="score-card score-${status}">
    <div class="score-card-top"><p class="score-label">${escapeHtml(label)}</p>${statusBadge(status)}</div>
    <p class="score-value">${escapeHtml(value)}</p>
    <p class="score-note">${escapeHtml(note)}</p>
  </article>`;
}

function renderLadder(stages: BuildHealthStage[]): string {
  return `<ol class="run-spine">
    ${stages.map((stage, index) => {
      const meta = STATUS_META[stage.status];
      return `<li class="spine-step spine-${stage.status}">
        <div class="spine-marker" aria-hidden="true"><span>${meta.symbol}</span></div>
        <div class="spine-body">
          <div class="spine-heading">
            <span class="spine-index">${String(index + 1).padStart(2, "0")}</span>
            <h3>${escapeHtml(stage.label)}</h3>
            ${statusBadge(stage.status)}
          </div>
          ${stage.detail === null
            ? `<p class="muted">No additional detail.</p>`
            : `<p>${escapeHtml(stage.detail)}</p>`}
          ${stage.log === null
            ? ""
            : `<p class="machine-line"><span>Producer log</span> <code>${escapeHtml(stage.log)}</code></p>`}
        </div>
      </li>`;
    }).join("")}
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
  return `<div class="result-list">
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
      return `<article class="result-row">
        <div>
          <p class="result-title"><code>${escapeHtml(id)}</code></p>
          <p class="muted">${escapeHtml(trigger)} · ${escapeHtml(percent(uptake, true))} uptake</p>
        </div>
        ${statusBadge(status)}
      </article>`;
    }).join("")}
  </div>`;
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
  return `<div class="result-list">
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
      return `<article class="result-row">
        <div>
          <p class="result-title"><code>${escapeHtml(planName)}</code></p>
          <p class="muted">Run ${escapeHtml(text(plan.run_index, "—"))} · ${escapeHtml(points)} · ${escapeHtml(percent(macro, false))}</p>
        </div>
        ${statusBadge(status)}
      </article>`;
    }).join("")}
  </div>`;
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
  failed: boolean;
  plan: string;
  run: string;
  description: string;
  screenshot: string;
};

function safeScreenshotPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("evidence/screenshots/")) return null;
  if (value.startsWith("/") || value.includes("://")) return null;
  const segments = value.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return null;
  return value;
}

function collectEvidence(plans: unknown[]): Evidence[] {
  const evidence: Evidence[] = [];
  for (const rawPlan of plans) {
    const plan = record(rawPlan);
    if (plan === null || !Array.isArray(plan.steps)) continue;
    for (const rawStep of plan.steps) {
      const step = record(rawStep);
      if (step === null) continue;
      const screenshot = safeScreenshotPath(step.screenshot);
      if (screenshot === null) continue;
      evidence.push({
        failed: stepFailed(step),
        plan: text(plan.test_plan, "Unknown test plan"),
        run: text(plan.run_index, "—"),
        description: text(step.description, "Untitled evaluation step"),
        screenshot,
      });
    }
  }
  return evidence.sort((left, right) => Number(right.failed) - Number(left.failed));
}

function renderEvidence(plans: unknown[]): string {
  const evidence = collectEvidence(plans);
  if (evidence.length === 0) {
    return `<div class="empty-state"><strong>No final-state screenshots were collected.</strong><span>Behavioral scores remain available from structured evaluator evidence.</span></div>`;
  }
  return `<div class="evidence-grid">
    ${evidence.map((item) => {
      const status: StageStatus = item.failed ? "failed" : "passed";
      const label = item.failed ? "Failed final state" : "Passed final state";
      return `<figure class="evidence-card evidence-${status}">
        <div class="evidence-frame"><img src="${escapeHtml(item.screenshot)}" alt="${escapeHtml(`${label}: ${item.description}`)}" loading="lazy"></div>
        <figcaption>
          <div class="evidence-caption-top">${statusBadge(status)}<span>${escapeHtml(label)}</span></div>
          <strong>${escapeHtml(item.description)}</strong>
          <span><code>${escapeHtml(item.plan)}</code> · run ${escapeHtml(item.run)}</span>
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
    .join(" · ");
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
      <summary><span>Skill · <code>${escapeHtml(text(skill.skill_id, "Unknown"))}</code></span>${statusBadge(skillStatus(skill))}</summary>
      <div class="detail-content">
        ${renderKeyValues(Object.entries(skill).filter(([key]) => key !== "checks"))}
        <h4>Checks</h4>
        ${checks.length === 0
          ? `<p class="muted">No individual check records were emitted.</p>`
          : `<ol class="check-list">${checks.map((rawCheck, index) => {
            const check: JsonRecord = record(rawCheck) ?? { value: rawCheck };
            const status: StageStatus = check.passed === false || check.ok === false ? "failed" : "passed";
            return `<li>${statusBadge(status)}<div><strong>${escapeHtml(text(check.id ?? check.name, `Check ${index + 1}`))}</strong>${renderKeyValues(Object.entries(check).filter(([key]) => !["id", "name"].includes(key)))}</div></li>`;
          }).join("")}</ol>`}
      </div>
    </details>`;
  });
  const planDetails = plans.map((rawPlan) => {
    const plan = record(rawPlan) ?? { value: rawPlan };
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    return `<details class="detail-block">
      <summary><span>iOS · <code>${escapeHtml(text(plan.test_plan, "Unknown"))}</code> · run ${escapeHtml(text(plan.run_index, "—"))}</span>${statusBadge(planStatus(plan))}</summary>
      <div class="detail-content">
        ${renderKeyValues(Object.entries(plan).filter(([key]) => key !== "steps"))}
        <h4>Scored steps</h4>
        ${steps.length === 0
          ? `<p class="muted">No scored steps were emitted.</p>`
          : steps.map((rawStep, index) => {
            const step: JsonRecord = record(rawStep) ?? { value: rawStep };
            const status: StageStatus = stepFailed(step) ? "failed" : "passed";
            return `<details class="step-detail">
              <summary><span>${String(index + 1).padStart(2, "0")} · ${escapeHtml(text(step.description, "Untitled step"))}</span>${statusBadge(status)}</summary>
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

function renderUsage(usage: Record<string, number | null>): string {
  const entries = Object.entries(usage);
  if (entries.length === 0) return `<p class="muted">Not recorded</p>`;
  return renderKeyValues(entries.map(([key, value]) => [humanize(key), value]));
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) return `<p class="muted">No warnings recorded.</p>`;
  return `<ul class="warning-list">${warnings.map((warning) => `<li><span aria-hidden="true">!</span><span>${escapeHtml(warning)}</span></li>`).join("")}</ul>`;
}

function runStatus(summary: ConsolidatedSummary): StageStatus {
  return summary.status === "complete" ? "passed" : summary.status === "partial" ? "warning" : "failed";
}

export function renderReport(summary: ConsolidatedSummary): string {
  const run = record(summary.run) ?? {};
  const author = record(run.author) ?? {};
  const evaluator = record(run.evaluator) ?? {};
  const evidence = collectEvidence(summary.ios.test_plans);
  const failedEvidence = evidence.filter((item) => item.failed).length;
  const iosStatus = scoreStatus(summary.scores.ios_macro_pct, false);
  const recallStatus = scoreStatus(summary.scores.skill_trigger_recall, true);
  const uptakeStatus = scoreStatus(summary.scores.skill_uptake_rate, true);
  const overallStatus = runStatus(summary);
  const prd = text(run.prd, "Unknown product brief");
  const versions = record(run.versions);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(prd)} · Expo evaluation report</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #0D1B2A;
      --slate: #334155;
      --paper: #F7F9FC;
      --white: #FFFFFF;
      --line: #D8E0EA;
      --line-strong: #AEBBCA;
      --blue: #2563EB;
      --pass: #147D64;
      --pass-soft: #E8F5F0;
      --warn: #B7791F;
      --warn-soft: #FFF7E5;
      --fail: #B42318;
      --fail-soft: #FDECEA;
      --muted: #64748B;
      --shadow: 0 12px 28px rgba(13, 27, 42, 0.08);
      --serif: Charter, Georgia, "Times New Roman", serif;
      --sans: "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html { background: var(--paper); color: var(--ink); font-family: var(--sans); line-height: 1.55; }
    body { margin: 0; min-width: 280px; }
    main, header > div, footer > div { width: min(1120px, calc(100% - 40px)); margin-inline: auto; }
    .run-header { background: var(--ink); color: var(--white); border-bottom: 5px solid var(--blue); padding: 54px 0 38px; }
    .eyebrow { color: #AFC7F9; font-size: .75rem; font-weight: 700; letter-spacing: .14em; margin: 0 0 12px; text-transform: uppercase; }
    h1, h2 { font-family: var(--serif); font-weight: 600; letter-spacing: -.025em; }
    h1 { font-size: clamp(2rem, 5vw, 3.8rem); line-height: 1.03; margin: 0; max-width: 900px; overflow-wrap: anywhere; }
    h2 { font-size: clamp(1.65rem, 3vw, 2.35rem); line-height: 1.15; margin: 0; }
    h3, h4, h5, p { margin-top: 0; }
    h3 { font-size: 1rem; margin-bottom: 0; }
    h4 { font-size: .82rem; letter-spacing: .09em; margin: 24px 0 10px; text-transform: uppercase; }
    h5 { font-size: .9rem; margin: 16px 0 8px; }
    code { font-family: var(--mono); font-size: .9em; overflow-wrap: anywhere; }
    .run-deck { color: #CFD9E6; font-size: 1.03rem; margin: 18px 0 0; max-width: 760px; }
    .run-meta { display: grid; gap: 10px 24px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 30px 0 0; }
    .run-meta div { border-top: 1px solid #3E5268; min-width: 0; padding-top: 9px; }
    .run-meta dt { color: #9EADC0; font-size: .68rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .run-meta dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    main { padding: 42px 0 72px; }
    section { border-top: 1px solid var(--line-strong); margin-top: 46px; padding-top: 24px; }
    .section-heading { align-items: end; display: flex; gap: 20px; justify-content: space-between; margin-bottom: 20px; }
    .section-kicker { color: var(--blue); font-size: .7rem; font-weight: 800; letter-spacing: .12em; margin: 0 0 5px; text-transform: uppercase; }
    .section-note { color: var(--muted); margin: 8px 0 0; max-width: 700px; }
    .score-strip { display: grid; gap: 1px; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 0; background: var(--line); border: 1px solid var(--line); box-shadow: var(--shadow); }
    .score-card { background: var(--white); min-width: 0; padding: 20px; }
    .score-card-top { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .score-label { color: var(--slate); font-size: .72rem; font-weight: 750; letter-spacing: .08em; margin: 0; text-transform: uppercase; }
    .score-value { font-family: var(--serif); font-size: 2rem; line-height: 1; margin: 26px 0 8px; overflow-wrap: anywhere; }
    .score-note { color: var(--muted); font-size: .82rem; margin: 0; }
    .status { align-items: center; display: inline-flex; flex: none; font-size: .7rem; font-weight: 800; gap: 4px; letter-spacing: .035em; text-transform: uppercase; }
    .status-passed { color: var(--pass); }
    .status-warning { color: var(--warn); }
    .status-failed { color: var(--fail); }
    .status-not_run { color: var(--muted); }
    .run-spine { list-style: none; margin: 26px 0 0; padding: 0; }
    .spine-step { display: grid; grid-template-columns: 42px minmax(0, 1fr); min-height: 104px; }
    .spine-marker { display: flex; justify-content: center; position: relative; }
    .spine-marker::after { background: var(--line-strong); bottom: 0; content: ""; left: calc(50% - 1px); position: absolute; top: 36px; width: 2px; }
    .spine-step:last-child .spine-marker::after { display: none; }
    .spine-marker span { align-items: center; background: var(--white); border: 2px solid var(--line-strong); border-radius: 50%; display: flex; font-weight: 900; height: 30px; justify-content: center; position: relative; width: 30px; z-index: 1; }
    .spine-passed .spine-marker span { border-color: var(--pass); color: var(--pass); }
    .spine-warning .spine-marker span { border-color: var(--warn); color: var(--warn); }
    .spine-failed .spine-marker span { border-color: var(--fail); color: var(--fail); }
    .spine-body { background: var(--white); border: 1px solid var(--line); margin: 0 0 14px; min-width: 0; padding: 15px 18px; }
    .spine-heading { align-items: center; display: grid; gap: 10px; grid-template-columns: auto minmax(0, 1fr) auto; }
    .spine-index { color: var(--muted); font-family: var(--mono); font-size: .72rem; }
    .spine-body > p { margin: 8px 0 0 42px; }
    .machine-line { color: var(--muted); font-size: .75rem; }
    .machine-line span { font-weight: 700; margin-right: 6px; }
    .two-column { display: grid; gap: 22px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .panel { background: var(--white); border: 1px solid var(--line); min-width: 0; padding: 22px; }
    .panel h3 { font-family: var(--serif); font-size: 1.35rem; margin: 0 0 16px; }
    .result-list { border-top: 1px solid var(--line); }
    .result-row { align-items: start; border-bottom: 1px solid var(--line); display: flex; gap: 16px; justify-content: space-between; padding: 14px 0; }
    .result-row > div { min-width: 0; }
    .result-title { margin: 0 0 3px; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: .86rem; margin-bottom: 0; }
    .evidence-note { background: #EDF3FF; border-left: 4px solid var(--blue); color: var(--slate); margin-bottom: 22px; padding: 15px 17px; }
    .evidence-note strong { color: var(--ink); }
    .evidence-grid { display: grid; gap: 18px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .evidence-card { background: var(--white); border: 1px solid var(--line); margin: 0; min-width: 0; }
    .evidence-failed { border-top: 4px solid var(--fail); }
    .evidence-passed { border-top: 4px solid var(--pass); }
    .evidence-frame { align-items: center; background: #E8EDF4; display: flex; justify-content: center; min-height: 260px; overflow: hidden; padding: 12px; }
    .evidence-frame img { display: block; height: auto; max-height: 520px; max-width: 100%; object-fit: contain; }
    figcaption { display: grid; gap: 7px; padding: 16px 18px 18px; }
    figcaption > span { color: var(--muted); font-size: .8rem; }
    .evidence-caption-top { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    .evidence-caption-top > span { color: var(--slate); font-size: .72rem; font-weight: 700; text-transform: uppercase; }
    details { background: var(--white); border: 1px solid var(--line); }
    details + details { border-top: 0; }
    summary { align-items: center; cursor: pointer; display: flex; gap: 16px; justify-content: space-between; list-style-position: outside; min-width: 0; padding: 15px 18px; }
    summary > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    details[open] > summary { border-bottom: 1px solid var(--line); }
    .detail-content { padding: 18px; }
    .step-detail { background: var(--paper); }
    .step-detail + .step-detail { border-top: 0; }
    .step-content { background: var(--white); border-top: 1px solid var(--line); padding: 16px; }
    .key-values { display: grid; gap: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; }
    .key-values > div { border-bottom: 1px solid var(--line); min-width: 0; padding: 10px 12px 10px 0; }
    .key-values dt { color: var(--muted); font-size: .68rem; font-weight: 750; letter-spacing: .07em; text-transform: uppercase; }
    .key-values dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    .assertion-list, .check-list, .warning-list { list-style: none; margin: 0; padding: 0; }
    .assertion-list li, .check-list li { align-items: start; border-top: 1px solid var(--line); display: grid; gap: 12px; grid-template-columns: auto minmax(0, 1fr); padding: 12px 0; }
    .assertion-list li > div, .check-list li > div { min-width: 0; }
    .telemetry-grid { display: grid; gap: 18px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .telemetry-card { background: var(--white); border: 1px solid var(--line); min-width: 0; padding: 18px; }
    .telemetry-card h3 { font-size: 1rem; margin-bottom: 12px; }
    .warning-list li { align-items: start; border-bottom: 1px solid var(--line); display: grid; gap: 10px; grid-template-columns: 20px minmax(0, 1fr); padding: 9px 0; }
    .warning-list li > span:first-child { color: var(--warn); font-weight: 900; }
    .warning-panel { margin-top: 18px; }
    .empty-state { align-items: start; color: var(--muted); display: flex; flex-direction: column; gap: 4px; padding: 18px 0; }
    .empty-state strong { color: var(--ink); }
    footer { background: #E8EDF4; border-top: 1px solid var(--line-strong); color: var(--slate); padding: 24px 0; }
    footer p { font-size: .78rem; margin: 0; }
    a:focus-visible, summary:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
    @media (max-width: 760px) {
      main, header > div, footer > div { width: min(100% - 24px, 1120px); }
      .run-header { padding: 38px 0 28px; }
      .run-meta, .score-strip, .two-column, .evidence-grid, .telemetry-grid { grid-template-columns: 1fr; }
      .run-meta { gap: 8px; }
      .section-heading { align-items: start; flex-direction: column; }
      .key-values { grid-template-columns: 1fr; }
      .spine-step { grid-template-columns: 34px minmax(0, 1fr); }
      .spine-heading { grid-template-columns: auto minmax(0, 1fr); }
      .spine-heading .status { grid-column: 2; justify-self: start; }
      .spine-body > p { margin-left: 0; }
      summary { align-items: start; flex-direction: column; gap: 7px; }
    }
    @media print {
      :root { --shadow: none; }
      html, body { background: var(--white); }
      .run-header { padding: 24px 0; }
      main { padding-bottom: 20px; }
      section { break-inside: avoid; margin-top: 28px; }
      details { break-inside: avoid; }
      details > * { display: block; }
      details:not([open]) > :not(summary) { display: block; }
      .evidence-card { break-inside: avoid; }
      .evidence-frame { min-height: 180px; }
    }
  </style>
</head>
<body>
  <header class="run-header">
    <div>
      <p class="eyebrow">Expo evaluation dossier</p>
      <h1>${escapeHtml(prd)}</h1>
      <p class="run-deck">One authored app, its build path, skill uptake, behavioral evaluation, and final-state evidence.</p>
      <dl class="run-meta">
        <div><dt>Author</dt><dd>${escapeHtml(text(author.agent))} · ${escapeHtml(text(author.model))} · ${escapeHtml(text(author.effort))} effort</dd></div>
        <div><dt>Prompt</dt><dd>${escapeHtml(text(run.prompt_variant))}</dd></div>
        <div><dt>Skill scenario</dt><dd>${escapeHtml(text(run.skill_scenario))}</dd></div>
        <div><dt>Source revision</dt><dd><code>${escapeHtml(text(run.git_sha))}</code></dd></div>
        <div><dt>Run</dt><dd><code>${escapeHtml(text(run.run_id))}</code></dd></div>
        <div><dt>Evaluator</dt><dd>${escapeHtml(text(evaluator.model))} · ${escapeHtml(text(evaluator.effort))} effort</dd></div>
      </dl>
    </div>
  </header>
  <main>
    <div class="score-strip" aria-label="Run score summary">
      ${renderScoreCard("iOS quality", percent(summary.scores.ios_macro_pct, false), iosStatus, "Macro average across applicable plans")}
      ${renderScoreCard("Skill recall", percent(summary.scores.skill_trigger_recall, true), recallStatus, "Expected Expo skills read")}
      ${renderScoreCard("Skill uptake", percent(summary.scores.skill_uptake_rate, true), uptakeStatus, "Mapped guidance reflected in source")}
      ${renderScoreCard("Run status", STATUS_META[overallStatus].label, overallStatus, `${failedEvidence} failed final-state screenshot${failedEvidence === 1 ? "" : "s"}`)}
    </div>

    <section aria-labelledby="ladder-title">
      <div class="section-heading"><div><p class="section-kicker">Chronology</p><h2 id="ladder-title">Build and evaluation ladder</h2><p class="section-note">The actual producer-owned gates, ordered from authored output through behavioral evaluation.</p></div></div>
      ${renderLadder(summary.build_health)}
    </section>

    <section aria-labelledby="results-title">
      <div class="section-heading"><div><p class="section-kicker">Outcomes</p><h2 id="results-title">Skill use</h2><p class="section-note">Whether expected Expo guidance was reached and reflected in the authored app.</p></div></div>
      <div class="two-column">
        <article class="panel"><h3>Skill results</h3>${renderSkills(summary.skills)}</article>
        <article class="panel"><h3>iOS behavior</h3>${renderPlans(summary.ios.test_plans)}</article>
      </div>
    </section>

    <section aria-labelledby="evidence-title">
      <div class="section-heading"><div><p class="section-kicker">Human review</p><h2 id="evidence-title">Visual evidence</h2><p class="section-note">Failed final states are shown before passing previews.</p></div></div>
      <p class="evidence-note"><strong>Screenshots are human final-state context, not scoring proof.</strong> Claude evaluates from the accessibility and structured state exposed by the driver and cannot inspect captured image pixels today.</p>
      ${renderEvidence(summary.ios.test_plans)}
    </section>

    <section aria-labelledby="details-title">
      <div class="section-heading"><div><p class="section-kicker">Drill-down</p><h2 id="details-title">Evaluation details</h2><p class="section-note">Open a skill or plan to inspect its checks, scored steps, and assertion records.</p></div></div>
      ${renderEvaluationDetails(summary.skills, summary.ios.test_plans)}
    </section>

    <section aria-labelledby="telemetry-title">
      <div class="section-heading"><div><p class="section-kicker">Reproducibility</p><h2 id="telemetry-title">Run telemetry and provenance</h2><p class="section-note">Recorded usage, harness details, warnings, and replay-friendly machine-data paths.</p></div></div>
      <div class="telemetry-grid">
        <article class="telemetry-card"><h3>Author usage</h3>${renderUsage(summary.usage.author)}</article>
        <article class="telemetry-card"><h3>Evaluator usage</h3>${renderUsage(summary.usage.evaluator)}</article>
        <article class="telemetry-card"><h3>Tool calls</h3>${renderKeyValues([["Author", author.tool_calls], ["Evaluator", evaluator.tool_calls]])}</article>
        <article class="telemetry-card"><h3>Skill reads</h3>${renderKeyValues([["Observed", author.skill_reads]])}</article>
        <article class="telemetry-card"><h3>Versions</h3>${renderKeyValues([["Author harness", author.cli_version], ["Evaluator harness", evaluator.cli_version], ...Object.entries(versions ?? {})])}</article>
        <article class="telemetry-card"><h3>Machine data paths</h3>${renderKeyValues(Object.entries(summary.artifacts).map(([key, value]) => [humanize(key), value]))}</article>
      </div>
      <div class="panel warning-panel"><h3>Warnings</h3>${renderWarnings(summary.warnings)}</div>
    </section>
  </main>
  <footer><div><p>Static offline report · generated from normalized producer artifacts · screenshots are human evidence only</p></div></footer>
</body>
</html>`;
}
