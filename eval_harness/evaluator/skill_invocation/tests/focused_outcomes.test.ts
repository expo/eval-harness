import { test, expect } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { checkOutcomes, unchangedTree } from "../focused/outcomes.ts";
import { outcomeVerdict, summarize, type Attempt } from "../focused/report.ts";
import { observeClaude, scoreRouting } from "../focused/trace.ts";
import type { Case } from "../focused/cases.ts";

const item: Case = {
  id: "http",
  family: "http",
  split: "development",
  fixture: "http-v1",
  prompt: "Repair HTTP handling",
  expect: { required: [], optional: [], forbidden: [], unlisted: "observe" },
  before_edit: false,
  unchanged: [],
  review: [],
  checks: ["http-response-contract"],
};
const correct = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../dataset/skill-fixtures/expo-fetch-correct-v1/src/load-items.ts",
  ),
  "utf8",
);

test("HTTP oracle passes; unchanged bug and always-throw mutations fail distinct outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "http-verifier-"));
  try {
    mkdirSync(join(root, "src"));
    const variants: Array<{
      source: string;
      expected: Array<"passed" | "failed">;
    }> = [
      { source: correct, expected: ["passed", "passed", "passed"] },
      {
        source: `console.log("helper loaded");\n${correct}`,
        expected: ["passed", "passed", "passed"],
      },
      {
        source:
          "export async function loadItems(url: string) { return (await fetch(url)).json(); }",
        expected: ["failed", "passed", "passed"],
      },
      {
        source:
          "export async function loadItems(url: string) { await fetch(url); throw new Error('always'); }",
        expected: ["passed", "failed", "passed"],
      },
      {
        source: correct.replace(
          "const response = await fetch(url);",
          "let response; try { response = await fetch(url); } catch { return []; }",
        ),
        expected: ["passed", "passed", "failed"],
      },
    ];
    for (const variant of variants) {
      writeFileSync(join(root, "src/load-items.ts"), variant.source);
      expect(
        (await checkOutcomes(item, root, root)).map((row) => row.status),
      ).toEqual(variant.expected);
    }
    writeFileSync(join(root, "src/load-items.ts"), "broken syntax }");
    expect(
      (await checkOutcomes(item, root, root)).every(
        (row) => row.status === "failed",
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only grading catches additions, deletions and edits outside selected files", () => {
  const root = mkdtempSync(join(tmpdir(), "preserve-fixture-"));
  try {
    const fixture = join(root, "fixture"),
      workspace = join(root, "workspace");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "existing.txt"), "original");
    cpSync(fixture, workspace, { recursive: true });
    expect(unchangedTree(fixture, workspace).status).toBe("passed");
    writeFileSync(join(workspace, "unexpected.txt"), "new");
    expect(unchangedTree(fixture, workspace)).toMatchObject({
      status: "failed",
      evidence: "Changed, added or deleted: unexpected.txt",
    });
    rmSync(join(workspace, "unexpected.txt"));
    writeFileSync(join(workspace, "existing.txt"), "edited");
    expect(unchangedTree(fixture, workspace).status).toBe("failed");
    rmSync(join(workspace, "existing.txt"));
    expect(unchangedTree(fixture, workspace).status).toBe("failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const completed = observeClaude(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done",
    total_cost_usd: 0.2,
  }),
  {},
);
const attempt: Attempt = {
  id: "http",
  family: "http",
  attempt: 1,
  condition: "fixed",
  plugin_hash: "hash",
  status: "complete",
  duration_ms: 1000,
  routing: [],
  checks: [],
  observation: completed,
};
test("outcomes never turn routing passes, pending reviews or missing checks into success", () => {
  expect(outcomeVerdict(attempt)).toBe("pending");
  const pass = {
    ...attempt,
    checks: ["http-error-no-parse", "http-success-data", "network-error"].map(
      (id) => ({
        id,
        status: "passed" as const,
        evidence: "checked",
      }),
    ),
  };
  expect(outcomeVerdict(pass)).toBe("passed");
  expect(outcomeVerdict({ ...pass, checks: pass.checks.slice(1) })).toBe(
    "unavailable",
  );
  expect(
    outcomeVerdict({
      ...pass,
      checks: [
        ...pass.checks,
        { id: "review:1", status: "pending", evidence: "needs review" },
      ],
    }),
  ).toBe("pending");
  expect(outcomeVerdict({ ...pass, status: "infrastructure_error" })).toBe(
    "unavailable",
  );
  expect(
    outcomeVerdict({
      ...pass,
      checks: [
        { id: "http-success-data", status: "unavailable", evidence: "timeout" },
      ],
    }),
  ).toBe("unavailable");
  expect(
    summarize([pass, { ...pass, skill_mode: "without-expo" }]),
  ).toMatchObject([
    {
      skill_mode: "with-expo",
      outcome_passed: 1,
      cost_usd: 0.2,
      paired_conditions: "matched",
    },
    {
      skill_mode: "without-expo",
      outcome_passed: 1,
      routing_evaluable: 0,
      paired_conditions: "matched",
    },
  ]);
  expect(
    summarize([
      pass,
      { ...pass, skill_mode: "without-expo", condition: "different" },
    ])[0]?.paired_conditions,
  ).toBe("inconclusive");
});

test("optional absence is neutral and init skill names are not body delivery", () => {
  const observation = observeClaude(
    [
      JSON.stringify({
        type: "system",
        subtype: "init",
        skills: ["expo:expo-ui", "debug"],
      }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ].join("\n"),
    {},
  );
  expect(observation.advertised_skills).toEqual(["expo:expo-ui", "debug"]);
  expect(
    scoreRouting(
      {
        required: [],
        optional: ["expo-ui"],
        forbidden: [],
        unlisted: "observe",
      },
      observation,
      false,
    )[0]?.status,
  ).toBe("not_loaded");
});
