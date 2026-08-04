import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESULT_FILENAME = ".eval-build-health-bundle.json";
const TIMEOUT_MILLISECONDS = 180_000;

export type BundleResult = { ok: boolean | null; reason?: string };

export function computeBundleResult(appDir: string): BundleResult {
  const expoBin = join(appDir, "node_modules", ".bin", "expo");
  if (!existsSync(expoBin)) {
    return { ok: null, reason: "no node_modules/.bin/expo in workspace" };
  }
  const exportDir = join(appDir, ".eval-bundle-export-tmp");
  try {
    const result = Bun.spawnSync(
      [expoBin, "export", "--platform", "ios", "--output-dir", exportDir],
      {
        cwd: appDir,
        stdout: "pipe",
        stderr: "pipe",
        timeout: TIMEOUT_MILLISECONDS,
      },
    );
    if (result.exitedDueToTimeout === true) {
      return {
        ok: false,
        reason: `expo export timed out after ${TIMEOUT_MILLISECONDS / 1000}s`,
      };
    }
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      const stdout = new TextDecoder().decode(result.stdout);
      return { ok: false, reason: (stderr || stdout).slice(-1500) };
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `failed to invoke expo export: ${detail}` };
  } finally {
    try {
      rmSync(exportDir, { recursive: true, force: true });
    } catch {
      // Match shutil.rmtree(..., ignore_errors=True): cleanup must never hide
      // the build-health result we already computed.
    }
  }
}

export function persistBundleResult(appDir: string): BundleResult {
  const result = computeBundleResult(appDir);
  writeFileSync(join(appDir, RESULT_FILENAME), JSON.stringify(result), "utf8");
  return result;
}

export function readBundleResult(appDir: string): BundleResult | null {
  const path = join(appDir, RESULT_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BundleResult;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const workspace = process.argv[2];
  if (workspace === undefined) {
    console.error("usage: bun bundle_check.ts <workspace-dir>");
    process.exit(2);
  }
  const outcome = persistBundleResult(workspace);
  console.log(`bundle check: ${JSON.stringify(outcome)}`);
}
