import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'expo/eval-experiments';
export const PACKAGES = {
  '@expo/agent-eval-vitest': 'packages/agent-eval-vitest',
  '@expo/skill-analyzer': 'packages/skill-analyzer',
} as const;

export function packageDirectory(name: string): string {
  if (!Object.hasOwn(PACKAGES, name)) throw new Error(`Unsupported package: ${name}`);
  return PACKAGES[name as keyof typeof PACKAGES];
}

export function validateVersion(version: string): void {
  const number = '(0|[1-9][0-9]*)';
  const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
  const pattern = new RegExp(
    `^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`
  );
  if (
    !pattern.test(version) ||
    version
      .split(/[.+-]/)
      .slice(0, 3)
      .some((part) => !Number.isSafeInteger(Number(part)))
  ) {
    throw new Error(`Invalid version: ${version}`);
  }
}

export function validateTag(tag: string): void {
  // npm rejects tags that can be interpreted as semver ranges.
  if (
    !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(tag) ||
    /^(?:[xX](?:\.(?:[0-9]+|[xX])){0,2}|[vV][0-9].*)$/.test(tag)
  ) {
    throw new Error(`Invalid npm tag: ${tag}`);
  }
}

export function parseArgs(argv: readonly string[]) {
  const options = {
    package: '@expo/agent-eval-vitest',
    tag: 'latest',
    version: '',
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (
      arg === '--package' ||
      arg === '--tag' ||
      arg.startsWith('--package=') ||
      arg.startsWith('--tag=')
    ) {
      const key = arg.startsWith('--package') ? 'package' : 'tag';
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    } else if (arg.startsWith('-') || options.version)
      throw new Error(`Unexpected argument: ${arg}`);
    else options.version = arg;
  }
  return options;
}

// Bun 1.3.14 keeps cached workspace versions on a version-only install. Update
// this metadata in place so unrelated dependency resolutions remain untouched.
export function updateLockVersion(
  lock: string,
  directory: string,
  previous: string,
  version: string
): string {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^    "${escaped}": \\{\\n[^{}]*?"version": ")([^"\\n]+)(")`, 'm');
  const match = pattern.exec(lock);
  if (!match || match[2] !== previous)
    throw new Error('Unexpected workspace version in bun.lock; update it before releasing');
  return lock.replace(pattern, (_match, prefix, _old, suffix) => `${prefix}${version}${suffix}`);
}

export interface PublishIo {
  read(path: string): string;
  write(path: string, content: string): void;
  run(command: string, args: string[]): { status: number; stdout: string; stderr: string };
  log(message: string): void;
}

export function publish(argv: string[], io: PublishIo): void {
  const options = parseArgs(argv);
  if (options.help) {
    io.log(
      'Usage: bun scripts/publish.ts [version] [--package @expo/agent-eval-vitest|@expo/skill-analyzer] [--tag latest] [--dry-run]\nOmitting version bumps the patch. Commits package.json and bun.lock, pushes the current branch, then dispatches publish.yml.'
    );
    return;
  }
  const directory = packageDirectory(options.package);
  validateTag(options.tag);
  const path = `${directory}/package.json`;
  const manifest = JSON.parse(io.read(path));
  if (manifest.name !== options.package || manifest.private)
    throw new Error('Package manifest is not publishable');
  validateVersion(manifest.version);
  const [major, minor, patch] = (manifest.version as string).split(/[.+-]/);
  const version = options.version || `${major}.${minor}.${Number(patch) + 1}`;
  validateVersion(version);
  if (version.split('+')[0]!.includes('-') && options.tag === 'latest')
    throw new Error('Use --tag next (or another prerelease tag) for prerelease versions');
  const run = (command: string, args: string[]) => {
    const result = io.run(command, args);
    if (result.status !== 0)
      throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const branch = run('git', ['branch', '--show-current']);
  if (!branch) throw new Error('Cannot release from a detached HEAD');
  if (run('git', ['status', '--porcelain'])) throw new Error('Working tree must be clean');
  const remote = run('git', ['remote', 'get-url', 'origin']);
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)expo\/eval-experiments(?:\.git)?$/.test(remote)
  ) {
    throw new Error(`origin must point to ${REPOSITORY}`);
  }
  const lookup = io.run('npm', [
    'view',
    `${options.package}@${version}`,
    'version',
    '--json',
    '--registry=https://registry.npmjs.org',
  ]);
  if (lookup.status === 0) throw new Error(`${options.package}@${version} is already published`);
  let code: string | undefined;
  try {
    code = JSON.parse(lookup.stdout).error?.code;
  } catch {
    /* npm may emit JSON on stderr */
  }
  if (!code) {
    try {
      code = JSON.parse(lookup.stderr).error?.code;
    } catch {
      /* reported below */
    }
  }
  if (code !== 'E404')
    throw new Error(`Cannot check npm version: ${lookup.stderr || lookup.stdout}`);
  io.log(
    `${options.dryRun ? '[dry-run] ' : ''}Publish ${options.package}@${version} with tag ${options.tag} from ${branch}`
  );
  if (options.dryRun) return;
  if (version !== manifest.version) {
    const lock = updateLockVersion(io.read('bun.lock'), directory, manifest.version, version);
    io.write(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
    io.write('bun.lock', lock);
    run('bun', ['install', '--lockfile-only', '--ignore-scripts']);
    run('git', ['add', '--', path, 'bun.lock']);
    run('git', ['commit', '-m', `Publish ${options.package}@${version}`]);
  }
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  run('gh', [
    'workflow',
    'run',
    'publish.yml',
    '--repo',
    REPOSITORY,
    '--ref',
    branch,
    '--raw-field',
    `package=${options.package}`,
    '--raw-field',
    `version=${version}`,
    '--raw-field',
    `tag=${options.tag}`,
  ]);
  io.log(
    `Dispatched publish.yml. Follow the run at https://github.com/${REPOSITORY}/actions/workflows/publish.yml`
  );
}

if (import.meta.main) {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  try {
    publish(process.argv.slice(2), {
      read: (path) => readFileSync(`${cwd}/${path}`, 'utf8'),
      write: (path, content) => writeFileSync(`${cwd}/${path}`, content),
      log: console.log,
      run: (command, args) => {
        const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? '',
          stderr: result.error?.message ?? result.stderr ?? '',
        };
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
