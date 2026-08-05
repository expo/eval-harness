import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Write readable JSON whose compatibility contract is the parsed JSON value.
 *
 * Python and JavaScript can spell the same JSON number differently (for
 * example, `1.0` and `1`). Callers and differential tests therefore compare
 * decoded objects, not file bytes or object-key order.
 */
export function writeJson(data: JsonObject, path: string): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
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
  mkdirSync(destDir, { recursive: true });
  if (statSync(artifactPath).isDirectory()) {
    const archive = firstArchive(artifactPath);
    if (archive !== null) {
      extractTar(archive, destDir);
      return destDir;
    }
    return artifactPath;
  }
  extractTar(artifactPath, destDir);
  return destDir;
}

export function firstArchive(path: string): string | null {
  const entries = readdirSync(path).sort();
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
  try {
    const entries: TarEntryMetadata[] = [];
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
    const archiveSymlinkPaths = validateTarEntries(entries, destRoot);
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
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to extract unsafe tar archive ${basename(path)}: ${detail}`);
  }
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
    throw new Error(`unsafe tar metadata for ${entryPath}`);
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
    throw new Error(`unsafe tar member: ${entryPath}`);
  }
  if (tarEntry.type === undefined || !SAFE_TAR_ENTRY_TYPES.has(tarEntry.type)) {
    throw new Error(`unsafe tar member type for ${entryPath}`);
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
  let current = dirname(path);
  while (current !== root) {
    if (archiveSymlinkPaths.has(current)) {
      throw new Error(`unsafe tar member through archive symlink: ${entryPath}`);
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`unsafe tar member: ${entryPath}`);
    current = parent;
  }
}

function assertNoSymlinkParent(path: string, root: string, label: string): void {
  let current = dirname(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`unsafe ${label}: symbolic-link parent ${current}`);
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) throw new Error(`unsafe ${label}`);
    current = parent;
  }
}

function assertPathWithin(path: string, root: string, label: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))) {
    return;
  }
  throw new Error(`unsafe ${label}`);
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
  return roundPythonFloat(numerator / denominator, digits);
}

function roundPythonFloat(value: number, digits: number): number {
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
