import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { t as listArchive, x as extractArchive } from "tar";

const SAFE_TAR_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "ContiguousFile",
  "Directory",
  "Link",
  "SymbolicLink",
]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Compare strings by Unicode code point, matching Python's string ordering. */
export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Write readable JSON with Python-compatible deterministic key ordering.
 *
 * Python and JavaScript can spell the same JSON number differently (for
 * example, `1.0` and `1`). Callers and differential tests therefore compare
 * decoded objects rather than file bytes, while retaining sorted keys for
 * stable diffs and reports.
 */
export function writeJson(data: JsonObject, path: string): void {
  writeFileSync(path, JSON.stringify(data, sortedJsonKeys(data), 2), "utf8");
}

function sortedJsonKeys(data: JsonValue): string[] {
  const keys = new Set<string>();
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      visit(item);
    }
  };
  visit(data);
  return [...keys].sort(compareUnicodeCodePoints);
}

export function loadPrdSkills(path: string): Record<string, string[]> {
  const raw = readJson<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      String(key),
      Array.isArray(value) ? value.map(String) : [],
    ]),
  );
}

export function appNameFromPrd(prdPath: string): string | null {
  const parts = prdPath.split(sep);
  const index = parts.indexOf("prds");
  return index >= 0 && index + 1 < parts.length ? parts[index + 1] ?? null : null;
}

export function unpackArtifact(artifactPath: string, destDir: string): string {
  if (statSync(artifactPath).isDirectory()) {
    const archive = firstArchive(artifactPath);
    if (archive !== null) {
      replaceWithExtractedArchive(archive, destDir);
      return destDir;
    }
    return artifactPath;
  }
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
    rmSync(destRoot, { recursive: true, force: true });
    renameSync(stagingDir, destRoot);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export function firstArchive(path: string): string | null {
  const entries = readdirSync(path).sort(compareUnicodeCodePoints);
  for (const suffix of [".tar.gz", ".tgz", ".tar"]) {
    const match = entries.find((entry) => entry.endsWith(suffix));
    if (match !== undefined) return join(path, match);
  }
  return null;
}

export function extractTar(path: string, destDir: string): void {
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
      onReadEntry: (entry) => {
        entries.push({
          path: entry.path,
          type: entry.type,
          ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
        });
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to read tar archive ${basename(path)}: ${errorDetail(error)}`,
    );
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
    throw new Error(
      `Failed to extract tar archive ${basename(path)}: ${errorDetail(error)}`,
    );
  }
}

class UnsafeTarEntryError extends Error {}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unsafeTarError(path: string, error: unknown): Error {
  return new Error(
    `Refusing to extract unsafe tar archive ${basename(path)}: ${errorDetail(error)}`,
  );
}

type TarEntryMetadata = {
  path: string;
  type?: string;
  linkpath?: string;
};

function validateTarEntries(
  entries: TarEntryMetadata[],
  destRoot: string,
): Set<string> {
  const archiveSymlinkPaths = new Set(
    entries
      .filter((entry) => entry.type === "SymbolicLink")
      .map((entry) => resolve(destRoot, entry.path)),
  );
  for (const entry of entries) {
    validateTarEntry(entry.path, entry, destRoot, archiveSymlinkPaths);
  }
  return archiveSymlinkPaths;
}

function validateTarEntry(
  entryPath: string,
  entry: unknown,
  destRoot: string,
  archiveSymlinkPaths: ReadonlySet<string>,
): boolean {
  if (entry === null || typeof entry !== "object") {
    throw new UnsafeTarEntryError(`unsafe tar metadata for ${entryPath}`);
  }
  const tarEntry = entry as { type?: string; linkpath?: string };
  const target = resolve(destRoot, entryPath);
  assertPathWithin(target, destRoot, `tar member ${entryPath}`);
  assertNoSymlinkParent(target, destRoot, `tar member ${entryPath}`);
  assertNoArchiveSymlinkParent(
    target,
    destRoot,
    entryPath,
    archiveSymlinkPaths,
  );
  if (isAbsolute(entryPath) || entryPath.split(/[\\/]/u).includes("..")) {
    throw new UnsafeTarEntryError(`unsafe tar member: ${entryPath}`);
  }
  if (tarEntry.type === undefined || !SAFE_TAR_ENTRY_TYPES.has(tarEntry.type)) {
    throw new UnsafeTarEntryError(`unsafe tar member type for ${entryPath}`);
  }
  if (target === destRoot && tarEntry.type !== "Directory") {
    throw new Error(`unsafe non-directory tar root member: ${entryPath}`);
  }
  if (typeof tarEntry.linkpath !== "string") return true;
  if (tarEntry.type === "SymbolicLink") {
    const linkTarget = resolve(dirname(target), tarEntry.linkpath);
    assertPathWithin(
      linkTarget,
      destRoot,
      `tar link ${entryPath} -> ${tarEntry.linkpath}`,
    );
  } else if (tarEntry.type === "Link") {
    const linkTarget = resolve(destRoot, tarEntry.linkpath);
    assertPathWithin(
      linkTarget,
      destRoot,
      `tar link ${entryPath} -> ${tarEntry.linkpath}`,
    );
  }
  return true;
}

function assertNoArchiveSymlinkParent(
  path: string,
  root: string,
  entryPath: string,
  archiveSymlinkPaths: ReadonlySet<string>,
): void {
  if (path === root) return;
  let current = dirname(path);
  while (current !== root) {
    if (archiveSymlinkPaths.has(current)) {
      throw new UnsafeTarEntryError(
        `unsafe tar member through archive symlink: ${entryPath}`,
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new UnsafeTarEntryError(`unsafe tar member: ${entryPath}`);
    }
    current = parent;
  }
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
      throw new UnsafeTarEntryError(
        `unsafe ${label}: symbolic-link parent ${current}`,
      );
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) throw new UnsafeTarEntryError(`unsafe ${label}`);
    current = parent;
  }
}

function assertPathWithin(path: string, root: string, label: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) {
    return;
  }
  throw new UnsafeTarEntryError(`unsafe ${label}`);
}

export function flattenStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [
      ...flattenStrings(key),
      ...flattenStrings(item),
    ]);
  }
  return [];
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function roundRatio(
  numerator: number,
  denominator: number,
  digits = 4,
): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError("numerator must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("denominator must be a positive safe integer");
  }
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 15) {
    throw new RangeError("digits must be a safe integer between 0 and 15");
  }
  return roundFloat(numerator / denominator, digits);
}

export function roundFloat(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 15) {
    throw new RangeError("digits must be a safe integer between 0 and 15");
  }
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const negative = (bits >> 63n) === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (exponentBits === 0 && fraction === 0n) return value;
  const significand =
    exponentBits === 0 ? fraction : fraction + (1n << 52n);
  const binaryExponent =
    exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  const scale = 10n ** BigInt(digits);
  let scaledNumerator = significand * scale;
  let scaledDenominator = 1n;
  if (binaryExponent >= 0) {
    scaledNumerator <<= BigInt(binaryExponent);
  } else {
    scaledDenominator <<= BigInt(-binaryExponent);
  }
  const quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  const roundsUp =
    remainder * 2n > scaledDenominator ||
    (remainder * 2n === scaledDenominator && quotient % 2n !== 0n);
  const rounded = quotient + (roundsUp ? 1n : 0n);
  const result = Number(rounded) / Number(scale);
  return negative ? -result : result;
}
