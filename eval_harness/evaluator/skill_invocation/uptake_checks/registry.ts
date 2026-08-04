import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { readJson } from "../utils.ts";

export const SOURCE_SUFFIXES = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);
export const SKIP_DIR_PARTS = new Set([
  "node_modules",
  ".git",
  ".expo",
  "ios",
  "android",
  "build",
  "dist",
  "scripts",
]);
export const SKIP_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);

export const STATUS_PASSED = "passed";
export const STATUS_FAILED = "failed";
export const STATUS_NOT_APPLICABLE = "not_applicable";
export const STATUS_UNAVAILABLE = "unavailable";
export type CheckStatus =
  | typeof STATUS_PASSED
  | typeof STATUS_FAILED
  | typeof STATUS_NOT_APPLICABLE
  | typeof STATUS_UNAVAILABLE;
const SCORED_STATUSES = new Set<CheckStatus>([STATUS_PASSED, STATUS_FAILED]);

export type CheckDefinition = {
  id: string;
  category: string;
  kind: string;
  target?: unknown;
  description?: string;
};

export type CheckRunner = (appTree: AppTree) => CheckResult;

export type Check = CheckDefinition & {
  target: unknown;
  description: string;
  run: CheckRunner | null;
};

export class CheckResult {
  readonly id: string;
  readonly category: string;
  readonly kind: string;
  readonly target: unknown;
  readonly passed: boolean | null;
  readonly evidence: string;
  readonly status: CheckStatus;

  constructor(fields: {
    id: string;
    category: string;
    kind: string;
    target: unknown;
    passed: boolean | null;
    evidence: string;
    status: CheckStatus;
  }) {
    this.id = fields.id;
    this.category = fields.category;
    this.kind = fields.kind;
    this.target = fields.target;
    this.passed = fields.passed;
    this.evidence = fields.evidence;
    this.status = fields.status;
  }
}

export class UptakeResults {
  readonly checks: CheckResult[];

  constructor(checks: CheckResult[] = []) {
    this.checks = checks;
  }

  get scored(): CheckResult[] {
    return this.checks.filter((check) => SCORED_STATUSES.has(check.status));
  }

  get passed(): number {
    return this.scored.filter((check) => check.passed === true).length;
  }

  get total(): number {
    return this.scored.length;
  }

  get uptakeRate(): number | null {
    const scored = this.scored;
    if (scored.length === 0) return null;
    return roundFour(
      scored.filter((check) => check.passed === true).length / scored.length,
    );
  }

  categoryBreakdown(): Record<string, { passed: number; total: number }> {
    const result: Record<string, { passed: number; total: number }> = {};
    for (const check of this.scored) {
      const bucket = result[check.category] ?? { passed: 0, total: 0 };
      bucket.total += 1;
      if (check.passed === true) bucket.passed += 1;
      result[check.category] = bucket;
    }
    return result;
  }
}

export class AppTree {
  readonly root: string;
  #files: Map<string, string> | null = null;

  constructor(appDir: string) {
    this.root = appDir;
  }

  get files(): Map<string, string> {
    this.#files ??= this.#readSourceFiles();
    return this.#files;
  }

  globAny(patterns: string[]): string[] {
    const matches: string[] = [];
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      const patternMatches = [...glob.scanSync({
        cwd: this.root,
        dot: true,
        onlyFiles: false,
      })].sort();
      for (const path of patternMatches) {
        if (hasSkippedPart(path)) continue;
        matches.push(join(this.root, path));
      }
    }
    return matches;
  }

  #readSourceFiles(): Map<string, string> {
    const files = new Map<string, string>();
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name),
      )) {
        const absolute = join(directory, entry.name);
        const path = relative(this.root, absolute);
        if (entry.isDirectory()) {
          if (!SKIP_DIR_PARTS.has(entry.name)) visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!SOURCE_SUFFIXES.has(extname(entry.name))) continue;
        if (SKIP_FILENAMES.has(entry.name) || hasSkippedPart(path)) continue;
        try {
          files.set(path, readFileSync(absolute, "utf8"));
        } catch (error) {
          if (error instanceof TypeError) continue;
          throw error;
        }
      }
    };
    visit(this.root);
    return files;
  }
}

function hasSkippedPart(path: string): boolean {
  return path.split(/[\\/]/u).some((part) => SKIP_DIR_PARTS.has(part));
}

const CODE_REGISTRY = new Map<string, Check>();

export function register(
  checkId: string,
  category: string,
  description = "",
): (runner: CheckRunner) => CheckRunner {
  return (runner) => {
    CODE_REGISTRY.set(checkId, {
      id: checkId,
      category,
      kind: "code",
      target: null,
      description,
      run: runner,
    });
    return runner;
  };
}

export function loadChecksData(checksDir: string): Map<string, Check> {
  const path = join(checksDir, "checks_data.json");
  if (!existsSync(path)) return new Map();
  const data = readJson<{ checks?: CheckDefinition[] }>(path);
  const result = new Map<string, Check>();
  for (const entry of data.checks ?? []) {
    const check: Check = {
      id: String(entry.id),
      category: String(entry.category),
      kind: String(entry.kind),
      target: entry.target,
      description: String(entry.description ?? ""),
      run: null,
    };
    result.set(check.id, check);
  }
  return result;
}

export function loadSkillMap(checksDir: string): Record<string, string[]> {
  const path = join(checksDir, "skill_map.json");
  if (!existsSync(path)) return {};
  const raw = readJson<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, value]) => [
        String(key),
        Array.isArray(value) ? value.map(String) : [],
      ]),
  );
}

export function allChecks(checksDir: string): Map<string, Check> {
  return new Map([...CODE_REGISTRY, ...loadChecksData(checksDir)]);
}

export function resolveChecksForSkills(
  expectedSkills: string[],
  checksDir: string,
): { checks: Check[]; warnings: string[] } {
  const skillMap = loadSkillMap(checksDir);
  const registry = allChecks(checksDir);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const checks: Check[] = [];
  for (const skillId of expectedSkills) {
    const checkIds = skillMap[skillId];
    if (checkIds === undefined) {
      warnings.push(`no uptake checks mapped for skill '${skillId}'`);
      continue;
    }
    for (const checkId of checkIds) {
      if (seen.has(checkId)) continue;
      const check = registry.get(checkId);
      if (check === undefined) {
        warnings.push(`skill_map references unknown check id '${checkId}'`);
        continue;
      }
      seen.add(checkId);
      checks.push(check);
    }
  }
  return { checks, warnings };
}

export function resolveChecksBySkill(
  expectedSkills: string[],
  checksDir: string,
): { checksBySkill: Record<string, Check[] | null>; warnings: string[] } {
  const skillMap = loadSkillMap(checksDir);
  const registry = allChecks(checksDir);
  const warnings: string[] = [];
  const checksBySkill: Record<string, Check[] | null> = {};
  for (const skillId of expectedSkills) {
    const checkIds = skillMap[skillId];
    if (checkIds === undefined) {
      warnings.push(`no uptake checks mapped for skill '${skillId}'`);
      checksBySkill[skillId] = null;
      continue;
    }
    const checks: Check[] = [];
    for (const checkId of checkIds) {
      const check = registry.get(checkId);
      if (check === undefined) {
        warnings.push(`skill_map references unknown check id '${checkId}'`);
        continue;
      }
      checks.push(check);
    }
    checksBySkill[skillId] = checks;
  }
  return { checksBySkill, warnings };
}

export function runChecks(checks: Check[], appDir: string): CheckResult[] {
  const appTree = new AppTree(appDir);
  return checks.map((check) => runCheck(check, appTree));
}

export function runCheck(check: Check, appTree: AppTree): CheckResult {
  if (check.run !== null) return check.run(appTree);
  switch (check.kind) {
    case "import":
      return checkImport(check, appTree);
    case "text":
      return checkText(check, appTree);
    case "text_any":
      return checkTextAny(check, appTree);
    case "text_absent":
      return checkTextAbsent(check, appTree);
    case "path_exists":
      return checkPathExists(check, appTree);
    case "path_absent":
      return checkPathAbsent(check, appTree);
    case "package_dependency":
      return checkPackageDependency(check, appTree);
    case "tsconfig_path_alias":
      return checkTsconfigPathAlias(check, appTree);
    default:
      throw new Error(`Unknown check kind '${check.kind}' for check '${check.id}'`);
  }
}

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
}

function result(check: Check, passed: boolean, evidence: string): CheckResult {
  return new CheckResult({
    id: check.id,
    category: check.category,
    kind: check.kind,
    target: check.target,
    passed,
    evidence,
    status: passed ? STATUS_PASSED : STATUS_FAILED,
  });
}

function checkImport(check: Check, appTree: AppTree): CheckResult {
  const target = String(check.target);
  const needles = [
    `from '${target}'`,
    `from "${target}"`,
    `require('${target}')`,
    `require("${target}")`,
  ];
  for (const [path, text] of appTree.files) {
    if (needles.some((needle) => stripComments(text).includes(needle))) {
      return result(check, true, `${path}: imports ${target}`);
    }
  }
  return result(check, false, `No source file imports ${target}`);
}

function checkText(check: Check, appTree: AppTree): CheckResult {
  const pattern = new RegExp(String(check.target));
  for (const [path, text] of appTree.files) {
    if (pattern.test(stripComments(text))) {
      return result(check, true, `${path}: matches ${pyRepr(check.target)}`);
    }
  }
  return result(check, false, `No source file matches ${pyRepr(check.target)}`);
}

function checkTextAny(check: Check, appTree: AppTree): CheckResult {
  const options = Array.isArray(check.target) ? check.target : [check.target];
  for (const option of options) {
    const pattern = new RegExp(String(option));
    for (const [path, text] of appTree.files) {
      if (pattern.test(stripComments(text))) {
        return result(check, true, `${path}: matches ${pyRepr(option)}`);
      }
    }
  }
  return result(
    check,
    false,
    `No source file matches any of ${pyRepr(options)}`,
  );
}

function checkTextAbsent(check: Check, appTree: AppTree): CheckResult {
  const pattern = new RegExp(String(check.target));
  for (const [path, text] of appTree.files) {
    if (pattern.test(stripComments(text))) {
      return result(
        check,
        false,
        `${path}: contains forbidden ${pyRepr(check.target)}`,
      );
    }
  }
  return result(
    check,
    true,
    `No source file contains forbidden ${pyRepr(check.target)}`,
  );
}

function checkPathExists(check: Check, appTree: AppTree): CheckResult {
  const patterns = (Array.isArray(check.target) ? check.target : [check.target]).map(String);
  const matches = appTree.globAny(patterns);
  if (matches.length > 0) {
    return result(check, true, `found ${relative(appTree.root, matches[0] ?? appTree.root)}`);
  }
  return result(check, false, `no path matched any of ${pyRepr(patterns)}`);
}

function checkPathAbsent(check: Check, appTree: AppTree): CheckResult {
  const patterns = (Array.isArray(check.target) ? check.target : [check.target]).map(String);
  const matches = appTree.globAny(patterns);
  if (matches.length > 0) {
    return result(
      check,
      false,
      `forbidden path exists: ${relative(appTree.root, matches[0] ?? appTree.root)}`,
    );
  }
  return result(check, true, `no path matched any of ${pyRepr(patterns)}`);
}

function checkPackageDependency(check: Check, appTree: AppTree): CheckResult {
  const target = String(check.target);
  const packagePath = join(appTree.root, "package.json");
  if (!existsSync(packagePath)) return result(check, false, "package.json is missing");
  const data = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(packagePath);
  const dependencies = {
    ...(data.dependencies ?? {}),
    ...(data.devDependencies ?? {}),
  };
  const passed = Object.hasOwn(dependencies, target);
  return result(
    check,
    passed,
    `package.json ${passed ? "contains" : "does not contain"} ${target}`,
  );
}

function checkTsconfigPathAlias(check: Check, appTree: AppTree): CheckResult {
  const target = String(check.target);
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const path = join(appTree.root, name);
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(stripComments(readFileSync(path, "utf8"))) as {
        compilerOptions?: { paths?: Record<string, unknown> };
      };
      if (Object.hasOwn(data.compilerOptions?.paths ?? {}, target)) {
        return result(
          check,
          true,
          `${name}: compilerOptions.paths has ${pyRepr(target)}`,
        );
      }
    } catch {
      continue;
    }
  }
  return result(
    check,
    false,
    `no tsconfig.json/jsconfig.json compilerOptions.paths entry for ${pyRepr(target)}`,
  );
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function roundFour(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
