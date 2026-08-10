import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyzeArtifacts, printSummary } from "./analysis.ts";
import { unpackArtifact } from "./utils.ts";

const PACKAGE_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../../..");
const DEFAULT_CHECKS_DIR = path.resolve(PACKAGE_DIR, "uptake_checks");
const DEFAULT_PRD_SKILLS = path.resolve(REPO_ROOT, "dataset/prd_skills.json");

const TOP_LEVEL_HELP = `usage: main.ts [-h] {analyze-artifacts} ...

Expo skill-eval helpers

positional arguments:
  {analyze-artifacts}
    analyze-artifacts  Analyze authored/eval EAS artifacts

options:
  -h, --help           show this help message and exit
`;

const ANALYZE_HELP = `usage: main.ts analyze-artifacts [-h] --authored-artifact AUTHORED_ARTIFACT
                                 [--eval-artifact EVAL_ARTIFACT] --scenario SCENARIO
                                 --out-dir OUT_DIR [--prd-skills PRD_SKILLS]
                                 [--checks-dir CHECKS_DIR]

options:
  -h, --help            show this help message and exit
  --authored-artifact AUTHORED_ARTIFACT
  --eval-artifact EVAL_ARTIFACT
  --scenario SCENARIO
  --out-dir OUT_DIR
  --prd-skills PRD_SKILLS
                        Path to the app -> expected-skills ground-truth map
                        (default: dataset/prd_skills.json)
  --checks-dir CHECKS_DIR
                        Directory of checks_data.json + skill_map.json providing
                        uptake checks per skill (default: uptake_checks)
`;

type AnalyzeOptions = {
  authoredArtifact: string;
  evalArtifact: string | null;
  scenario: string;
  outDir: string;
  prdSkills: string;
  checksDir: string;
};

export async function runCli(argv: string[]): Promise<number> {
  if (argv.length === 0) return usageError("the following arguments are required: cmd");
  const command = argv[0];
  if (command === "-h" || command === "--help") {
    process.stdout.write(TOP_LEVEL_HELP);
    return 0;
  }
  if (command !== "analyze-artifacts") {
    return usageError(
      `argument cmd: invalid choice: '${command ?? ""}' (choose from 'analyze-artifacts')`,
    );
  }
  const parsed = parseAnalyzeOptions(argv.slice(1));
  if (typeof parsed === "number") return parsed;
  const scratch = mkdtempSync(path.join(tmpdir(), "expo-skill-eval-"));
  try {
    const authored = unpackArtifact(
      parsed.authoredArtifact,
      path.join(scratch, "authored"),
    );
    const evalArtifact = parsed.evalArtifact === null ||
        ["undefined", "null", ""].includes(parsed.evalArtifact)
      ? null
      : unpackArtifact(parsed.evalArtifact, path.join(scratch, "eval"));
    const payload = await analyzeArtifacts({
      authoredArtifact: authored,
      evalArtifact,
      scenario: parsed.scenario,
      outDir: parsed.outDir,
      prdSkillsPath: parsed.prdSkills,
      checksDir: parsed.checksDir,
      authoredArtifactDisplayRoot: parsed.authoredArtifact,
      ...(evalArtifact === null || parsed.evalArtifact === null
        ? {}
        : { evalArtifactDisplayRoot: parsed.evalArtifact }),
    });
    printSummary(payload);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseAnalyzeOptions(argv: string[]): AnalyzeOptions | number {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(ANALYZE_HELP);
    return 0;
  }
  const values = new Map<string, string>();
  const known = new Set([
    "--authored-artifact",
    "--eval-artifact",
    "--scenario",
    "--out-dir",
    "--prd-skills",
    "--checks-dir",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const equal = token.indexOf("=");
    const rawOption = equal === -1 ? token : token.slice(0, equal);
    const matches = [...known].filter((candidate) =>
      candidate.startsWith(rawOption)
    );
    const option = known.has(rawOption)
      ? rawOption
      : matches.length === 1
        ? (matches[0] ?? null)
        : null;
    if (option === null) {
      if (matches.length > 1) {
        return analyzeUsageError(
          `ambiguous option: ${rawOption} could match ${matches.join(", ")}`,
        );
      }
      return analyzeUsageError(`unrecognized arguments: ${token}`);
    }
    const value = equal === -1 ? argv[index + 1] : token.slice(equal + 1);
    if (value === undefined || (equal === -1 && value.startsWith("--"))) {
      return analyzeUsageError(`argument ${option}: expected one argument`);
    }
    values.set(option, value);
    if (equal === -1) index += 1;
  }
  const missing = ["--authored-artifact", "--scenario", "--out-dir"]
    .filter((option) => !values.has(option));
  if (missing.length > 0) {
    return analyzeUsageError(
      `the following arguments are required: ${missing.join(", ")}`,
    );
  }
  return {
    authoredArtifact: values.get("--authored-artifact") ?? "",
    evalArtifact: values.get("--eval-artifact") ?? null,
    scenario: values.get("--scenario") ?? "",
    outDir: values.get("--out-dir") ?? "",
    prdSkills: values.get("--prd-skills") ?? DEFAULT_PRD_SKILLS,
    checksDir: values.get("--checks-dir") ?? DEFAULT_CHECKS_DIR,
  };
}

function usageError(message: string): 2 {
  process.stderr.write(`usage: main.ts [-h] {analyze-artifacts} ...\nmain.ts: error: ${message}\n`);
  return 2;
}

function analyzeUsageError(message: string): 2 {
  process.stderr.write(
    `usage: main.ts analyze-artifacts [-h] --authored-artifact AUTHORED_ARTIFACT\n` +
      `                                 [--eval-artifact EVAL_ARTIFACT] --scenario SCENARIO\n` +
      `                                 --out-dir OUT_DIR [--prd-skills PRD_SKILLS]\n` +
      `                                 [--checks-dir CHECKS_DIR]\n` +
      `main.ts analyze-artifacts: error: ${message}\n`,
  );
  return 2;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
