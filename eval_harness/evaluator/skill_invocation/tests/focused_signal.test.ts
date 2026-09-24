import { signingContext, SIGNING_CASE } from "../focused/signing-case.ts";
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
test("signing context freezes the supplied case and original fixture diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "signing-context-"));
  try {
    cpSync(join(fixtures, "expo-settings-v1"), root, { recursive: true });
    const custom = { ...SIGNING_CASE, prompt: "A different task", review: ["Cause", "Action", "Execution"] } as Case;
    writeFileSync(join(root, "diagnostics/ios-build.txt"), "Custom diagnostic");
    const frozen = signingContext(custom, root);
    writeFileSync(join(root, "diagnostics/ios-build.txt"), "Changed by author");
    expect(frozen).toEqual({ task: custom.prompt, log: "Custom diagnostic", criteria: custom.review.map((criterion, i) => ({ id: `review:${i + 1}`, criterion })) });
    expect(() => signingContext({ ...custom, review: [] }, root)).toThrow("cause");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    const context = signingContext(SIGNING_CASE as Case, join(fixtures, SIGNING_CASE.fixture));
    context.task = "Use this frozen task";
    context.log = "Use this frozen diagnostic, not a hardcoded copy";
    mkdirSync(join(root, "signing-diagnosis/1"), { recursive: true });
    writeFileSync(join(root, "signing-diagnosis/1/manifest.json"), JSON.stringify({
      case: { prompt: context.task, review: SIGNING_RUBRIC }, signing_context: context,
    }));
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
    for (const path of ["signing-diagnosis/1/judge/input.json", "judge-calibration/correct/input.json"]) {
      expect(JSON.parse(readFileSync(join(root, path), "utf8"))).toMatchObject(context);
    }
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
    expect(outcomeVerdict(run)).toBe("unavailable");
    expect(findings([run])[0]?.next_step).toContain("Grader errors");
    delete process.env.FAKE_JUDGE_FAIL;
    rmSync(join(root, "signing-diagnosis/1/manifest.json"));
    const missingContext = make();
    expect(await gradeSigning([missingContext], root, "fake-model")).toBe(false);
    expect(outcomeVerdict(missingContext)).toBe("unavailable");
    run.judgment = {
      ...run.judgment!,
      status: "unavailable",
      evidence: "Judge quote is not in the answer",
    };
    expect(outcomeVerdict(run)).toBe("unavailable");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("saved signing quote regression: bold and whitespace are presentation, altered wording is not", () => {
  const answer =
    "1. **Regenerate the provisioning profile.** Create a new profile that includes the new distribution certificate.";
  const quote =
    "Regenerate the provisioning profile. Create a new profile that includes the new distribution certificate.";
  const judgment = (text: string) => ({
    criteria: [1, 2, 3].map((i) => ({
      id: `review:${i}`,
      verdict: "passed",
      quote: text,
      reason: "Fixture evidence",
    })),
  });
  expect(
    parseJudgment(judgment(quote), answer).every(
      (row) => row.status === "passed",
    ),
  ).toBe(true);
  expect(parseJudgment(judgment(quote), answer)[1]?.evidence).toContain(
    "bold/whitespace normalized",
  );
  expect(
    parseJudgment(judgment(quote.replace(". Create", ".\nCreate")), answer),
  ).toHaveLength(3);
  expect(() =>
    parseJudgment(judgment(quote.replace("Regenerate", "Delete")), answer),
  ).toThrow("quote");
  expect(() =>
    parseJudgment(
      judgment(quote.replace("new distribution", "old distribution")),
      answer,
    ),
  ).toThrow("quote");
});

import { createHash } from "node:crypto";
import { replayJudgments } from "../focused/replay-judgments.ts";
import { CALIBRATION, SIGNING_RUBRIC } from "../focused/signing-case.ts";

test("offline replay preserves source evidence, recovers formatting-only failures and rejects altered answers", () => {
  const root = mkdtempSync(join(tmpdir(), "replay-judge-"));
  const source = join(root, "source");
  const write = (path: string, value: unknown) => {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), JSON.stringify(value));
  };
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const structured = (answer: string, verdicts: readonly string[]) => ({
    criteria: verdicts.map((verdict, i) => ({
      id: `review:${i + 1}`,
      verdict,
      quote: answer,
      reason: "Saved fixture judgment",
    })),
  });
  try {
    write("judge-calibration.json", {
      calibrated: true,
      model: "fake",
      rubric: SIGNING_RUBRIC,
    });
    for (const sample of CALIBRATION)
      write(`judge-calibration/${sample.id}/raw.json`, {
        subtype: "success",
        structured_output: structured(sample.answer, sample.expected),
      });
    const observation = observeClaude(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "**Regenerate the profile.** Keep the certificate.",
      }),
      {},
    );
    const manifest = { adapter: "claude-focused-v2" };
    const author = hash({ ...manifest, resolved_model: observation.model });
    const condition = hash({
      author,
      judge_model: "fake",
      resolved_models: [],
      rubric: SIGNING_RUBRIC,
      calibrated: true,
    });
    const run: Attempt = {
      id: "signing-diagnosis",
      family: "signing",
      attempt: 1,
      condition,
      plugin_hash: "absent",
      skill_mode: "without-expo",
      artifact_path: "without-expo/signing-diagnosis/1",
      status: "complete",
      duration_ms: 1000,
      observation,
      routing: [],
      checks: [],
      judgment: {
        status: "unavailable",
        requested_model: "fake",
        resolved_models: [],
        cost_usd: null,
        evidence: "quote mismatch",
      },
    };
    write("metrics.json", { schema_version: 2, attempts: [run] });
    write(`${run.artifact_path}/manifest.json`, manifest);
    const input = {
      answer: observation.final,
      criteria: SIGNING_RUBRIC.map((criterion, i) => ({
        id: `review:${i + 1}`,
        criterion,
      })),
    };
    write(`${run.artifact_path}/judge/input.json`, input);
    write(`${run.artifact_path}/judge/raw.json`, {
      subtype: "success",
      modelUsage: { fake: {} },
      total_cost_usd: 0.01,
      structured_output: structured(
        "Regenerate the profile. Keep the certificate.",
        ["passed", "passed", "passed"],
      ),
    });
    const original = readFileSync(join(source, "metrics.json"), "utf8");
    replayJudgments(source, join(root, "derived"));
    expect(readFileSync(join(source, "metrics.json"), "utf8")).toBe(original);
    const result = JSON.parse(
      readFileSync(join(root, "derived/metrics.json"), "utf8"),
    ).attempts[0];
    expect(outcomeVerdict(result)).toBe("passed");
    expect(readFileSync(join(root, "derived/report.html"), "utf8")).toContain(
      "Offline replay of saved judge evidence",
    );
    expect(result.judgment.cost_usd).toBe(0.01);
    expect(
      JSON.parse(readFileSync(join(root, "derived/replay.json"), "utf8"))
        .source_metrics_sha256,
    ).toBe(hash(JSON.parse(original)));
    expect(() => replayJudgments(source, join(source, "nested"))).toThrow(
      "outside",
    );
    write(`${run.artifact_path}/judge/input.json`, {
      ...input,
      answer: "An unrelated answer",
    });
    expect(() => replayJudgments(source, join(root, "bad"))).toThrow(
      "mismatch",
    );
    const context = { task: "Frozen task", log: "Frozen diagnostic", criteria: input.criteria };
    const frozenManifest = { ...manifest, signing_context: context };
    write(`${run.artifact_path}/manifest.json`, frozenManifest);
    write(`${run.artifact_path}/judge/input.json`, { ...context, answer: observation.final });
    write("judge-calibration.json", { calibrated: true, model: "fake", rubric: SIGNING_RUBRIC, context });
    run.condition = hash({ author: hash({ ...frozenManifest, resolved_model: observation.model }), judge_model: "fake", resolved_models: [], rubric: SIGNING_RUBRIC, calibrated: true });
    write("metrics.json", { schema_version: 2, attempts: [run] });
    replayJudgments(source, join(root, "frozen-derived"));
    write(`${run.artifact_path}/judge/input.json`, { ...context, log: "Wrong diagnostic", answer: observation.final });
    expect(() => replayJudgments(source, join(root, "wrong-log"))).toThrow("context mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
