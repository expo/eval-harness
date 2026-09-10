import path from "node:path";
import { runCli as packageRunCli } from "@expo/skill-analyzer/cli";

/** Legacy harness CLI supplies this repository's ground truth. */
export function runCli(argv: string[]): Promise<number> {
  return packageRunCli(argv, {
    prdSkills: path.resolve(import.meta.dir, "../../../dataset/prd_skills.json"),
  });
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
