import { test, expect } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseExpectations } from "../expectations.ts";
import { scoreTriggerQuality } from "../uptake_checks/trigger.ts";
import { observeClaude, scoreRouting } from "../focused/trace.ts";
import {
  compareReports,
  summarize,
  writeReport,
  type Attempt,
} from "../focused/report.ts";
import { loadCases } from "../focused/cases.ts";

const body =
  "# Native UI\nRead the existing screen before editing.\nPreserve every existing action.";
const bodies = { "expo-native-ui": body };
const use = (name: string, input: unknown, id = "call-1") => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const delivered = (content: string, is_error = false) => ({
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: "call-1", content, is_error },
    ],
  },
});
const result = {
  type: "result",
  subtype: "success",
  result: "Done",
  is_error: false,
};
const observe = (...events: unknown[]) =>
  observeClaude(
    events.map((event) => JSON.stringify(event)).join("\n"),
    bodies,
  );
const expected = parseExpectations({ required: ["expo-native-ui"] });

test("required router and optional/unlisted skills do not count as false positives", () => {
  const labels = parseExpectations({
    required: ["expo-overview", "expo-router"],
    optional: ["expo-design-system"],
    forbidden: ["eas-app-stores"],
  });
  expect(
    scoreTriggerQuality(
      labels.required,
      ["expo-overview", "expo-router", "expo-design-system", "expo-examples"],
      labels,
    ),
  ).toMatchObject({ recall: 1, precision: 1, extraSkills: [] });
  expect(
    scoreTriggerQuality(
      labels.required,
      ["expo-router", "eas-app-stores"],
      labels,
    ),
  ).toMatchObject({
    recall: 0.5,
    precision: 0.5,
    extraSkills: ["eas-app-stores"],
  });
  expect(() =>
    parseExpectations({ required: ["expo-ui"], forbidden: ["expo-ui"] }),
  ).toThrow();
  expect(() => parseExpectations({ requird: ["expo-ui"] })).toThrow();
});

test("legacy arrays retain closed-set semantics and unavailable evidence has no score", () => {
  expect(parseExpectations(["expo-router"]).unlisted).toBe("forbid");
  expect(
    scoreTriggerQuality(["expo-router"], [], undefined, false),
  ).toMatchObject({ recall: null, precision: null });
});

test("launch acknowledgement alone cannot establish body delivery", () => {
  const trace = observe(
    use("Skill", { skill: "expo:expo-native-ui" }),
    delivered("Launching skill: expo-native-ui"),
    result,
  );
  expect(scoreRouting(expected, trace, true)[0]?.status).toBe("unobservable");
});

test("real body delivery before edit passes; delivery after edit is late", () => {
  const request = use("Skill", { skill: "expo:expo-native-ui" });
  const edit = use("Edit", { file_path: "App.tsx" }, "edit-1");
  expect(
    scoreRouting(
      expected,
      observe(request, delivered(body), edit, result),
      true,
    )[0]?.status,
  ).toBe("passed");
  expect(
    scoreRouting(
      expected,
      observe(request, edit, delivered(body), result),
      true,
    )[0]?.status,
  ).toBe("loaded_late");
});

test("failed reads, missing selection, and missing traces remain distinct", () => {
  const request = use("Read", {
    file_path: "/plugin/skills/expo-native-ui/SKILL.md",
  });
  expect(
    scoreRouting(
      expected,
      observe(request, delivered("file missing", true), result),
      true,
    )[0]?.status,
  ).toBe("load_failed");
  expect(scoreRouting(expected, observe(result), true)[0]?.status).toBe(
    "not_selected",
  );
  expect(scoreRouting(expected, observe(), true)[0]?.status).toBe(
    "unobservable",
  );
  expect(
    scoreRouting(
      expected,
      observe(request, delivered(body, true), result),
      true,
    )[0]?.status,
  ).toBe("load_failed");
});

test("numbered Read output and Skill's separate body message establish delivery", () => {
  const numbered = body
    .split("\n")
    .map((line, i) => `  ${i + 1}→${line}`)
    .join("\n");
  expect(
    scoreRouting(expected, observe(delivered(numbered), result), true)[0]
      ?.status,
  ).toBe("passed");
  expect(
    scoreRouting(
      expected,
      observe(
        {
          type: "user",
          message: {
            content: `Base directory for this skill: /plugin\n\n${body}`,
          },
        },
        result,
      ),
      true,
    )[0]?.status,
  ).toBe("passed");
});

test("assistant claims and child-agent delivery cannot satisfy parent expectations", () => {
  expect(
    scoreRouting(
      expected,
      observe(
        {
          type: "assistant",
          message: { content: [{ type: "text", text: body }] },
        },
        result,
      ),
      true,
    )[0]?.status,
  ).toBe("not_selected");
  expect(
    scoreRouting(
      expected,
      observe({ ...delivered(body), parent_tool_use_id: "child" }, result),
      true,
    )[0]?.status,
  ).toBe("not_selected");
});

test("forbidden delivery fails, unsupported tools and incomplete runs are inconclusive", () => {
  expect(
    scoreRouting(
      parseExpectations({ forbidden: ["expo-native-ui"] }),
      observe(delivered(body), result),
      false,
    )[0]?.status,
  ).toBe("forbidden_load");
  expect(
    scoreRouting(
      expected,
      observe(delivered(body), use("Bash", { command: "unknown" }), result),
      true,
    )[0]?.status,
  ).toBe("unobservable");
  expect(
    scoreRouting(expected, observe(delivered(body)), true)[0]?.status,
  ).toBe("unobservable");
});

test("focused cases have valid fixtures, skills, labels and family splits", () => {
  const harness = resolve(import.meta.dir, "../../../..");
  const plugin =
    process.env.SKILL_PLUGIN_DIR ??
    join(resolve(harness, ".."), "plugins/expo");
  if (!existsSync(join(plugin, ".claude-plugin/plugin.json"))) return;
  expect(
    loadCases(
      join(harness, "dataset/skill-cases.json"),
      join(harness, "dataset/skill-fixtures"),
      join(plugin, "skills"),
    ).length,
  ).toBe(19);
});

test("reports escape trace content and comparisons reject changed conditions", () => {
  const root = mkdtempSync(join(tmpdir(), "focused-report-"));
  try {
    const attempt: Attempt = {
      id: "case-a",
      family: "family-a",
      attempt: 1,
      condition: "condition-a",
      plugin_hash: "plugin-a",
      status: "complete",
      duration_ms: 1,
      routing: scoreRouting(expected, observe(delivered(body), result), true),
      checks: [
        { id: "review", status: "pending", evidence: "<script>bad()</script>" },
      ],
      observation: observe(delivered(body), result),
    };
    writeReport(root, [attempt]);
    expect(readFileSync(join(root, "report.html"), "utf8")).toContain(
      "&lt;script&gt;",
    );
    const candidate = join(root, "candidate.json");
    writeFileSync(
      candidate,
      JSON.stringify({ attempts: [{ ...attempt, condition: "condition-b" }] }),
    );
    compareReports(
      join(root, "metrics.json"),
      candidate,
      join(root, "compare"),
    );
    expect(
      JSON.parse(readFileSync(join(root, "compare/comparison.json"), "utf8"))[0]
        .group,
    ).toBe("inconclusive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed routing and artifact checks remain separate in a comparison", () => {
  const root = mkdtempSync(join(tmpdir(), "focused-compare-"));
  try {
    const base: Attempt = {
      id: "case-a",
      family: "family-a",
      attempt: 1,
      condition: "fixed",
      plugin_hash: "before",
      status: "complete",
      duration_ms: 1,
      routing: scoreRouting(expected, observe(result), true),
      checks: [],
      observation: observe(result),
    };
    const candidate: Attempt = {
      ...base,
      plugin_hash: "after",
      routing: scoreRouting(expected, observe(delivered(body), result), true),
      checks: [
        { id: "preserve:actions", status: "failed", evidence: "Removed" },
      ],
    };
    writeFileSync(
      join(root, "base.json"),
      JSON.stringify({ attempts: [base] }),
    );
    writeFileSync(
      join(root, "candidate.json"),
      JSON.stringify({ attempts: [candidate] }),
    );
    compareReports(join(root, "base.json"), join(root, "candidate.json"), root);
    expect(
      JSON.parse(readFileSync(join(root, "comparison.json"), "utf8"))[0],
    ).toMatchObject({
      group: "improved in sample",
      candidate_failed_checks: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline mocked CLI verifies attempt isolation and artifact capture without model calls", async () => {
  const { chmodSync, mkdirSync } = await import("node:fs");
  const { runFocusedCases } =
    await import("../../../app_builder/run-focused-cases.ts");
  const root = mkdtempSync(join(tmpdir(), "focused-offline-"));
  const old = {
    PATH: process.env.PATH,
    CI: process.env.CI,
    SKILL_EVAL_REMOTE: process.env.SKILL_EVAL_REMOTE,
  };
  try {
    const bin = join(root, "bin");
    const plugin = join(root, "plugin");
    const fixtures = join(root, "fixtures");
    mkdirSync(bin);
    mkdirSync(join(plugin, "skills", "expo-native-ui"), { recursive: true });
    mkdirSync(join(fixtures, "tiny-v1"), { recursive: true });
    writeFileSync(
      join(plugin, "skills", "expo-native-ui", "SKILL.md"),
      `---\nname: expo-native-ui\n---\n${body}`,
    );
    writeFileSync(join(fixtures, "tiny-v1", "package.json"), "{}");
    writeFileSync(
      join(fixtures, "tiny-v1", "App.tsx"),
      "export default function App() { return null; }",
    );
    const stub = join(bin, "claude");
    const trace = [
      { type: "system", subtype: "init", skills: ["expo:expo-native-ui"] },
      use("Skill", { skill: "expo:expo-native-ui" }),
      delivered(body),
      result,
    ];
    writeFileSync(
      stub,
      `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nif (process.argv.includes("--version")) console.log("offline-stub-1");\nelse { writeFileSync("attempt-home.txt", process.env.CLAUDE_CONFIG_DIR); for (const row of ${JSON.stringify(trace)}) console.log(JSON.stringify(row)); }\n`,
    );
    chmodSync(stub, 0o755);
    process.env.PATH = `${bin}:${old.PATH}`;
    process.env.CI = "1";
    process.env.SKILL_EVAL_REMOTE = "1";
    const out = join(root, "out");
    const args: Parameters<typeof runFocusedCases>[0] = {
      cases: [
        {
          id: "tiny",
          family: "tiny",
          split: "development",
          fixture: "tiny-v1",
          prompt: "Synthetic offline test",
          expect: expected,
          before_edit: true,
          unchanged: ["App.tsx"],
          review: ["Review stays pending"],
        },
      ],
      fixtures,
      plugin,
      out,
      model: "offline-stub",
      repetitions: 2,
      timeoutSeconds: 5,
      maxTurns: 2,
    };
    const runs = await runFocusedCases(args);
    expect(runs.map((run) => run.status)).toEqual(["complete", "complete"]);
    expect(runs[0]?.condition).toBe(runs[1]?.condition);
    expect(runs[0]?.routing[0]?.status).toBe("passed");
    expect(runs[0]?.checks.at(-1)?.status).toBe("pending");
    const firstHome = readFileSync(
      join(out, "tiny/1/app/attempt-home.txt"),
      "utf8",
    );
    const secondHome = readFileSync(
      join(out, "tiny/2/app/attempt-home.txt"),
      "utf8",
    );
    expect(firstHome).not.toBe(secondHome);
    expect(existsSync(firstHome)).toBe(false);
    expect(existsSync(join(out, "tiny/1/raw.jsonl"))).toBe(true);
    expect(
      readFileSync(join(out, "catalog/skills/expo-native-ui/SKILL.md"), "utf8"),
    ).toContain(body);
    expect(existsSync(join(out, "tiny/1/app/manifest.json"))).toBe(false);
    writeFileSync(
      stub,
      `#!${process.execPath}
if (process.argv.includes("--version")) console.log("offline-stub-1");
else {
  const installed = process.argv.includes("--plugin-dir");
  console.log(JSON.stringify({type:"system",subtype:"init",skills:installed ? ["expo:expo-native-ui"] : ["debug"]}));
  for (const row of (installed ? ${JSON.stringify(trace)} : [${JSON.stringify(result)}])) console.log(JSON.stringify(row));
}
`,
    );
    const both = await runFocusedCases({
      ...args,
      out: join(out, "both"),
      skillMode: "both",
    });
    expect(both.map((run) => run.skill_mode)).toEqual([
      "without-expo",
      "with-expo",
      "with-expo",
      "without-expo",
    ]);
    expect(both.every((run) => run.status === "complete")).toBe(true);
    expect(new Set(both.map((run) => run.condition)).size).toBe(1);
    expect(both[0]?.routing).toEqual([]);
    expect(both[0]?.plugin_hash).toBe("absent");
    expect(existsSync(join(out, "both/without-expo/tiny/1/raw.jsonl"))).toBe(
      true,
    );
    expect(existsSync(join(out, "both/with-expo/tiny/1/raw.jsonl"))).toBe(true);
    expect(readFileSync(join(out, "both/report.html"), "utf8")).toContain(
      'href="without-expo/tiny/1/raw.jsonl"',
    );
    // An empty or incomplete with-Expo catalog cannot masquerade as a tie.
    for (const skills of [[], null, ["expo:other-skill"]]) {
      writeFileSync(stub, `#!${process.execPath}
if (process.argv.includes("--version")) console.log("offline-stub-1");
else {
  console.log(JSON.stringify({type:"system",subtype:"init",skills:${JSON.stringify(skills)}}));
  console.log(${JSON.stringify(JSON.stringify(result))});
}`);
      const missing = await runFocusedCases({ ...args, out: join(root, "missing-" + String(skills)), repetitions: 1, skillMode: "both" });
      expect(missing.find((run) => run.skill_mode === "with-expo")?.status).toBe("infrastructure_error");
      expect(summarize(missing).every((row) => row.paired_conditions !== "matched")).toBe(true);
    }
    // The same trace must not become a valid absence control if Expo leaked in.
    writeFileSync(
      stub,
      `#!${process.execPath}
if (process.argv.includes("--version")) console.log("offline-stub-1");
else for (const row of ${JSON.stringify(trace)}) console.log(JSON.stringify(row));
`,
    );
    const contaminated = await runFocusedCases({
      ...args,
      out: join(out, "contaminated"),
      skillMode: "without-expo",
      repetitions: 1,
    });
    expect(contaminated[0]?.status).toBe("infrastructure_error");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
