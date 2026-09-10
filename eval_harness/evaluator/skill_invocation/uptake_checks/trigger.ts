import type { Expectations } from "../expectations.ts";
import { dedupe, readJson, roundRatio } from "../utils.ts";

export type ToolCall = {
  name?: unknown;
  args?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type NormalizedTrace = {
  agent?: unknown;
  sessions?: Array<{
    turns?: Array<{
      steps?: Array<{
        tool_calls?: ToolCall[] | null;
      }>;
    }>;
  }>;
  [key: string]: unknown;
};

export type TriggerQuality = {
  expectedSkills: string[];
  triggeredSkills: string[];
  matchedSkills: string[];
  extraSkills: string[];
  missingSkills: string[];
  recall: number | null;
  precision: number | null;
  anyExpoSkillTriggered: boolean;
};

const CODEX_SKILL_PATH = /\.agents\/skills\/([A-Za-z0-9_-]+)\//gu;

export function loadTrace(path: string): NormalizedTrace {
  return readJson<NormalizedTrace>(path);
}

export function detectTriggeredSkills(trace: NormalizedTrace): string[] {
  const agent = String(trace.agent ?? "").toLowerCase();
  const observed: string[] = [];
  for (const session of trace.sessions ?? []) {
    for (const turn of session.turns ?? []) {
      for (const step of turn.steps ?? []) {
        for (const call of step.tool_calls ?? []) {
          observed.push(...skillsFromToolCall(agent, call));
        }
      }
    }
  }
  return dedupe(observed);
}

function skillsFromToolCall(agent: string, call: ToolCall): string[] {
  const name = call.name;
  const args = call.args ?? {};
  if (agent === "muse-code" && name === "Skill") {
    const skill = String(args.skill ?? "");
    return skill.length > 0 && !skill.startsWith("bundled:") ? [skill] : [];
  }
  if (name === "Skill") {
    const skill = String(args.skill ?? "");
    return skill.length > 0 ? [skill.split(":").at(-1) ?? skill] : [];
  }
  if (name === "exec_command") {
    const command = String(args.cmd ?? args.command ?? "");
    return [...command.matchAll(CODEX_SKILL_PATH)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]
    );
  }
  return [];
}

export function scoreTriggerQuality(
  expectedSkills: Iterable<string>,
  triggeredSkills: Iterable<string>,
  expectations?: Expectations,
  evidenceAvailable = true,
): TriggerQuality {
  const expected = dedupe([...expectedSkills]);
  const triggered = dedupe([...triggeredSkills]);
  const expectedSet = new Set(expected);
  const triggeredSet = new Set(triggered);
  const matched = expected.filter((skill) => triggeredSet.has(skill));
  const extra = triggered.filter((skill) => !expectedSet.has(skill) && (
    expectations === undefined || expectations.forbidden.includes(skill) ||
    (expectations.unlisted === "forbid" && !expectations.optional.includes(skill))
  ));
  const missing = expected.filter((skill) => !triggeredSet.has(skill));
  const recall = expected.length === 0
    ? 1
    : roundRatio(matched.length, expected.length);
  const precision =
    triggered.length === 0
      ? expected.length === 0
        ? 1
        : 0
      : matched.length + extra.length === 0 ? 1 : roundRatio(matched.length, matched.length + extra.length);
  return {
    expectedSkills: expected,
    triggeredSkills: triggered,
    matchedSkills: matched,
    extraSkills: extra,
    missingSkills: missing,
    recall: evidenceAvailable ? recall : null,
    precision: evidenceAvailable ? precision : null,
    anyExpoSkillTriggered: triggered.length > 0,
  };
}
