#!/usr/bin/env bun

/**
 * Reconstruct Claude Code JSONL transcripts into the harness's normalized
 * turns -> steps -> tool_calls trace shape. Human messages delimit turns;
 * tool-result blocks attach to tool-use blocks only through their matching ID.
 */

import { readdir, readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type JsonRecord = Record<string, unknown>;
export type ToolCall = JsonRecord & {
  call_id: unknown;
  name: unknown;
  args: unknown;
};
export type TraceStep = JsonRecord & {
  text: string;
  reasoning: string;
  tool_calls: ToolCall[];
};
export type TraceTurn = JsonRecord & {
  turn_id: unknown;
  turn_index: number;
  user_input: unknown;
  steps: TraceStep[];
};

type ClaudeReconstructionOptions = {
  projectsDir: string;
  outPath: string;
  sinceMtime?: number;
  beforeMtime?: number;
  braintrust?: boolean;
  runId?: string | null;
  source?: string;
  sessionName?: string | null;
};

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a JSON object record");
  }
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function pythonTruthy(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === 0n ||
    value === ""
  ) {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function recordOrPythonFallback(value: unknown, field: string): JsonRecord {
  if (!pythonTruthy(value)) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  throw new TypeError(`${field} must be an object when present`);
}

function blocks(content: unknown): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function isRealUser(message: JsonRecord): boolean {
  return !blocks(message.content).some((block) => {
    const record = optionalRecord(block);
    return record.type === "tool_result";
  });
}

function userText(message: JsonRecord): string {
  const parts: string[] = [];
  for (const block of blocks(message.content)) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const record = optionalRecord(block);
    if (record.type === "text") {
      parts.push(typeof record.text === "string" ? record.text : "");
    }
  }
  return parts.join("");
}

function addTokenValues(left: unknown, right: unknown): unknown {
  if (typeof left === "number" && typeof right === "number") {
    return left + right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left + right;
  }
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left + right;
  }
  if (typeof left === "bigint" && typeof right === "number") {
    return Number(left) + right;
  }
  if (typeof left === "number" && typeof right === "bigint") {
    return left + Number(right);
  }
  throw new TypeError("token values cannot be added");
}

function usage(value: unknown): JsonRecord {
  const source = optionalRecord(value);
  const result: JsonRecord = {};
  const inputTokens = source.input_tokens;
  const outputTokens = source.output_tokens;
  if (inputTokens !== null && inputTokens !== undefined) {
    result.prompt_tokens = inputTokens;
  }
  if (outputTokens !== null && outputTokens !== undefined) {
    result.completion_tokens = outputTokens;
  }
  if (
    inputTokens !== null &&
    inputTokens !== undefined &&
    outputTokens !== null &&
    outputTokens !== undefined
  ) {
    result.tokens = addTokenValues(inputTokens, outputTokens);
  }
  if (source.cache_read_input_tokens !== null && source.cache_read_input_tokens !== undefined) {
    result.cache_read_input_tokens = source.cache_read_input_tokens;
  }
  if (
    source.cache_creation_input_tokens !== null &&
    source.cache_creation_input_tokens !== undefined
  ) {
    result.cache_creation_input_tokens = source.cache_creation_input_tokens;
  }
  return result;
}

function pythonString(value: string): string {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (character === '"') result += '\\"';
    else if (character === "\\") result += "\\\\";
    else if (character === "\b") result += "\\b";
    else if (character === "\f") result += "\\f";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (codePoint >= 0x20 && codePoint <= 0x7e) result += character;
    else if (codePoint <= 0xffff) result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else {
      const adjusted = codePoint - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      result += `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  }
  return `${result}"`;
}

const NUMBER_SOURCES = new WeakMap<object, Map<string, string>>();

function parseJsonWithNumberSources(text: string): unknown {
  const parse = JSON.parse as unknown as (
    source: string,
    reviver: (
      this: unknown,
      key: string,
      value: unknown,
      context: { source?: string },
    ) => unknown,
  ) => unknown;
  return parse(text, function rememberNumberSource(key, value, context) {
    if (
      typeof value === "number" &&
      typeof this === "object" &&
      this !== null &&
      context.source !== undefined
    ) {
      if (/^-?[0-9]+$/.test(context.source) && !Number.isSafeInteger(value)) {
        return BigInt(context.source);
      }
      const holder = this as object;
      const sources = NUMBER_SOURCES.get(holder) ?? new Map<string, string>();
      sources.set(key, context.source);
      NUMBER_SOURCES.set(holder, sources);
    }
    return value;
  });
}

export function parsePythonJson(text: string): unknown {
  return parseJsonWithNumberSources(text);
}

function formatPythonFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e16)) {
    const [mantissa = "0", rawExponent = "+0"] = value.toExponential().split("e");
    const exponent = Number(rawExponent);
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const decimal = String(value);
  return Number.isInteger(value) ? `${decimal}.0` : decimal;
}

function pythonJsonDumps(
  value: unknown,
  holder?: object,
  key?: string,
  indent?: number,
  level = 0,
): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return pythonString(value);
  if (typeof value === "number") {
    const source = holder === undefined || key === undefined ? undefined : NUMBER_SOURCES.get(holder)?.get(key);
    if (source !== undefined && /[.eE]/.test(source)) return formatPythonFloat(value);
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (indent === undefined) {
      return `[${value
        .map((item, index) => pythonJsonDumps(item, value, String(index)))
        .join(", ")}]`;
    }
    const itemIndent = " ".repeat((level + 1) * indent);
    const closingIndent = " ".repeat(level * indent);
    const items = value.map(
      (item, index) =>
        `${itemIndent}${pythonJsonDumps(item, value, String(index), indent, level + 1)}`,
    );
    return `[\n${items.join(",\n")}\n${closingIndent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    if (indent === undefined) {
      return `{${entries
        .map(
          ([itemKey, item]) =>
            `${pythonString(itemKey)}: ${pythonJsonDumps(item, value, itemKey)}`,
        )
        .join(", ")}}`;
    }
    const itemIndent = " ".repeat((level + 1) * indent);
    const closingIndent = " ".repeat(level * indent);
    const items = entries.map(
      ([itemKey, item]) =>
        `${itemIndent}${pythonString(itemKey)}: ${pythonJsonDumps(
          item,
          value,
          itemKey,
          indent,
          level + 1,
        )}`,
    );
    return `{\n${items.join(",\n")}\n${closingIndent}}`;
  }
  return pythonString(String(value));
}

export function stringifyPythonJson(value: unknown, indent?: number): string {
  return pythonJsonDumps(value, undefined, undefined, indent);
}

async function readJsonl(path: string): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  for (const rawLine of (await readFile(path, "utf8")).split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    try {
      records.push(asRecord(parseJsonWithNumberSources(line)));
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return records;
}

export async function parseTranscript(path: string): Promise<[TraceTurn[], JsonRecord]> {
  const records = await readJsonl(path);
  let sessionMeta: JsonRecord = {};
  const turns: TraceTurn[] = [];
  let current: TraceTurn | undefined;
  let toolsById = new Map<unknown, ToolCall>();
  let turnIndex = 0;

  const finishTurn = (): void => {
    if (current === undefined) return;
    if (!current.final_output) {
      for (const step of [...current.steps].reverse()) {
        if (step.text) {
          current.final_output = step.text;
          break;
        }
      }
    }
    turns.push(current);
    current = undefined;
    toolsById = new Map();
  };

  for (const record of records) {
    const type = record.type;
    if ((type === "user" || type === "assistant") && Object.keys(sessionMeta).length === 0) {
      sessionMeta = {
        id: record.sessionId ?? null,
        cwd: record.cwd ?? null,
        cli_version: record.version ?? null,
        git_branch: record.gitBranch ?? null,
      };
    }
    const message = recordOrPythonFallback(record.message, "message");

    if (type === "user") {
      if (isRealUser(message)) {
        finishTurn();
        turnIndex += 1;
        current = {
          turn_id: record.uuid ?? null,
          turn_index: turnIndex,
          user_input: userText(message),
          steps: [],
        };
        toolsById = new Map();
      } else if (current !== undefined) {
        for (const block of blocks(message.content)) {
          const result = optionalRecord(block);
          if (result.type !== "tool_result") continue;
          const toolCall = toolsById.get(result.tool_use_id);
          if (toolCall === undefined) continue;
          const content = result.content;
          toolCall.output =
            typeof content === "string" ? content : pythonJsonDumps(content, result, "content");
          if (result.is_error) toolCall.error = toolCall.output;
        }
      }
      continue;
    }

    if (type !== "assistant") continue;
    if (current === undefined) {
      turnIndex += 1;
      current = {
        turn_id: record.uuid ?? null,
        turn_index: turnIndex,
        user_input: null,
        steps: [],
      };
      toolsById = new Map();
    }
    const step: TraceStep = {
      text: "",
      reasoning: "",
      tool_calls: [],
      usage: usage(message.usage),
    };
    if (message.model) current.model = message.model;
    for (const block of blocks(message.content)) {
      const item = optionalRecord(block);
      if (item.type === "text") {
        step.text += typeof item.text === "string" ? item.text : "";
      } else if (item.type === "thinking") {
        step.reasoning += typeof item.thinking === "string" ? item.thinking : "";
      } else if (item.type === "tool_use") {
        const toolCall: ToolCall = {
          call_id: item.id ?? null,
          name: item.name ?? null,
          args: item.input ?? null,
        };
        step.tool_calls.push(toolCall);
        if (toolCall.call_id) toolsById.set(toolCall.call_id, toolCall);
      }
    }
    current.steps.push(step);
    const totalUsage = optionalRecord(current.total_usage);
    current.total_usage = totalUsage;
    for (const [key, value] of Object.entries(optionalRecord(step.usage))) {
      if (typeof value === "number" || typeof value === "bigint") {
        const previous = totalUsage[key];
        if (typeof value === "bigint") {
          totalUsage[key] =
            typeof previous === "number"
              ? previous + Number(value)
              : (typeof previous === "bigint" ? previous : 0n) + value;
        } else {
          totalUsage[key] =
            typeof previous === "bigint"
              ? Number(previous) + value
              : (typeof previous === "number" ? previous : 0) + value;
        }
      }
    }
  }

  finishTurn();
  return [turns, sessionMeta];
}

async function walkJsonl(
  directory: string,
  ancestorDirectories: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const paths: string[] = [];
  let resolvedDirectory: string;
  let entries: Dirent<string>[];
  try {
    resolvedDirectory = await realpath(directory);
    if (ancestorDirectories.has(resolvedDirectory)) return [];
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const nextAncestors = new Set(ancestorDirectories);
  nextAncestors.add(resolvedDirectory);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    try {
      const target = await stat(path);
      if (target.isDirectory()) paths.push(...(await walkJsonl(path, nextAncestors)));
      else if (target.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
    } catch {
      // A broken/inaccessible entry does not discard readable siblings.
    }
  }
  return paths;
}

export async function findTranscripts(
  projectsDir: string,
  sinceMtime = 0,
  beforeMtime?: number,
): Promise<string[]> {
  let candidates: string[];
  try {
    candidates = await walkJsonl(projectsDir);
  } catch {
    return [];
  }
  const selected: Array<{ path: string; mtime: number }> = [];
  for (const path of candidates) {
    try {
      const mtime = (await stat(path)).mtimeMs / 1_000;
      if (mtime >= sinceMtime && (beforeMtime === undefined || mtime < beforeMtime)) {
        selected.push({ path, mtime });
      }
    } catch {
      // A disappearing transcript is ignored just like Python's glob/stat loop.
    }
  }
  selected.sort((left, right) => left.mtime - right.mtime);
  return selected.map(({ path }) => path);
}

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const BRAINTRUST_BRIDGE = `
import json, sys
from eval_harness.utils.telemetry.tracing import bt_emit
payload = json.load(sys.stdin)
bt_emit.log_session(payload["turns"], payload["session_meta"], run_id=payload.get("run_id"), source=payload.get("source", "agent"), name=payload.get("name"))
`;

export async function emitBraintrustSession(
  turns: TraceTurn[],
  metadata: JsonRecord,
  runId: string | null,
  source: string,
  name: string | null,
  caller = "cc_transcript",
): Promise<void> {
  const searchPath = process.env.PATH;
  const searchOptions = searchPath === undefined ? undefined : { PATH: searchPath };
  const uv = Bun.which("uv", searchOptions);
  const python =
    Bun.which("python3", searchOptions) ?? Bun.which("python", searchOptions);
  const command = uv
    ? [uv, "run", "python", "-c", BRAINTRUST_BRIDGE]
    : python
      ? [python, "-c", BRAINTRUST_BRIDGE]
      : undefined;
  if (command === undefined) {
    console.log(`[${caller}] braintrust push failed: no Python interpreter found`);
    return;
  }
  try {
    const child = Bun.spawn(command, {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    child.stdin.write(
      stringifyPythonJson({ turns, session_meta: metadata, run_id: runId, source, name }),
    );
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (stdout) process.stdout.write(stdout);
    if (exitCode !== 0) {
      console.log(`[${caller}] braintrust push failed: ${stderr.trim() || `exit ${exitCode}`}`);
    }
  } catch (error) {
    console.log(`[${caller}] braintrust push failed: ${String(error)}`);
  }
}

export async function reconstructClaudeTranscripts(
  options: ClaudeReconstructionOptions,
): Promise<JsonRecord & { sessions: JsonRecord[] }> {
  const sinceMtime = options.sinceMtime ?? 0;
  const source = options.source ?? "claude-code";
  const runId = options.runId ?? null;
  const sessionName = options.sessionName ?? null;
  const transcripts = await findTranscripts(options.projectsDir, sinceMtime, options.beforeMtime);
  const sessions: JsonRecord[] = [];
  for (const transcript of transcripts) {
    try {
      const [turns, metadata] = await parseTranscript(transcript);
      if (turns.length === 0) continue;
      sessions.push({ transcript, session_meta: metadata, turns });
      if (options.braintrust) {
        await emitBraintrustSession(turns, metadata, runId, source, sessionName);
      }
    } catch (error) {
      console.log(`[cc_transcript] skip ${transcript}: ${String(error)}`);
    }
  }
  const payload = {
    agent: "claude-code",
    run_id: runId,
    source,
    session_name: sessionName,
    n_sessions: sessions.length,
    projects_dir: options.projectsDir,
    since_mtime: sinceMtime,
    before_mtime: options.beforeMtime ?? null,
    sessions,
  };
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, stringifyPythonJson(payload, 2));
  console.log(`[cc_transcript] ${sessions.length} session(s) -> ${options.outPath}`);
  return payload;
}

type ParsedArguments = {
  projectsDir: string;
  outPath?: string;
  sinceMtime: number;
  beforeMtime?: number;
  braintrust: boolean;
  runId: string | null;
  source: string;
  sessionName: string | null;
};

const DIGIT_PART = String.raw`[0-9](?:_?[0-9])*`;
const FINITE_FLOAT_PATTERN = new RegExp(
  String.raw`^[+-]?(?:(?:${DIGIT_PART}(?:\.(?:${DIGIT_PART})?)?)|(?:\.${DIGIT_PART}))(?:[eE][+-]?${DIGIT_PART})?$`,
);
const NON_FINITE_FLOAT_PATTERN = /^[+-]?(?:inf(?:inity)?|nan)$/i;

export function parsePythonFloat(text: string): number | undefined {
  const stripped = text.trim();
  if (stripped === "") return undefined;
  if (NON_FINITE_FLOAT_PATTERN.test(stripped)) {
    const unsigned = stripped.replace(/^[+-]/, "").toLowerCase();
    if (unsigned === "nan") return Number.NaN;
    return stripped.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (!FINITE_FLOAT_PATTERN.test(stripped)) return undefined;
  return Number(stripped.replaceAll("_", ""));
}

const CC_HELP = `usage: cc_transcript.py [-h] [--projects-dir PROJECTS_DIR] --out OUT
                        [--since-mtime SINCE_MTIME]
                        [--before-mtime BEFORE_MTIME] [--braintrust]
                        [--run-id RUN_ID] [--source SOURCE]
                        [--session-name SESSION_NAME]

Reconstruct Claude Code agent traces from transcripts.

options:
  -h, --help            show this help message and exit
  --projects-dir PROJECTS_DIR
  --out OUT
  --since-mtime SINCE_MTIME
                        epoch seconds; only transcripts modified at/after are
                        included
  --before-mtime BEFORE_MTIME
                        epoch seconds; only transcripts modified before this
                        time are included
  --braintrust
  --run-id RUN_ID
  --source SOURCE
  --session-name SESSION_NAME`;

const CC_OPTIONS = [
  "--help",
  "--projects-dir",
  "--out",
  "--since-mtime",
  "--before-mtime",
  "--braintrust",
  "--run-id",
  "--source",
  "--session-name",
] as const;

function resolveOption(name: string): (typeof CC_OPTIONS)[number] {
  const candidates = CC_OPTIONS.filter((option) => option === name || option.startsWith(name));
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? `unrecognized argument: ${name}`
        : `ambiguous option: ${name} could match ${candidates.join(", ")}`,
    );
  }
  return candidates[0] as (typeof CC_OPTIONS)[number];
}

function parseArguments(args: string[]): ParsedArguments | "help" {
  const parsed: ParsedArguments = {
    projectsDir: join(homedir(), ".claude", "projects"),
    sinceMtime: 0,
    braintrust: false,
    runId: null,
    source: process.env.TRACE_SOURCE ?? "claude-code",
    sessionName: process.env.TRACE_SESSION_NAME ?? null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h") return "help";
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`unrecognized argument: ${argument ?? ""}`);
    }
    const equalsIndex = argument.indexOf("=");
    const optionText = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const attachedValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    const option = resolveOption(optionText);
    if (option === "--help") return "help";
    if (option === "--braintrust") {
      if (attachedValue !== undefined) throw new Error("argument --braintrust: ignored explicit argument");
      parsed.braintrust = true;
      continue;
    }
    const value = attachedValue ?? args[index + 1];
    if (value === undefined) {
      throw new Error(`argument ${option}: expected one argument`);
    }
    if (option === "--projects-dir") parsed.projectsDir = value;
    else if (option === "--out") parsed.outPath = value;
    else if (option === "--since-mtime" || option === "--before-mtime") {
      const numeric = parsePythonFloat(value);
      if (numeric === undefined) throw new Error(`argument ${option}: invalid float value: '${value}'`);
      if (option === "--since-mtime") parsed.sinceMtime = numeric;
      else parsed.beforeMtime = numeric;
    } else if (option === "--run-id") parsed.runId = value;
    else if (option === "--source") parsed.source = value;
    else if (option === "--session-name") parsed.sessionName = value;
    if (attachedValue === undefined) index += 1;
  }
  return parsed;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args[0] === "--parse-only" && args[1] !== undefined) {
    const [turns, metadata] = await parseTranscript(args[1]);
    console.log(stringifyPythonJson({ session_meta: metadata, turns }, 2));
    return 0;
  }
  try {
    const parsed = parseArguments(args);
    if (parsed === "help") {
      console.log(CC_HELP);
      return 0;
    }
    if (parsed.outPath === undefined) throw new Error("the following arguments are required: --out");
    await reconstructClaudeTranscripts(parsed as ClaudeReconstructionOptions & { outPath: string });
    return 0;
  } catch (error) {
    console.error(`cc_transcript.ts: error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
