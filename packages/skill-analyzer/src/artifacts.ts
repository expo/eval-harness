#!/usr/bin/env bun

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { t as listArchive, x as extractArchive } from 'tar';

const SAFE_TAR_ENTRY_TYPES = new Set([
  'File',
  'OldFile',
  'ContiguousFile',
  'Directory',
  'Link',
  'SymbolicLink',
]);

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
}

function physicalCandidate(path: string, label: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`unsafe ${label}: no physical parent`);
    suffix.unshift(basename(existing));
    existing = parent;
  }
  const metadata = lstatSync(existing);
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && suffix.length > 0)) {
    throw new Error(`unsafe ${label}: non-directory or symbolic-link parent`);
  }
  return suffix.reduce((candidate, segment) => join(candidate, segment), realpathSync(existing));
}

export function firstArchive(path: string): string | null {
  const entries = readdirSync(path).sort(compareUnicodeCodePoints);
  const matches = entries.filter((entry) =>
    ['.tar.gz', '.tgz', '.tar'].some((suffix) => entry.endsWith(suffix))
  );
  if (matches.length > 1) {
    throw new Error(`ambiguous artifact archives: ${matches.join(', ')}`);
  }
  return matches[0] === undefined ? null : join(path, matches[0]);
}

type TarEntryMetadata = { path: string; type?: string; linkpath?: string };
class UnsafeTarEntryError extends Error {}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsafeTarError(path: string, error: unknown): Error {
  return new Error(
    `Refusing to extract unsafe tar archive ${basename(path)}: ${errorDetail(error)}`
  );
}

function assertPathWithin(path: string, root: string, label: string): void {
  if (inside(root, path)) return;
  throw new UnsafeTarEntryError(`unsafe ${label}`);
}

function assertNoSymlinkParent(path: string, root: string, label: string): void {
  if (path === root) {
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
      throw new Error(`unsafe ${label}: symbolic-link destination ${root}`);
    }
    return;
  }
  let current = dirname(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new UnsafeTarEntryError(`unsafe ${label}: symbolic-link parent ${current}`);
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) throw new UnsafeTarEntryError(`unsafe ${label}`);
    current = parent;
  }
}

function assertNoArchiveSymlinkParent(
  path: string,
  root: string,
  entryPath: string,
  archiveSymlinkPaths: ReadonlySet<string>
): void {
  if (path === root) return;
  let current = dirname(path);
  while (current !== root) {
    if (archiveSymlinkPaths.has(current)) {
      throw new UnsafeTarEntryError(`unsafe tar member through archive symlink: ${entryPath}`);
    }
    const parent = dirname(current);
    if (parent === current) throw new UnsafeTarEntryError(`unsafe tar member: ${entryPath}`);
    current = parent;
  }
}

function validateTarEntry(
  entryPath: string,
  entry: unknown,
  destRoot: string,
  archiveSymlinkPaths: ReadonlySet<string>
): boolean {
  if (entry === null || typeof entry !== 'object') {
    throw new UnsafeTarEntryError(`unsafe tar metadata for ${entryPath}`);
  }
  const tarEntry = entry as { type?: string; linkpath?: string };
  const target = resolve(destRoot, entryPath);
  assertPathWithin(target, destRoot, `tar member ${entryPath}`);
  assertNoSymlinkParent(target, destRoot, `tar member ${entryPath}`);
  assertNoArchiveSymlinkParent(target, destRoot, entryPath, archiveSymlinkPaths);
  if (isAbsolute(entryPath) || entryPath.split(/[\\/]/u).includes('..')) {
    throw new UnsafeTarEntryError(`unsafe tar member: ${entryPath}`);
  }
  if (tarEntry.type === undefined || !SAFE_TAR_ENTRY_TYPES.has(tarEntry.type)) {
    throw new UnsafeTarEntryError(`unsafe tar member type for ${entryPath}`);
  }
  if (target === destRoot && tarEntry.type !== 'Directory') {
    throw new Error(`unsafe non-directory tar root member: ${entryPath}`);
  }
  if (typeof tarEntry.linkpath !== 'string') return true;
  const linkTarget =
    tarEntry.type === 'SymbolicLink'
      ? resolve(dirname(target), tarEntry.linkpath)
      : resolve(destRoot, tarEntry.linkpath);
  assertPathWithin(linkTarget, destRoot, `tar link ${entryPath} -> ${tarEntry.linkpath}`);
  return true;
}

function validateTarEntries(entries: TarEntryMetadata[], destRoot: string): Set<string> {
  const archiveSymlinkPaths = new Set(
    entries
      .filter((entry) => entry.type === 'SymbolicLink')
      .map((entry) => resolve(destRoot, entry.path))
  );
  for (const entry of entries) validateTarEntry(entry.path, entry, destRoot, archiveSymlinkPaths);
  return archiveSymlinkPaths;
}

export function extractTar(path: string, destDir: string): void {
  const archiveMetadata = lstatSync(path);
  if (
    archiveMetadata.isSymbolicLink() ||
    !archiveMetadata.isFile() ||
    archiveMetadata.nlink !== 1
  ) {
    throw new Error('tar archive must be a physical single-link regular file');
  }
  const destRoot = resolve(destDir);
  mkdirSync(destRoot, { recursive: true });
  if (readdirSync(destRoot).length > 0) {
    throw new Error(`Refusing to extract into non-empty destination: ${destRoot}`);
  }
  const entries: TarEntryMetadata[] = [];
  try {
    listArchive({
      file: path,
      sync: true,
      strict: true,
      onReadEntry: (entry) =>
        entries.push({
          path: entry.path,
          type: entry.type,
          ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
        }),
    });
  } catch (error) {
    throw new Error(`Failed to read tar archive ${basename(path)}: ${errorDetail(error)}`);
  }
  let archiveSymlinkPaths: Set<string>;
  try {
    archiveSymlinkPaths = validateTarEntries(entries, destRoot);
  } catch (error) {
    throw unsafeTarError(path, error);
  }
  try {
    extractArchive({
      file: path,
      cwd: destRoot,
      sync: true,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) =>
        validateTarEntry(entryPath, entry, destRoot, archiveSymlinkPaths),
    });
  } catch (error) {
    if (error instanceof UnsafeTarEntryError) throw unsafeTarError(path, error);
    throw new Error(`Failed to extract tar archive ${basename(path)}: ${errorDetail(error)}`);
  }
}

function replaceDirectory(stagingDir: string, destination: string): void {
  const destRoot = resolve(destination);
  if (existsSync(destRoot)) {
    const metadata = lstatSync(destRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`unsafe artifact destination: ${destRoot}`);
    }
    rmSync(destRoot, { recursive: true, force: true });
  }
  renameSync(stagingDir, destRoot);
}

export function unpackArtifact(artifactPath: string, destDir: string): string {
  const metadata = lstatSync(artifactPath);
  if (metadata.isSymbolicLink()) throw new Error('artifact path must not be a symbolic link');
  if (metadata.isDirectory()) {
    const archive = firstArchive(artifactPath);
    if (archive === null) return artifactPath;
    replaceWithExtractedArchive(archive, destDir);
    return destDir;
  }
  if (!metadata.isFile() || metadata.nlink !== 1)
    throw new Error('artifact must be a regular file or directory');
  replaceWithExtractedArchive(artifactPath, destDir);
  return destDir;
}

function replaceWithExtractedArchive(path: string, destDir: string): void {
  const destRoot = resolve(destDir);
  const parent = dirname(destRoot);
  mkdirSync(parent, { recursive: true });
  const stagingDir = mkdtempSync(join(parent, `.${basename(destRoot)}-extract-`));
  try {
    extractTar(path, stagingDir);
    replaceDirectory(stagingDir, destRoot);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function physicalDirectory(path: string, label: string): string {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a physical directory`);
  }
  return realpathSync(path);
}

function safeCopyTree(source: string, destination: string, sourceRoot = source): void {
  const sourcePhysical = physicalDirectory(sourceRoot, 'artifact source');
  const visit = (from: string, to: string): void => {
    const metadata = lstatSync(from);
    const physical = realpathSync(from);
    if (!inside(sourcePhysical, physical))
      throw new Error('unsafe artifact directory entry escape');
    if (metadata.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: metadata.mode });
      for (const entry of readdirSync(from).sort(compareUnicodeCodePoints)) {
        visit(join(from, entry), join(to, entry));
      }
    } else if (metadata.isFile()) {
      if (metadata.nlink !== 1) throw new Error('unsafe hard-linked artifact entry');
      copyFileSync(from, to);
      chmodSync(to, metadata.mode);
    } else if (metadata.isSymbolicLink()) {
      // The physical containment check above rejects escaping links; materialized
      // workflow inputs reject links entirely to avoid later consumer surprises.
      readlinkSync(from);
      throw new Error('unsafe symbolic-link artifact entry');
    } else {
      throw new Error('unsafe special artifact entry');
    }
  };
  visit(source, destination);
}

function selectArtifactRoot(root: string, rootName: string | null): string {
  if (rootName !== null) {
    const nested = join(root, rootName);
    if (existsSync(join(nested, 'manifest.json')))
      return physicalDirectory(nested, 'nested artifact root');
  }
  return physicalDirectory(root, 'artifact root');
}

/** Materialize a verified artifact into an atomically replaced physical directory. */
export function materializeArtifact(
  artifactPath: string,
  destination: string,
  rootName: string | null = null
): string {
  const artifactMetadata = lstatSync(artifactPath);
  if (artifactMetadata.isSymbolicLink())
    throw new Error('artifact path must not be a symbolic link');
  const destRoot = resolve(destination);
  const physicalArtifact = realpathSync(artifactPath);
  const physicalDestination = physicalCandidate(destRoot, 'artifact destination');
  if (
    inside(physicalDestination, physicalArtifact) ||
    (artifactMetadata.isDirectory() && inside(physicalArtifact, physicalDestination))
  ) {
    throw new Error('artifact source and destination must not overlap');
  }
  if (dirname(physicalDestination) === physicalDestination) {
    throw new Error('unsafe artifact destination: filesystem root');
  }
  const destParent = dirname(physicalDestination);
  mkdirSync(destParent, { recursive: true });
  const publishStaging = mkdtempSync(
    join(destParent, `.${basename(physicalDestination)}-materialize-`)
  );
  let extractionStaging: string | null = null;
  try {
    let sourceRoot: string;
    if (artifactMetadata.isDirectory()) {
      const archive = firstArchive(artifactPath);
      if (archive === null) {
        sourceRoot = selectArtifactRoot(physicalDirectory(artifactPath, 'artifact path'), rootName);
      } else {
        extractionStaging = mkdtempSync(
          join(destParent, `.${basename(physicalDestination)}-archive-`)
        );
        extractTar(archive, extractionStaging);
        sourceRoot = selectArtifactRoot(extractionStaging, rootName);
      }
    } else if (artifactMetadata.isFile() && artifactMetadata.nlink === 1) {
      extractionStaging = mkdtempSync(
        join(destParent, `.${basename(physicalDestination)}-archive-`)
      );
      extractTar(artifactPath, extractionStaging);
      sourceRoot = selectArtifactRoot(extractionStaging, rootName);
    } else {
      throw new Error('artifact must be a physical single-link file or directory');
    }
    safeCopyTree(sourceRoot, publishStaging);
    replaceDirectory(publishStaging, physicalDestination);
    if (extractionStaging !== null) rmSync(extractionStaging, { recursive: true, force: true });
    return destRoot;
  } catch (error) {
    rmSync(publishStaging, { recursive: true, force: true });
    if (extractionStaging !== null) rmSync(extractionStaging, { recursive: true, force: true });
    throw error;
  }
}

function usage(message: string): never {
  throw new Error(
    `usage: skill-analyzer materialize --artifact PATH --dest PATH [--root-name NAME]\n${message}`
  );
}

function cli(argv: string[]): number {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !['--artifact', '--dest', '--root-name'].includes(key))
      usage(`unknown option ${String(key)}`);
    if (value === undefined) usage(`${key} requires a value`);
    values.set(key, value);
  }
  const artifact = values.get('--artifact');
  const dest = values.get('--dest');
  if (artifact === undefined || dest === undefined) usage('--artifact and --dest are required');
  process.stdout.write(
    `${materializeArtifact(artifact, dest, values.get('--root-name') ?? null)}\n`
  );
  return 0;
}

export function runMaterializeCli(argv: string[]): number {
  try {
    return cli(argv);
  } catch (error) {
    process.stderr.write(`${errorDetail(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = runMaterializeCli(process.argv.slice(2));
