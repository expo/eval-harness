import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { loadCases } from "./cases.ts";
import { compareReports } from "./report.ts";
import { runFocusedCases } from "../../../app_builder/run-focused-cases.ts";

const ROOT = resolve(import.meta.dir, "../../../..");
const HELP = `Focused skill evaluations
  validate --plugin PATH [--cases FILE] [--fixtures DIR]
  run --plugin PATH --out DIR --model MODEL [--case ID] [--split development|validation|holdout]
      [--repetitions 3] [--timeout 300] [--max-turns 20]
  compare --baseline METRICS --candidate METRICS --out DIR

run is CI-only. validate and compare make no model calls.
The default split is development. Holdout must be explicitly selected.
`;
export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: Object.fromEntries(
      [
        "plugin",
        "cases",
        "fixtures",
        "out",
        "model",
        "case",
        "split",
        "repetitions",
        "timeout",
        "max-turns",
        "baseline",
        "candidate",
      ].map((key) => [key, { type: "string" as const }]),
    ),
    strict: true,
  });
  const required = (name: string) => {
    const value = values[name];
    if (typeof value !== "string" || !value)
      throw new Error(`--${name} is required`);
    return value;
  };
  if (command === "compare") {
    compareReports(
      required("baseline"),
      required("candidate"),
      required("out"),
    );
    return 0;
  }
  if (command !== "validate" && command !== "run")
    throw new Error(`Unknown command: ${command}`);
  const plugin = resolve(required("plugin"));
  const fixtures = resolve(
    String(values.fixtures ?? join(ROOT, "dataset/skill-fixtures")),
  );
  const cases = loadCases(
    resolve(String(values.cases ?? join(ROOT, "dataset/skill-cases.json"))),
    fixtures,
    join(plugin, "skills"),
  );
  if (command === "validate") {
    console.log(
      `Validated ${cases.length} cases and their fixtures against ${plugin}`,
    );
    return 0;
  }
  const split = String(values.split ?? "development");
  if (!["development", "validation", "holdout"].includes(split))
    throw new Error("Invalid --split");
  const selected = cases.filter(
    (item) =>
      item.split === split &&
      (values.case === undefined || item.id === values.case),
  );
  if (!selected.length)
    throw new Error("No matching cases in the selected split");
  const positive = (name: string, fallback: number) => {
    const value = Number(values[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`--${name} must be a positive integer`);
    return value;
  };
  const attempts = await runFocusedCases({
    cases: selected,
    fixtures,
    plugin,
    out: resolve(required("out")),
    model: required("model"),
    repetitions: positive("repetitions", 3),
    timeoutSeconds: positive("timeout", 300),
    maxTurns: positive("max-turns", 20),
  });
  // Behavioral failures are advisory. Infrastructure failure makes the job red.
  return attempts.some((run) => run.status === "infrastructure_error") ? 1 : 0;
}
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
