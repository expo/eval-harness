import { readFileSync, writeFileSync } from 'node:fs';
import { sep } from 'node:path';

export { extractTar, firstArchive, unpackArtifact } from './artifacts.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
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
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export async function readJsonAsync<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(path).text()) as T;
}

/** Read a producer manifest's optional run identity without making it analysis-critical. */
export async function readArtifactRunId(manifestPath: string | null): Promise<string | null> {
  if (manifestPath === null || !(await Bun.file(manifestPath).exists())) {
    return null;
  }
  try {
    const manifest = await readJsonAsync<Record<string, unknown>>(manifestPath);
    return typeof manifest.run_id === 'string' && manifest.run_id.length > 0
      ? manifest.run_id
      : null;
  } catch {
    return null;
  }
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
  writeFileSync(path, JSON.stringify(data, sortedJsonKeys(data), 2), 'utf8');
}

export async function writeJsonAsync(data: JsonObject, path: string): Promise<void> {
  await Bun.write(path, JSON.stringify(data, sortedJsonKeys(data), 2));
}

function sortedJsonKeys(data: JsonValue): string[] {
  const keys = new Set<string>();
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
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
  return normalizePrdSkills(raw);
}

export async function loadPrdSkillsAsync(path: string): Promise<Record<string, string[]>> {
  const raw = await readJsonAsync<Record<string, unknown>>(path);
  return normalizePrdSkills(raw);
}

function normalizePrdSkills(raw: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      String(key),
      Array.isArray(value) ? value.map(String) : [],
    ])
  );
}

export function appNameFromPrd(prdPath: string): string | null {
  const parts = prdPath.split(sep);
  const index = parts.indexOf('prds');
  return index >= 0 && index + 1 < parts.length ? (parts[index + 1] ?? null) : null;
}

export function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value !== null && typeof value === 'object') {
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

export function roundRatio(numerator: number, denominator: number, digits = 4): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError('numerator must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError('denominator must be a positive safe integer');
  }
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 15) {
    throw new RangeError('digits must be a safe integer between 0 and 15');
  }
  return roundFloat(numerator / denominator, digits);
}

export function roundFloat(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isSafeInteger(digits) || digits < 0 || digits > 15) {
    throw new RangeError('digits must be a safe integer between 0 and 15');
  }
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const negative = bits >> 63n === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (exponentBits === 0 && fraction === 0n) return value;
  const significand = exponentBits === 0 ? fraction : fraction + (1n << 52n);
  const binaryExponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
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
