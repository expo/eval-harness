import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Case } from "./cases.ts";

export type Check = {
  id: string;
  status: "passed" | "failed" | "pending" | "unavailable";
  evidence: string;
};

// Compare the complete authored fixture, including new/deleted files. Symlinks
// are changes, never followed. These small fixtures contain no installed deps.
export function unchangedTree(fixture: string, workspace: string): Check {
  const files = (root: string): Map<string, string> => {
    const result = new Map<string, string>();
    const visit = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), {
        withFileTypes: true,
      })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) result.set(path, "symlink");
        else if (entry.isDirectory()) visit(path);
        else
          result.set(path, readFileSync(join(root, path)).toString("base64"));
      }
    };
    visit("");
    return result;
  };
  const before = files(fixture),
    after = files(workspace);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
  return {
    id: "read-only-tree",
    status: changed.length ? "failed" : "passed",
    evidence: changed.length
      ? `Changed, added or deleted: ${changed.join(", ")}`
      : "All fixture files preserved; no added files",
  };
}

export async function checkOutcomes(
  item: Case,
  fixture: string,
  workspace: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  if (item.read_only) checks.push(unchangedTree(fixture, workspace));
  for (const contract of item.checks ?? []) {
    const ids = OUTCOME_CHECKS[contract];
    // Execute authored code only in a separate, time-bounded process. Do not
    // pass the authoring job's API keys to the verifier. This is not a sandbox.
    const child = Bun.spawn(
      [
        contract === "expo-config-contract" ? "node" : process.execPath,
        join(
          import.meta.dir,
          contract === "http-response-contract"
            ? "verify-http.ts"
            : "verify-expo-config.ts",
        ),
        workspace,
        fixture,
      ],
      {
        cwd: workspace,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);
    try {
      const [exit, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0 || timedOut)
        throw new Error(
          timedOut
            ? "Verifier timed out"
            : `Verifier exited ${exit}: ${error.slice(0, 500)}`,
        );
      const rows = JSON.parse(
        output.trim().split("\n").at(-1) ?? "",
      ) as Check[];
      if (
        !Array.isArray(rows) ||
        rows.length !== 3 ||
        rows.some(
          (row, index) =>
            row.id !== ids[index] ||
            !["passed", "failed"].includes(row.status) ||
            typeof row.evidence !== "string",
        )
      )
        throw new Error("Invalid verifier output");
      checks.push(...rows);
    } catch (error) {
      checks.push({
        id: contract,
        status: "unavailable",
        evidence: String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return checks;
}

export const OUTCOME_CHECKS = {
  "http-response-contract": [
    "http-error-no-parse",
    "http-success-data",
    "network-error",
  ],
  "expo-config-contract": [
    "expo-config-default",
    "expo-config-empty",
    "expo-config-environment",
  ],
} as const;
