import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrepareContext, ProjectSetup } from './types.js';

/** Declarative inputs for preparing an Expo evaluation workspace. */
export interface ExpoProjectSetup {
  packageName: string;
  packageRoot: URL | string;
  skillDir: URL | string;
  fixturesDir: URL | string;
  fixture?: string | string[];
  dependencies?: Record<string, string>;
  files?: Record<string, string>;
  prepareAsync?: (context: PrepareContext) => void | Promise<void>;
  /** Optional prepared base copied before named fixtures. */
  baseDirectory?: URL | string;
  /** Optional scaffold opt-in: exact create-expo-app version, never latest. */
  createExpoAppVersion?: string;
  /** Required with createExpoAppVersion; pin the template for reproducible runs. */
  baseTemplate?: string;
}
const toPath = (value: URL | string) =>
  path.resolve(
    value instanceof URL || String(value).startsWith('file:') ? fileURLToPath(value) : value
  );

/** Resolve a workspace-relative path, rejecting traversal and symlink ancestors. */
function inside(root: string, relative: string, allowLeafLink = false): string {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error(`Expected a safe relative path: ${relative}`);
  }
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${relative}`);
  }
  const parts = path.relative(root, target).split(path.sep);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    if (
      fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() &&
      !(allowLeafLink && i === parts.length - 1)
    ) {
      throw new Error(`Symlink in prepared path: ${relative}`);
    }
  }
  return target;
}

// Prepared inputs are regular files/directories. Refuse links instead of copying
// a fixture that could cause later overlays to write outside the workspace.
function copyLayer(source: string, root: string, signal: AbortSignal, excludeEvals = false): void {
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(`Expected fixture directory: ${source}`);
  }
  const walk = (directory: string, prefix = '') => {
    signal.throwIfAborted();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || (excludeEvals && entry.name === '.evals')) {
        continue;
      }
      const relative = path.join(prefix, entry.name);
      const target = inside(root, relative);
      const sourcePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinks are not supported in fixtures: ${sourcePath}`);
      }
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        walk(sourcePath, relative);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(sourcePath, target);
      } else {
        throw new Error(`Unsupported fixture entry: ${sourcePath}`);
      }
    }
  };
  walk(source);
}

/**
 * Prepare an Expo project for an agent evaluation. Prepared fixture layers
 * are the default; no network or dependency install runs unless requested via
 * pinned scaffolding or prepareAsync.
 */
export function createExpoProject(options: ExpoProjectSetup): ProjectSetup<void> {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(options.packageName)) {
    throw new Error('Invalid npm packageName');
  }
  if (options.createExpoAppVersion !== undefined || options.baseTemplate !== undefined) {
    if (
      !options.createExpoAppVersion ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.createExpoAppVersion)
    ) {
      throw new Error('Scaffolding requires an exact createExpoAppVersion');
    }
    if (!options.baseTemplate || options.baseTemplate.startsWith('-')) {
      throw new Error('Scaffolding requires an explicit baseTemplate');
    }
    if (options.baseDirectory) {
      throw new Error('Choose baseDirectory or scaffolding, not both');
    }
  }
  const packageRoot = toPath(options.packageRoot);
  const skillDir = toPath(options.skillDir);
  const fixturesDir = toPath(options.fixturesDir);
  const skillName = `npm-${options.packageName.replace(/^@/, '').replace(/\//g, '-')}-${path.basename(skillDir)}`;
  return {
    async prepareAsync(context) {
      const { signal } = context;
      signal.throwIfAborted();
      const root = fs.realpathSync(context.root);
      const canonicalPackageRoot = fs.realpathSync(packageRoot);
      if (canonicalPackageRoot === root || canonicalPackageRoot.startsWith(root + path.sep)) {
        throw new Error('Package under test must be outside the workspace');
      }
      const localPackage = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
      );
      if (localPackage.name !== options.packageName) {
        throw new Error(`packageRoot name does not match ${options.packageName}`);
      }
      if (options.createExpoAppVersion) {
        const [major, minor] = options.createExpoAppVersion.split('.').map(Number);
        // Agent file generation and this opt-out were introduced in 3.7.0.
        const supportsAgentFiles = major! > 3 || (major === 3 && minor! >= 7);
        await context.runAsync(
          'npx',
          [
            '--yes',
            `create-expo-app@${options.createExpoAppVersion}`,
            context.root,
            '--template',
            options.baseTemplate!,
            '--no-install',
            '--yes',
            ...(supportsAgentFiles ? ['--no-agents-md'] : []),
          ],
          { timeoutMs: 600_000 }
        );
      }
      signal.throwIfAborted();
      if (options.baseDirectory) {
        copyLayer(toPath(options.baseDirectory), root, signal);
      }
      for (const fixture of [options.fixture ?? []].flat()) {
        copyLayer(inside(fixturesDir, fixture), root, signal);
      }
      for (const [relative, contents] of Object.entries(options.files ?? {})) {
        signal.throwIfAborted();
        const target = inside(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
      }
      const manifestPath = inside(root, 'package.json');
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        : { private: true };
      manifest.dependencies = {
        ...manifest.dependencies,
        ...options.dependencies,
        [options.packageName]: `file:${packageRoot}`,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      await options.prepareAsync?.(context);
      signal.throwIfAborted();
      // Installation in the preparation hook may replace the local checkout;
      // restore its dependency and link so the agent uses the package under test.
      const updatedPath = inside(root, 'package.json');
      const updated = JSON.parse(fs.readFileSync(updatedPath, 'utf8'));
      updated.dependencies = {
        ...updated.dependencies,
        [options.packageName]: `file:${packageRoot}`,
      };
      fs.writeFileSync(updatedPath, JSON.stringify(updated, null, 2) + '\n');
      const packageLink = inside(root, path.join('node_modules', options.packageName), true);
      fs.mkdirSync(path.dirname(packageLink), { recursive: true });
      fs.rmSync(packageLink, { recursive: true, force: true });
      fs.symlinkSync(packageRoot, packageLink, process.platform === 'win32' ? 'junction' : 'dir');
      const skillTarget = inside(root, path.join('.claude', 'skills', skillName), true);
      fs.rmSync(skillTarget, { recursive: true, force: true });
      if (context.condition === 'with-skill') {
        fs.mkdirSync(skillTarget, { recursive: true });
        copyLayer(skillDir, skillTarget, signal, true);
      }
    },
  };
}
