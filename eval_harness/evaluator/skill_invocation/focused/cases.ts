import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { parseExpectations, type Expectations } from "../expectations.ts";

export type Case = {
  id: string;
  family: string;
  split: "development" | "validation" | "holdout";
  fixture: string;
  prompt: string;
  expect: Expectations;
  before_edit: boolean;
  unchanged: string[];
  review: string[];
  read_only?: boolean;
  checks?: Array<"http-response-contract">;
};

export function inside(root: string, name: string): string {
  const target = resolve(root, name);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Path must be inside ${root}: ${name}`);
  return target;
}

export function loadCases(
  file: string,
  fixtures: string,
  skills: string,
): Case[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) throw new Error("Cases must be an array");
  const known = new Set(readdirSync(skills));
  const cases = raw.map((item: unknown): Case => {
    if (item === null || typeof item !== "object")
      throw new Error("Invalid case");
    const row = item as Record<string, unknown>;
    const keys = [
      "id",
      "family",
      "split",
      "fixture",
      "prompt",
      "expect",
      "before_edit",
      "unchanged",
      "review",
      "read_only",
      "checks",
    ];
    for (const key of Object.keys(row))
      if (!keys.includes(key)) throw new Error(`Unknown case field: ${key}`);
    for (const key of ["id", "family", "fixture"]) {
      if (
        typeof row[key] !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row[key])
      )
        throw new Error(`Invalid ${key}`);
    }
    if (typeof row.prompt !== "string" || !row.prompt.trim())
      throw new Error("Missing prompt");
    if (!["development", "validation", "holdout"].includes(String(row.split)))
      throw new Error("Invalid split");
    if (typeof row.before_edit !== "boolean")
      throw new Error("before_edit must be boolean");
    if (row.read_only !== undefined && typeof row.read_only !== "boolean")
      throw new Error("read_only must be boolean");
    if (
      row.checks !== undefined &&
      (!Array.isArray(row.checks) ||
        row.checks.some((id) => id !== "http-response-contract") ||
        new Set(row.checks).size !== row.checks.length)
    )
      throw new Error("Unknown or duplicate outcome check");
    const expect = parseExpectations(row.expect);
    for (const name of [
      ...expect.required,
      ...expect.optional,
      ...expect.forbidden,
    ]) {
      if (!known.has(name))
        throw new Error(`Unknown skill ${name} in ${row.id}`);
    }
    const fixture = inside(fixtures, String(row.fixture));
    if (!statSync(fixture).isDirectory())
      throw new Error(`Missing fixture: ${fixture}`);
    for (const key of ["unchanged", "review"] as const) {
      if (
        !Array.isArray(row[key]) ||
        row[key].some((v) => typeof v !== "string" || !v.trim())
      )
        throw new Error(`Invalid ${key}`);
    }
    for (const name of row.unchanged as string[])
      readFileSync(inside(fixture, name));
    return { ...row, expect } as Case;
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error("Duplicate case id");
  const families = new Map<string, string>();
  for (const item of cases) {
    if (families.has(item.family) && families.get(item.family) !== item.split)
      throw new Error(`Family ${item.family} leaks across splits`);
    families.set(item.family, item.split);
  }
  return cases;
}
