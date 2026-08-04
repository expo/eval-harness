import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { x as extractArchive } from "tar";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(data: JsonObject, path: string): void {
  writeFileSync(path, `${JSON.stringify(sortJson(data), null, 2)}\n`, "utf8");
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
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
  try {
    extractArchive({
      file: path,
      cwd: destRoot,
      sync: true,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => {
        const target = resolve(destRoot, entryPath);
        assertPathWithin(target, destRoot, `tar member ${entryPath}`);
        if (isAbsolute(entryPath) || entryPath.split(/[\\/]/u).includes("..")) {
          throw new Error(`unsafe tar member: ${entryPath}`);
        }
        if (
          !("type" in entry) ||
          !("linkpath" in entry) ||
          typeof entry.linkpath !== "string"
        ) return true;
        if (entry.type === "SymbolicLink") {
          const linkTarget = resolve(dirname(target), entry.linkpath);
          assertPathWithin(
            linkTarget,
            destRoot,
            `tar link ${entryPath} -> ${entry.linkpath}`,
          );
        } else if (entry.type === "Link") {
          const linkTarget = resolve(destRoot, entry.linkpath);
          assertPathWithin(
            linkTarget,
            destRoot,
            `tar link ${entryPath} -> ${entry.linkpath}`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to extract unsafe tar archive ${basename(path)}: ${detail}`);
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
