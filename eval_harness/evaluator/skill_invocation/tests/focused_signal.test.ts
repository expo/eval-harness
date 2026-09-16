import { test, expect } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkOutcomes } from "../focused/outcomes.ts";
import { parseJudgment } from "../focused/advice-judge.ts";
import type { Case } from "../focused/cases.ts";

const fixtures = resolve(import.meta.dir, "../../../../dataset/skill-fixtures");
const item: Case = {
  id: "config",
  family: "config",
  fixture: "config",
  split: "development",
  prompt: "Fix config",
  expect: { required: [], optional: [], forbidden: [], unlisted: "observe" },
  before_edit: false,
  unchanged: [],
  review: [],
  checks: ["expo-config-contract"],
};
test("Expo config oracle rejects no-op, shallow merge, missing fallback and hardcoded environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "expo-config-oracle-"));
  const fixture = join(fixtures, "expo-config-correct-v1");
  try {
    cpSync(fixture, root, { recursive: true });
    const correct = readFileSync(join(root, "app.config.js"), "utf8");
    const variants: [string, Array<"passed" | "failed">][] = [
      [correct, ["passed", "passed", "passed"]],
      [
        readFileSync(
          join(fixtures, "expo-config-broken-v1/app.config.js"),
          "utf8",
        ),
        ["failed", "failed", "failed"],
      ],
      [correct.replace("...config.ios,", ""), ["failed", "failed", "failed"]],
      [correct.replace("...config.extra,", ""), ["failed", "failed", "failed"]],
      [
        correct.replace(' || "https://api.example.test"', ""),
        ["failed", "failed", "passed"],
      ],
      [
        correct.replace("process.env.EXPO_PUBLIC_API_URL || ", ""),
        ["passed", "passed", "failed"],
      ],
    ];
    for (const [source, expected] of variants) {
      writeFileSync(join(root, "app.config.js"), source);
      expect(
        (await checkOutcomes(item, fixture, root)).map((check) => check.status),
      ).toEqual(expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("judge accepts exact evidence, retains unknown, rejects invented quotes and missing criteria", () => {
  const answer = "The certificate changed. Regenerate the profile.";
  const criteria = [
    {
      id: "review:1",
      verdict: "passed",
      quote: "The certificate changed.",
      reason: "Identifies cause",
    },
    {
      id: "review:2",
      verdict: "passed",
      quote: "Regenerate the profile.",
      reason: "Correct action",
    },
    { id: "review:3", verdict: "unknown", quote: "", reason: "Uncertain" },
  ];
  expect(
    parseJudgment({ criteria }, answer).map((check) => check.status),
  ).toEqual(["passed", "passed", "pending"]);
  expect(() =>
    parseJudgment({ criteria: criteria.slice(1) }, answer),
  ).toThrow();
  expect(() =>
    parseJudgment(
      {
        criteria: [
          { ...criteria[0], quote: "Invented evidence" },
          ...criteria.slice(1),
        ],
      },
      answer,
    ),
  ).toThrow("quote");
  expect(() =>
    parseJudgment(
      { criteria: [{ ...criteria[0], quote: "" }, ...criteria.slice(1)] },
      answer,
    ),
  ).toThrow("evidence");
});

import { chmodSync, mkdirSync } from "node:fs";
import { gradeSigning } from "../focused/advice-judge.ts";
import { outcomeVerdict, findings, type Attempt } from "../focused/report.ts";
import { observeClaude } from "../focused/trace.ts";

test("CI judge adapter gates on calibration, preserves evidence and cannot turn unknown into a pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "fake-advice-judge-"));
  const saved = {
    PATH: process.env.PATH,
    CI: process.env.CI,
    SKILL_EVAL_REMOTE: process.env.SKILL_EVAL_REMOTE,
    FAKE_JUDGE_FAIL: process.env.FAKE_JUDGE_FAIL,
  };
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env node
const answer = JSON.parse(process.argv[process.argv.indexOf('-p') + 1]).answer;
const generic = answer.includes('Metro');
const invented = answer.includes('contacted Apple');
const verdicts = process.env.FAKE_JUDGE_FAIL ? ['passed','passed','passed'] : [generic ? 'failed':'passed', generic ? 'failed':'passed', invented ? 'failed':'passed'];
console.log(JSON.stringify({subtype:'success',is_error:false,total_cost_usd:0.01,modelUsage:{'fake-model':{}},structured_output:{criteria:verdicts.map((verdict,i)=>({id:'review:'+(i+1),verdict:answer==='ambiguous'?'unknown':verdict,quote:answer,reason:'Fake verdict for adapter test'}))}}));
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.CI = "1";
    process.env.SKILL_EVAL_REMOTE = "1";
    const make = (): Attempt => ({
      id: "signing-diagnosis",
      family: "build-signing",
      attempt: 1,
      condition: "fixed",
      plugin_hash: "catalog",
      status: "complete",
      duration_ms: 1000,
      checks: [1, 2, 3].map((i) => ({
        id: `review:${i}`,
        status: "pending",
        evidence: "needs review",
      })),
      routing: [],
      observation: observeClaude(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result:
            "The profile excludes the rotated certificate. Regenerate it.",
        }),
        {},
      ),
    });
    let run = make();
    expect(await gradeSigning([run], root, "fake-model")).toBe(true);
    expect(run.judgment?.status).toBe("graded");
    expect(outcomeVerdict(run)).toBe("passed");
    expect(run.condition).not.toBe("fixed");
    expect(findings([run])[0]?.grading).toBe("provisional-model");
    run = make();
    run.observation.final = "ambiguous";
    expect(await gradeSigning([run], root, "fake-model")).toBe(true);
    expect(outcomeVerdict(run)).toBe("pending");
    process.env.FAKE_JUDGE_FAIL = "1";
    run = make();
    expect(await gradeSigning([run], root, "fake-model")).toBe(false);
    expect(run.judgment?.status).toBe("uncalibrated");
    expect(outcomeVerdict(run)).toBe("pending");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
