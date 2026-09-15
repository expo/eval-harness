import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { packageDirectory, validateTag, validateVersion } from './publish.ts';

export function validateManifest(
  manifest: Record<string, any>,
  name: string,
  version: string
): void {
  if (manifest.name !== name || manifest.version !== version || manifest.private) {
    throw new Error(
      'Packed package name/version differs from the requested release, or is private'
    );
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range !== 'string' || /^(catalog|workspace|file|link):/.test(range)) {
        throw new Error(`Unresolved dependency: ${dependency}@${range}`);
      }
      if (dependency === '@expo/source-scan' && field !== 'devDependencies') {
        throw new Error('Private source-scan must not be a consumer dependency');
      }
    }
  }
}

if (import.meta.main) {
  const name = process.env.NPM_PACKAGE ?? '';
  const version = process.env.NPM_VERSION ?? '';
  const tag = process.env.NPM_TAG ?? '';
  const directory = packageDirectory(name);
  validateVersion(version);
  validateTag(tag);
  if (version.split('+')[0]!.includes('-') && tag === 'latest')
    throw new Error('Prereleases require a prerelease dist-tag');
  const manifest = await Bun.file(`${directory}/package.json`).json();
  // Validate the requested version before doing the build.
  if (manifest.name !== name || manifest.version !== version || manifest.private)
    throw new Error('Release does not match package.json');
  const tarball = resolve(process.env.RUNNER_TEMP ?? '/tmp', 'eval-release.tgz');
  const pack = spawnSync('bun', ['pm', 'pack', '--filename', tarball], {
    cwd: directory,
    stdio: 'inherit',
  });
  if (pack.status !== 0) throw new Error('bun pm pack failed');
  const packed = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`Cannot inspect tarball: ${packed.stderr}`);
  validateManifest(JSON.parse(packed.stdout), name, version);
  console.log(`Prepared ${name}@${version}: ${tarball}`);
}
