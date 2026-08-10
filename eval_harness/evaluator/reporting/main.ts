#!/usr/bin/env bun

import { normalizeRunWithEvidence } from "./normalize.ts";
import type { ReportInputs } from "./types.ts";

const HELP = `usage: bun eval_harness/evaluator/reporting/main.ts \\
  --authored-artifact PATH [--skill-artifact PATH] [--ios-artifact PATH] \\
  --out-dir PATH`;

function usageError(message: string): 2 {
  process.stderr.write(`${HELP}\nerror: ${message}\n`);
  return 2;
}

export function parseArgs(argv: string[]): ReportInputs | 2 | 0 {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const values = new Map<string, string>();
  const supported = new Set([
    "--authored-artifact",
    "--skill-artifact",
    "--ios-artifact",
    "--out-dir",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === undefined || !supported.has(option)) {
      return usageError(`unrecognized argument: ${String(option)}`);
    }
    if (value === undefined || value.startsWith("--")) {
      return usageError(`${option} requires a path`);
    }
    if (values.has(option)) return usageError(`${option} was supplied more than once`);
    values.set(option, value);
  }
  const authoredArtifact = values.get("--authored-artifact");
  const outDir = values.get("--out-dir");
  if (authoredArtifact === undefined || outDir === undefined) {
    return usageError("--authored-artifact and --out-dir are required");
  }
  return {
    authoredArtifact,
    skillArtifact: values.get("--skill-artifact") ?? null,
    iosArtifact: values.get("--ios-artifact") ?? null,
    outDir,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const inputs = parseArgs(argv);
  if (typeof inputs === "number") return inputs;
  await normalizeRunWithEvidence(inputs);
  process.stdout.write(`eval report machine data: ${inputs.outDir}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
