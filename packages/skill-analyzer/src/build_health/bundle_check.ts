import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RESULT_FILENAME = '.eval-build-health-bundle.json';
const TIMEOUT_MILLISECONDS = 180_000;

export type BundleResult = { ok: boolean | null; reason?: string };
export type BundlePlatform = 'ios' | 'android';
export type BundleOptions = { platform?: BundlePlatform };

export function computeBundleResult(appDir: string, options: BundleOptions = {}): BundleResult {
  const platform = options.platform ?? 'ios';
  const expoBin = join(appDir, 'node_modules', '.bin', 'expo');
  if (!existsSync(expoBin)) {
    return { ok: null, reason: 'no node_modules/.bin/expo in workspace' };
  }
  const exportDir = join(appDir, '.eval-bundle-export-tmp');
  try {
    const result = Bun.spawnSync(
      [expoBin, 'export', '--platform', platform, '--output-dir', exportDir],
      {
        cwd: appDir,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: TIMEOUT_MILLISECONDS,
      }
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

export function persistBundleResult(appDir: string, options: BundleOptions = {}): BundleResult {
  const result = computeBundleResult(appDir, options);
  writeFileSync(join(appDir, RESULT_FILENAME), JSON.stringify(result), 'utf8');
  return result;
}

export function readBundleResult(appDir: string): BundleResult | null {
  const path = join(appDir, RESULT_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BundleResult;
  } catch {
    return null;
  }
}

export function main(args: string[] = process.argv.slice(2)): number {
  const [workspace, ...options] = args;
  if (workspace === undefined) {
    console.error('usage: skill-analyzer bundle-check <workspace-dir> [--platform ios|android]');
    return 2;
  }
  let platform: BundlePlatform = 'ios';
  if (options.length === 2 && options[0] === '--platform') {
    const requestedPlatform = options[1];
    if (requestedPlatform !== 'ios' && requestedPlatform !== 'android') {
      console.error('error: --platform must be ios or android');
      return 2;
    }
    platform = requestedPlatform;
  } else if (options.length !== 0) {
    console.error('usage: skill-analyzer bundle-check <workspace-dir> [--platform ios|android]');
    return 2;
  }
  const outcome = persistBundleResult(workspace, { platform });
  console.log(`bundle check: ${JSON.stringify(outcome)}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
