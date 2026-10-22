import { stripComments } from "@expo/source-scan/strip-comments";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { compareUnicodeCodePoints, readJson, roundRatio } from "../utils.ts";
import { registerCodeChecks } from "./code_checks.ts";

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
export const SCORED_STATUSES: ReadonlySet<CheckStatus> = new Set([
  STATUS_PASSED,
  STATUS_FAILED,
]);
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type CheckDefinition = {
  id: string;
  category: string;
  kind: string;
  target?: unknown;
  description?: string;
};

export type CheckRunner = (
  appTree: AppTree,
) => CheckResult | Promise<CheckResult>;

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
    return roundRatio(
      scored.filter((check) => check.passed === true).length,
      scored.length,
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
  readonly #files: Map<string, string>;

  private constructor(appDir: string, files: Map<string, string>) {
    this.root = appDir;
    this.#files = files;
  }

  static async load(appDir: string): Promise<AppTree> {
    const files = await readSourceFiles(appDir);
    return new AppTree(appDir, files);
  }

  get files(): Map<string, string> {
    return this.#files;
  }

  async globAny(patterns: string[]): Promise<string[]> {
    const matches: string[] = [];
    const seen = new Set<string>();
    for (const pattern of patterns) {
      const scanPatterns = pattern.endsWith("/**")
        ? [pattern.slice(0, -3), pattern]
        : [pattern];
      for (const scanPattern of scanPatterns) {
        const glob = new Bun.Glob(scanPattern);
        const patternMatches: string[] = [];
        for await (const relativePath of glob.scan({
          cwd: this.root,
          dot: true,
          onlyFiles: false,
        })) {
          patternMatches.push(relativePath);
        }
        patternMatches.sort(compareUnicodeCodePoints);
        for (const relativePath of patternMatches) {
          if (hasSkippedPart(relativePath) || seen.has(relativePath)) continue;
          seen.add(relativePath);
          matches.push(path.join(this.root, relativePath));
        }
      }
    }
    return matches;
  }
}

async function readSourceFiles(root: string): Promise<Map<string, string>> {
  const discover = async (
    directory: string,
  ): Promise<Array<[relativePath: string, absolutePath: string]>> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareUnicodeCodePoints(left.name, right.name),
    );
    const discovered = await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = path.relative(root, absolutePath);
        if (entry.isDirectory()) {
          return SKIP_DIR_PARTS.has(entry.name)
            ? []
            : await discover(absolutePath);
        }
        if (!entry.isFile()) return [];
        if (!SOURCE_SUFFIXES.has(path.extname(entry.name))) return [];
        if (SKIP_FILENAMES.has(entry.name) || hasSkippedPart(relativePath)) {
          return [];
        }
        return [[relativePath, absolutePath] as [string, string]];
      }),
    );
    return discovered.flat();
  };

  const sourcePaths = await discover(root);
  const contents = await Promise.all(
    sourcePaths.map(async ([relativePath, absolutePath]) => {
      try {
        return [
          relativePath,
          FATAL_UTF8_DECODER.decode(await readFile(absolutePath)),
        ] as const;
      } catch (error) {
        if (error instanceof TypeError) return null;
        throw error;
      }
    }),
  );
  return new Map(contents.filter((entry) => entry !== null));
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
  const checksPath = path.join(checksDir, "checks_data.json");
  if (!existsSync(checksPath)) return new Map();
  const data = readJson<{ checks?: CheckDefinition[] }>(checksPath);
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
  const skillMapPath = path.join(checksDir, "skill_map.json");
  if (!existsSync(skillMapPath)) return {};
  const raw = readJson<Record<string, unknown>>(skillMapPath);
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

export async function runChecks(
  checks: Check[],
  appDir: string,
): Promise<CheckResult[]> {
  const appTree = await AppTree.load(appDir);
  return Promise.all(checks.map((check) => runCheck(check, appTree)));
}

export async function runCheck(
  check: Check,
  appTree: AppTree,
): Promise<CheckResult> {
  if (check.run !== null) return await check.run(appTree);
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

export { stripComments };

function isLineTerminator(character: string): boolean {
  return (
    character === "\n" ||
    character === "\r" ||
    character === "\u2028" ||
    character === "\u2029"
  );
}

function stripJsonComments(text: string): string {
  let output = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const character = text.charAt(index);
    if (inString) {
      output += character;
      if (character === "\\" && index + 1 < text.length) {
        output += text.charAt(index + 1);
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }

    if (character === "\u2028" || character === "\u2029") {
      output += "\n";
      index += 1;
      continue;
    }

    if (character === "/" && text.charAt(index + 1) === "/") {
      index += 2;
      while (
        index < text.length &&
        !isLineTerminator(text.charAt(index))
      ) {
        index += 1;
      }
      continue;
    }

    if (character === "/" && text.charAt(index + 1) === "*") {
      index += 2;
      while (
        index + 1 < text.length &&
        !(text.charAt(index) === "*" && text.charAt(index + 1) === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
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

async function checkPathExists(
  check: Check,
  appTree: AppTree,
): Promise<CheckResult> {
  const patterns = (Array.isArray(check.target) ? check.target : [check.target]).map(String);
  const matches = await appTree.globAny(patterns);
  if (matches.length > 0) {
    return result(
      check,
      true,
      `found ${path.relative(appTree.root, matches[0] ?? appTree.root)}`,
    );
  }
  return result(check, false, `no path matched any of ${pyRepr(patterns)}`);
}

async function checkPathAbsent(
  check: Check,
  appTree: AppTree,
): Promise<CheckResult> {
  const patterns = (Array.isArray(check.target) ? check.target : [check.target]).map(String);
  const matches = await appTree.globAny(patterns);
  if (matches.length > 0) {
    return result(
      check,
      false,
      `forbidden path exists: ${path.relative(appTree.root, matches[0] ?? appTree.root)}`,
    );
  }
  return result(check, true, `no path matched any of ${pyRepr(patterns)}`);
}

function checkPackageDependency(check: Check, appTree: AppTree): CheckResult {
  const target = String(check.target);
  const packagePath = path.join(appTree.root, "package.json");
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
    const configPath = path.join(appTree.root, name);
    if (!existsSync(configPath)) continue;
    try {
      const data = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8"))) as {
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

registerCodeChecks({
  register,
  createResult: (fields) => new CheckResult(fields),
  stripComments,
});
